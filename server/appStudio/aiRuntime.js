/**
 * App Studio — server-side AI runtime.
 *
 * The single, thin place where App Studio's native AI features run their model
 * calls ACTS-AS-OWNER. Everything here resolves the app OWNER's model tier
 * (never the viewer's), calls the shared llmClient, grounds against the owner's
 * knowledge bases, extracts uploaded documents to text/vision, and logs real
 * token usage to the owner. It adds NO provider logic of its own — it composes
 * primitives that already exist:
 *
 *   - core/modelResolver         → owner tier map + per-tier options
 *   - core/llmClient             → chat / chatForcedTool (structured) / stream
 *   - core/attachmentExtractor   → PDF/Word/Excel/image → text or vision images
 *   - core/agentRuntime/knowledgeSearch (quickKBSearch) → RAG grounding
 *   - stores/usageStore          → owner-attributed usage/cost logging
 *
 * Callers (the ai_extract / ai_generate / kb_query executor steps and the chat
 * SSE endpoint) resolve the model ONCE via resolveOwnerModel() and pass it into
 * runStructured/runText/streamChat so extraction can key off the same model's
 * vision support and there is no double resolution.
 *
 * All model output is UNTRUSTED: structured results are coerced against the
 * declared schema and clamped; extracted document text is DATA, never
 * instructions (the system prompt says so).
 */

'use strict';

const llmClient = require('../core/llm/llmClient');
const usageStore = require('../stores/usageStore');
const { usageLogFields } = require('../core/providers/usageNormalizer');
const log = require('../telemetry/log');

// ── Caps (defence-in-depth; the attachment quota is the real byte backstop) ──
const MAX_KB_IDS = 10;
// Per-request document budget. MAX_DOCS was 8, which refused a real mailed
// order (an inkoopbestelbon + ten drawings); the real cost lever was never the
// count but the AGGREGATE budgets below, added when the count was raised.
const MAX_DOCS = 20;
const MAX_DOC_CHARS = 60000;   // per-document extracted text fed to the model
// Aggregate ceilings across ALL documents of one step. Chars ≈ 50k tokens of
// text. Bytes are RAW pdf bytes for native document blocks — base64 inflates
// by 4/3, so 16 MB becomes ~21 MB on the wire, safely under Anthropic's 32 MB
// request ceiling. Images are rasterised pages across every document.
const MAX_TOTAL_DOC_CHARS = 200000;
const MAX_TOTAL_DOC_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_DOC_IMAGES = 30;
const MAX_SYSTEM_CHARS = 24000;
const MAX_SCHEMA_FIELDS = 40;
// An ai_extract has no authorable prompt: these descriptions ARE the instruction.
const MAX_SCHEMA_FIELD_DESC = 500;
const MAX_EXTRACT_ROWS = 500;  // rows a single ai_extract may produce/insert

const SCHEMA_FIELD_TYPES = ['string', 'number', 'boolean', 'date', 'array', 'object'];

/**
 * Can this model be shown a picture?
 *
 * Resolved through the STORED provider type and its adapter — the same rule
 * modelSupportsNativeDocuments follows a few lines down, and for the same
 * reason: seeing is a property of the API, not of a model's name.
 *
 * A hand-copied regex used to live here. It drifted exactly the way a copy
 * does: it listed `claude-sonnet-4` and a bare `claude-5`, and the model this
 * product actually ships with — `claude-sonnet-5` — matched neither. Every
 * photo in every App Studio AI step was therefore reduced to its OCR text
 * without a word in any log.
 *
 * The name check survives only as a FALLBACK, for a model that is attached to
 * no configured provider (getProviderForModel throws) or that resolves to the
 * generic OpenAI-compatible adapter, which answers `false` to everything.
 * Unlike native documents this fails OPEN: guessing "cannot see" blinds the
 * model on a task that may be entirely visual, while guessing "can see" costs
 * at worst one rejected request.
 */
async function modelSupportsVision(modelId) {
    if (!modelId) return false;
    try {
        const { getProviderForModel } = require('../core/aiAgent');
        const { getAdapter, baseAdapter } = require('../core/providers');
        const cfg = await getProviderForModel(modelId);
        const adapter = getAdapter(cfg?.providerType, cfg?.url);
        if (adapter && adapter !== baseAdapter && typeof adapter.supportsVision === 'function') {
            return !!adapter.supportsVision(modelId);
        }
    } catch { /* not attached to a configured provider — fall back to the name */ }
    return visionByModelName(modelId);
}

/** Last-resort name check, mirroring the per-provider supportsVision regexes. */
function visionByModelName(modelId) {
    if (/claude|anthropic/i.test(modelId)) {
        const { describeClaudeModel } = require('../core/providers/claudeModels');
        return describeClaudeModel(modelId).vision;
    }
    if (/^(mistral|ministral|magistral|codestral|devstral|pixtral)-/i.test(modelId)) {
        const { describeMistralModel } = require('../core/providers/mistralModels');
        return describeMistralModel(modelId).vision;
    }
    return /gpt-4o|gpt-4\.1|gpt-4\.5|gpt-5|o4|gemini/i.test(modelId);
}

function usageEntry(app, modelId, usage, t0, source) {
    return {
        user_id: app.userId,
        organization_id: app.organizationId || null,
        agent_id: app.id,
        agent_name: `App: ${app.name || 'Untitled app'}`,
        agent_type: 'studio_app',
        model: modelId,
        // Tokens, cache read/write (with the 5m/1h split and cache_ttl), reasoning,
        // tier and tool counts: adapters return the normalised shape
        // (core/providers/usageNormalizer.js); a raw provider block is read too.
        ...usageLogFields(usage),
        duration_ms: Date.now() - t0,
        source,
        conversation_id: app.id,
    };
}

function logUsage(app, modelId, usage, t0, source) {
    // Never let billing bookkeeping break a step (matches studioAppsRun).
    try { usageStore.logUsage(usageEntry(app, modelId, usage, t0, source)).catch(() => {}); } catch { /* ignore */ }
}

/**
 * Resolve the OWNER's model for a tier. Returns the concrete model id, the
 * per-tier call options (maxTokens/temperature/reasoning), and whether that
 * model supports vision (so extraction can decide text-vs-image). A tier the
 * owner hasn't configured, or 'auto', falls back to a configured tier — never
 * silently to the global default. Throws { status:400 } when no model exists.
 */
async function resolveOwnerModel(app, tierName) {
    const { getUserTierMap, getTierConfig, canonicalTierName } = require('../core/llm/modelResolver');
    const userOrgId = app.organizationId || null;
    const userId = app.userId;
    const tiers = await getUserTierMap({ userOrgId, userId }) || {};

    // Tier maps are keyed by BARE names, but a definition may carry the
    // `tier:`-prefixed form or a legacy alias. Looking those up raw always
    // missed and fell through to the fallback below — silently, so an app asking
    // for the smart model got the standard one and nothing said otherwise.
    let resolved = canonicalTierName(tierName) || 'auto';
    const asked = resolved;
    // 'auto' is a UI sentinel (classify), not a real tier; keep v1 deterministic
    // and free of an extra classifier call by preferring a configured tier.
    if (resolved === 'auto' || !tiers[resolved]?.modelId) {
        resolved = tiers.standard?.modelId ? 'standard'
            : tiers.fast?.modelId ? 'fast'
                : (Object.keys(tiers).find((k) => tiers[k]?.modelId) || 'fast');
        // Say it out loud. An app asking for a named tier that has no model
        // configured used to land on whatever was left, silently — which is how
        // a step written for a reasoning model ended up being answered by a
        // 0.6B local one, for weeks, with nobody able to tell from the outcome.
        if (asked !== 'auto' && asked !== resolved) {
            log.warn(`[StudioAppAI] app ${app.id} asked for tier "${asked}" — not configured; using "${resolved}" (${tiers[resolved]?.modelId || 'workspace default'})`);
        }
    }

    let modelId = tiers[resolved]?.modelId || null;
    if (!modelId) {
        const globalConfig = await require('../core/aiAgent').getAIConfig().catch(() => null);
        modelId = globalConfig?.model || null;
    }
    if (!modelId) {
        const e = new Error('No AI model is configured for this workspace');
        e.status = 400;
        throw e;
    }

    const cfg = await getTierConfig(resolved, { userOrgId, userId }) || {};
    return {
        modelId,
        tierName: resolved,
        supportsVision: await modelSupportsVision(modelId),
        supportsNativeDocuments: await modelSupportsNativeDocuments(modelId),
        options: {
            maxTokens: cfg.maxTokens,
            temperature: cfg.temperature,
            reasoningEffort: cfg.reasoningEffort,
            reasoningSummary: cfg.reasoningSummary,
            verbosity: cfg.verbosity,
        },
    };
}

/**
 * Can this model take a native {type:'document'} PDF block?
 *
 * Resolved through the STORED provider type (never a URL guess — the same rule
 * modelCosts follows), because the answer is a property of the API, not the
 * model name: a claude-named model served from an OpenAI-compatible runtime
 * answers an unknown block type with a 400 that fails the whole step.
 * Fail-closed: any resolution error means "no".
 */
async function modelSupportsNativeDocuments(modelId) {
    if (!modelId) return false;
    try {
        const { getProviderForModel } = require('../core/aiAgent');
        const { getAdapter } = require('../core/providers');
        const { NATIVE_PDF_PROVIDER_TYPES } = require('../core/documents/nativePdf');
        const cfg = await getProviderForModel(modelId);
        if (!NATIVE_PDF_PROVIDER_TYPES.has(String(cfg?.providerType || '').toLowerCase())) return false;
        const adapter = getAdapter(cfg?.providerType, cfg?.url);
        return !!(adapter && typeof adapter.supportsDocuments === 'function' && adapter.supportsDocuments(modelId));
    } catch {
        return false;
    }
}

// ── Schema helpers ──────────────────────────────────────────────────────────

/** One declared output field → JSON Schema property. */
function fieldToJsonSchema(field) {
    const desc = (typeof field.description === 'string' && field.description.trim())
        ? field.description.trim().slice(0, MAX_SCHEMA_FIELD_DESC) : undefined;
    switch (field.type) {
        case 'number': return { type: 'number', ...(desc ? { description: desc } : {}) };
        case 'boolean': return { type: 'boolean', ...(desc ? { description: desc } : {}) };
        case 'date': return { type: 'string', description: [desc, 'ISO 8601 date (YYYY-MM-DD)'].filter(Boolean).join(' — ') };
        case 'array': return { type: 'array', items: {}, ...(desc ? { description: desc } : {}) };
        case 'object': return { type: 'object', ...(desc ? { description: desc } : {}) };
        case 'string':
        default: return { type: 'string', ...(desc ? { description: desc } : {}) };
    }
}

/** A list of { name, type, description, required? } fields → object JSON Schema. */
function fieldsToObjectSchema(fields) {
    const list = normalizeSchemaFields(fields);
    const properties = {};
    const required = [];
    for (const f of list) {
        properties[f.name] = fieldToJsonSchema(f);
        if (f.required) required.push(f.name);
    }
    return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

/**
 * Sanitize a declared schema-field list (used by the executor + inspector).
 *
 * The caps are silent by nature and both have bitten. `ai_extract` has NO
 * authorable prompt — the field DESCRIPTIONS are the entire instruction — so a
 * description trimmed at 500 characters is an instruction cut off mid-sentence,
 * and the part that gets lost is always the end, which is where the exceptions
 * live. A 1238-character rule once lost its whole "…and if that is empty, read
 * it from the drawing instead" clause this way, and the column it governed came
 * back empty on every row of every order.
 *
 * Trimming is still right — a schema is not a place for an essay — but doing it
 * without a word is not. Same for dropping fields past the 40-field cap.
 */
function normalizeSchemaFields(fields) {
    if (!Array.isArray(fields)) return [];
    const seen = new Set();
    const out = [];
    for (const raw of fields) {
        if (!raw || typeof raw !== 'object') continue;
        const name = typeof raw.name === 'string' ? raw.name.trim() : '';
        if (!/^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(name) || seen.has(name)) continue;
        seen.add(name);
        const rawDesc = typeof raw.description === 'string' ? raw.description : '';
        if (rawDesc.length > MAX_SCHEMA_FIELD_DESC) {
            log.warn(`[StudioAppAI] schema field "${name}": description cut from ${rawDesc.length} to ${MAX_SCHEMA_FIELD_DESC} characters — the instruction is incomplete. Shorten it in the step.`);
        }
        out.push({
            name,
            type: SCHEMA_FIELD_TYPES.includes(raw.type) ? raw.type : 'string',
            description: rawDesc.slice(0, MAX_SCHEMA_FIELD_DESC),
            required: !!raw.required,
        });
        if (out.length >= MAX_SCHEMA_FIELDS) {
            if (fields.length > MAX_SCHEMA_FIELDS) {
                log.warn(`[StudioAppAI] schema has ${fields.length} fields — only the first ${MAX_SCHEMA_FIELDS} are asked for.`);
            }
            break;
        }
    }
    return out;
}

/**
 * Parse number-ish text whose separators are LOCALE-AMBIGUOUS: "1.234,56" is
 * EU, "1,234.56" is US, and stripping either blindly multiplies the amount by
 * 100-1000x. The decimal separator is decided from the string's shape — with
 * both present the LAST one is decimal; a lone separator is a thousands
 * separator when exactly three digits follow it ("1.234" → 1234) or when it
 * repeats, and the decimal separator otherwise ("1,5" → 1.5).
 */
function parseNumberish(value) {
    const raw = String(value).trim();
    if (!raw) return NaN;
    // Exponent notation carries no separator ambiguity.
    if (/^[+-]?\d+(?:\.\d+)?[eE][+-]?\d+$/.test(raw)) return parseFloat(raw);

    const sign = raw.startsWith('-') ? '-' : '';
    const digits = raw.replace(/[^0-9.,]/g, '');
    if (!digits) return NaN;

    const lastDot = digits.lastIndexOf('.');
    const lastComma = digits.lastIndexOf(',');
    let decimalSep = null;
    if (lastDot >= 0 && lastComma >= 0) {
        decimalSep = lastDot > lastComma ? '.' : ',';
    } else if (lastDot >= 0 || lastComma >= 0) {
        const sep = lastDot >= 0 ? '.' : ',';
        const trailing = digits.length - Math.max(lastDot, lastComma) - 1;
        const repeats = digits.split(sep).length > 2;
        if (trailing !== 3 && !repeats) decimalSep = sep;
    }

    const normalized = decimalSep === null
        ? digits.replace(/[.,]/g, '')
        : digits.split(decimalSep === '.' ? ',' : '.').join('').replace(decimalSep, '.');
    return parseFloat(sign + normalized);
}

/** Lenient coercion of one untrusted model value to a declared field type. */
function coerceValue(type, value) {
    if (value === undefined || value === null) return null;
    switch (type) {
        case 'number': {
            const n = typeof value === 'number' ? value : parseNumberish(value);
            return Number.isFinite(n) ? n : null;
        }
        case 'boolean':
            if (typeof value === 'boolean') return value;
            return /^(true|yes|1)$/i.test(String(value).trim()) ? true : /^(false|no|0)$/i.test(String(value).trim()) ? false : null;
        case 'array':
            return Array.isArray(value) ? value : (value === '' ? [] : [value]);
        case 'object':
            return (value && typeof value === 'object' && !Array.isArray(value)) ? value : null;
        case 'date':
        case 'string':
        default:
            return typeof value === 'string' ? value : (typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
}

/** Coerce an untrusted object against declared fields, dropping unknown keys. */
function coerceRowToFields(row, fields) {
    const out = {};
    if (!row || typeof row !== 'object') return out;
    for (const f of fields) out[f.name] = coerceValue(f.type, row[f.name]);
    return out;
}

// ── Message building ─────────────────────────────────────────────────────────

function buildMessages(system, user) {
    const messages = [];
    if (system && String(system).trim()) {
        messages.push({ role: 'system', content: String(system).slice(0, MAX_SYSTEM_CHARS) });
    }
    messages.push({ role: 'user', content: user });
    return messages;
}

// ── Model calls (model pre-resolved via resolveOwnerModel) ───────────────────

/**
 * A hard ceiling on one App Studio model call.
 *
 * `ai_extract` can now be pointed at 8 documents of 60k characters, inside a
 * loop, in two clicks. Without this nothing can end that request: it holds an
 * Express handler, a DB connection and the viewer's spinner for as long as the
 * provider feels like taking.
 *
 * This is real cancellation, not a race that abandons a promise — the provider
 * adapters turn `timeoutMs` into an AbortController on the underlying fetch.
 * Caveat worth knowing: only the OpenAI-compatible base adapter and Mistral
 * honour it today; on an adapter that ignores it the call still runs long, so
 * the client-side deadline below is the backstop rather than decoration.
 */
const STUDIO_APP_AI_TIMEOUT_MS = parseInt(process.env.STUDIO_APP_AI_TIMEOUT_MS, 10) || 120_000;

function withTimeout(options) {
    return { ...(options || {}), timeoutMs: STUDIO_APP_AI_TIMEOUT_MS };
}

/**
 * Forced structured output. `parameters` is a JSON Schema (build it with
 * fieldsToObjectSchema). Returns the parsed object; throws { status:422 } when
 * the model declined or emitted unparseable arguments. `structured` is
 * UNTRUSTED — callers coerce it against their declared shape.
 */
async function runStructured(app, model, { system, user, parameters, toolName = 'record_output', toolDescription = 'Return the requested structured data.' }) {
    const toolDef = { type: 'function', function: { name: toolName, description: toolDescription, parameters } };
    const t0 = Date.now();
    const res = await llmClient.chatForcedTool(model.modelId, buildMessages(system, user), toolDef, withTimeout(model.options));
    logUsage(app, model.modelId, res?.usage, t0, 'studio_app_ai');
    if (!res || res.structured == null || typeof res.structured !== 'object') {
        const e = new Error('The AI did not return usable structured data. Try a more capable model tier or a simpler schema.');
        e.status = 422;
        throw e;
    }
    return { structured: res.structured, usage: res.usage };
}

/** Free-form text generation. */
async function runText(app, model, { system, user }) {
    const t0 = Date.now();
    const res = await llmClient.chat(model.modelId, buildMessages(system, user), withTimeout(model.options));
    logUsage(app, model.modelId, res?.usage, t0, 'studio_app_ai');
    return { text: typeof res?.content === 'string' ? res.content : '', usage: res?.usage };
}

// ── Bounded tool loops ────────────────────────────────────────────────────────
//
// App Studio AI stays deliberately non-agentic — EXCEPT for tools the caller
// closes over itself. There is no dispatcher, no catalog, no identity question:
// `tools` is [{ def, execute }] where `execute` is already bound to whatever
// the step pre-authorized (e.g. query_genome_dataset over the owner-scoped
// manifests it resolved). The model can only ever call what the step handed it.
// Rounds are capped low: the loop exists so a model can pull a few dataset
// slices before answering, not to browse.

const MAX_TOOL_ROUNDS = 4;
const MAX_TOOL_RESULT_CHARS = 8_000;

function toolTables(tools) {
    const defs = tools.map((t) => t.def);
    const byName = new Map(tools.map((t) => [t.def?.function?.name, t.execute]));
    const executeTool = async (name, args) => {
        const fn = byName.get(name);
        if (!fn) return `Error: unknown tool ${name}`;
        try {
            const out = await fn(args || {});
            const s = typeof out === 'string' ? out : JSON.stringify(out);
            return s.length > MAX_TOOL_RESULT_CHARS ? `${s.slice(0, MAX_TOOL_RESULT_CHARS)}…[truncated]` : s;
        } catch (e) {
            return `Error: ${e?.message || 'tool failed'}`;
        }
    };
    return { defs, executeTool };
}

/** runText + closed-over tools. Falls back to runText when tools is empty. */
async function runTextWithTools(app, model, { system, user, tools }) {
    if (!Array.isArray(tools) || tools.length === 0) return runText(app, model, { system, user });
    const { defs, executeTool } = toolTables(tools);
    const t0 = Date.now();
    const res = await llmClient.runToolLoop(
        model.modelId, buildMessages(system, user), defs, withTimeout(model.options), executeTool, MAX_TOOL_ROUNDS,
    );
    logUsage(app, model.modelId, res?.usage, t0, 'studio_app_ai');
    return { text: typeof res?.content === 'string' ? res.content : '', usage: res?.usage, toolCallRounds: res?.toolCallRounds || 0 };
}

/**
 * runStructured + closed-over tools: the model may pull slices first; the
 * synthesis call is FORCED onto the structured tool (llmClient.runToolLoop's
 * finalTool path — same provider-aware forcing chatForcedTool uses).
 */
async function runStructuredWithTools(app, model, { system, user, parameters, tools, toolName = 'record_output', toolDescription = 'Return the requested structured data.' }) {
    if (!Array.isArray(tools) || tools.length === 0) return runStructured(app, model, { system, user, parameters, toolName, toolDescription });
    const finalTool = { type: 'function', function: { name: toolName, description: toolDescription, parameters } };
    const { defs, executeTool } = toolTables(tools);
    const t0 = Date.now();
    const res = await llmClient.runToolLoop(
        model.modelId, buildMessages(system, user), defs,
        { ...withTimeout(model.options), finalTool }, executeTool, MAX_TOOL_ROUNDS,
    );
    logUsage(app, model.modelId, res?.usage, t0, 'studio_app_ai');
    if (!res || res.structured == null || typeof res.structured !== 'object') {
        const e = new Error('The AI did not return usable structured data. Try a more capable model tier or a simpler schema.');
        e.status = 422;
        throw e;
    }
    return { structured: res.structured, usage: res.usage, toolCallRounds: res.toolCallRounds || 0 };
}

/**
 * Streaming chat. `messages` is the conversation array; `system` is prepended.
 * `onEvent(type, data)` forwards the normalized llmClient stream events. Usage
 * is logged when the final usage arrives.
 */
async function streamChat(app, model, { system, messages }, onEvent) {
    const full = [];
    if (system && String(system).trim()) full.push({ role: 'system', content: String(system).slice(0, MAX_SYSTEM_CHARS) });
    for (const m of (Array.isArray(messages) ? messages : [])) full.push(m);
    const t0 = Date.now();
    let lastUsage = null;
    await llmClient.stream(model.modelId, full, model.options || {}, (type, data) => {
        // Adapters put the (normalised) usage FLAT on the 'done' payload; a
        // nested `usage` is read too. Reading only `data.usage` logged every
        // streamed app chat with zero tokens.
        if (type === 'done' && data) lastUsage = data.usage || data;
        onEvent(type, data);
    });
    logUsage(app, model.modelId, lastUsage, t0, 'studio_app_chat');
}

// ── Knowledge-base grounding (RAG) ───────────────────────────────────────────

/**
 * Ground an AI step against knowledge bases, and return a context block for
 * the system prompt.
 *
 * ── THE VIEWER DECIDES, NOT THE OWNER ───────────────────────────────
 * This used to search as `app.userId` and reason that a viewer therefore
 * "can never reach a KB the owner can't". True, and the wrong bound: it means
 * a viewer reaches every base the owner CAN, including the owner's personal
 * drafts and bases shared with a group the viewer is not in. An app published
 * to the whole organisation would answer out of its author's private
 * material.
 *
 * So the ids are filtered against the VIEWER first, and only what survives is
 * searched. The search still runs as the owner — that is what makes the
 * documents readable at all — but the LIST is the viewer's.
 *
 * A viewer with no id is the public role: it gets nothing. An app open to the
 * internet grounding on somebody's private notes is the case this exists to
 * prevent, and "no identity" cannot be resolved into a permission.
 */
async function groundWithKB(app, { knowledgeBaseIds, query, topK = 6, viewer = null } = {}) {
    const requested = Array.isArray(knowledgeBaseIds)
        ? knowledgeBaseIds.filter((x) => typeof x === 'string' && x).slice(0, MAX_KB_IDS)
        : [];
    const q = (typeof query === 'string' ? query : '').trim();
    if (!requested.length || !q) return { context: '', chunks: [] };

    const viewerId = viewer?.id || null;
    let kbIds = [];
    if (viewerId) {
        const { filterKbIdsForUser } = require('../core/kb/kbVisibility');
        const { askerContext } = require('../core/kb/askerContext');
        kbIds = await filterKbIdsForUser(requested, {
            userId: viewerId, ...(await askerContext(viewerId)),
            context: 'app_ai_block', agentId: app?.id || null,
        });
    } else {
        log.warn('[AppAI] grounding skipped: no viewer identity', JSON.stringify({ appId: app?.id || null, requested: requested.length }));
    }
    if (!kbIds.length) return { context: '', chunks: [] };

    const { quickKBSearch } = require('../core/agentRuntime/knowledgeSearch');
    const chunks = await quickKBSearch(app.userId, kbIds, q, { topK }).catch(() => []);
    if (!chunks || !chunks.length) return { context: '', chunks: [] };

    const context = chunks
        .map((c, i) => `[[${i + 1}]] ${c.title || 'KB'}\n${c.content || ''}`)
        .join('\n\n');
    return { context, chunks };
}

// ── Document extraction (owner attachment ledger → text/vision blocks) ────────

function streamToBuffer(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
    });
}

/**
 * Load one owner attachment (owner-scoped; must be scanned & not quarantined —
 * the same guard app_trigger file inputs use) and return the extractor's
 * { name, type, content(base64) } shape.
 *
 * `viewer` is not optional in spirit. An ai_extract `source` resolves from
 * CLIENT-supplied formValues / vars / item, so without a per-viewer read check
 * any signed-in user could name any fileId in the app and have the model read
 * it out — and with writeTo, copy it into a table they can read. Owner-scope
 * plus a scan flag was enough while the only way in was uploading to your own
 * form; it stopped being enough the moment a mailbox started filling a file
 * column with other people's documents.
 */
async function loadAttachment(app, descriptor, { viewer = null, model = null } = {}) {
    const studioAppDataStore = require('../stores/studioAppDataStore');
    const fileId = descriptor && (descriptor.fileId ?? descriptor.id);
    const att = await studioAppDataStore.getAttachment(fileId, app.id, app.userId);
    if (!att) { const e = new Error('references a file that was not uploaded to this app'); e.status = 400; throw e; }
    if (!att.scanned || att.quarantined) { const e = new Error('references a file that has not passed the malware scan'); e.status = 400; throw e; }

    if (viewer && viewer.id && viewer.id !== app.userId) {
        const { viewerMayReadAttachment } = require('./attachmentAccess');
        const allowed = await viewerMayReadAttachment(app, att, { ...viewer, model });
        if (!allowed) { const e = new Error('references a file you do not have access to'); e.status = 403; throw e; }
    }

    const storageStore = require('../stores/storageStore');
    const key = storageStore.buildStudioAppAttachmentKey(app.userId, app.id, att.sha256);
    const { stream } = await storageStore.streamFile(key);
    const buf = await streamToBuffer(stream);
    const name = (typeof descriptor.name === 'string' && descriptor.name.trim())
        ? descriptor.name.trim().slice(0, 200) : `attachment_${att.sha256.slice(0, 8)}`;
    return { name, type: att.mimeType, content: buf.toString('base64') };
}

function isPdfAttachment(att) {
    return (att.type && String(att.type).toLowerCase().includes('pdf')) || /\.pdf$/i.test(att.name || '');
}

/**
 * Turn studio_attachment descriptors into OpenAI-style content blocks for the
 * user message: extracted text blocks, image blocks when the model supports
 * vision and rendering was chosen (or forced by documentMode:'images'), and —
 * when the provider takes them — native {type:'document'} PDF blocks so the
 * model sees the rendered page AND its text layer. The blocks travel together
 * with the extracted text on purpose: a CID-font PDF defeats the API's own
 * parser too, and the extracted text is the guaranteed-readable channel
 * (directChat learned this first; same rule here).
 *
 * Aggregate budgets are enforced ACROSS the batch. When one runs out, the
 * remaining documents are represented by ONE explicit note block — the model
 * must know its evidence is incomplete, and so must the operator reading the
 * answer. Never a silent drop.
 *
 * `textWasRedacted`: App Studio has no inbound DLP today, so nothing sets it —
 * but the moment inbound tokenisation lands, the raw-PDF block must drop
 * whenever the extracted text was redacted (directChat's `_wasTokenised`
 * rule), or the block would hand the model the unredacted original. The guard
 * exists now so it cannot be forgotten then.
 */
async function extractDocuments(app, descriptors, {
    modelSupportsVision: vision = false,
    nativeDocuments = false,
    documentMode = 'auto',
    textWasRedacted = false,
    viewer = null,
    model = null,
} = {}) {
    const { extractAttachment, formatTextHeader, formatImagesHeader, formatFailureNote } = require('../core/documents/attachmentExtractor');
    const all = (Array.isArray(descriptors) ? descriptors : []).filter(Boolean);
    const list = all.slice(0, MAX_DOCS);
    const mode = ['auto', 'text', 'images'].includes(documentMode) ? documentMode : 'auto';

    // `images` is not a preference, it is a requirement: an author writes it
    // because the answer is IN the picture — a title block, a dimension, a tap
    // callout on a technical drawing. Handing that job to a model that cannot
    // see used to degrade in silence to the PDF's text layer, and the model
    // then answered confidently about a plate someone was going to cut.
    // Failing loudly is the only honest option; `auto` still degrades, because
    // `auto` is the author saying they do not mind.
    if (mode === 'images' && !vision) {
        const e = new Error('This step needs to LOOK at the pages, but the configured model cannot read images. Point the step at a tier whose model supports vision, or set documentMode to "auto".');
        e.status = 400;
        e.code = 'vision_required';
        throw e;
    }

    const blocks = [];
    let totalChars = 0;
    let totalBytes = 0;
    let totalImages = 0;
    const skipped = [];

    for (const descriptor of list) {
        // Budget check BEFORE the load: once chars or images are exhausted no
        // further document can contribute anything but its name.
        if (totalChars >= MAX_TOTAL_DOC_CHARS || totalImages >= MAX_TOTAL_DOC_IMAGES) {
            skipped.push(typeof descriptor.name === 'string' ? descriptor.name : 'document');
            continue;
        }
        const att = await loadAttachment(app, descriptor, { viewer, model });
        const result = await extractAttachment(att, { modelSupportsVision: vision, documentMode: mode });

        if (result.kind === 'text') {
            const text = (result.text || '').slice(0, Math.min(MAX_DOC_CHARS, MAX_TOTAL_DOC_CHARS - totalChars));
            totalChars += text.length;
            blocks.push({ type: 'text', text: `${formatTextHeader(att, result)}\n${text}` });
            // The native PDF block rides ALONGSIDE the text, never instead of
            // it — and only within the raw-byte budget, and never when the
            // text channel was redacted.
            if (nativeDocuments && !textWasRedacted && mode !== 'text' && isPdfAttachment(att)) {
                const raw = Buffer.byteLength(att.content, 'base64');
                if (totalBytes + raw <= MAX_TOTAL_DOC_BYTES) {
                    totalBytes += raw;
                    blocks.push({
                        type: 'document',
                        source: { type: 'base64', media_type: 'application/pdf', data: att.content },
                    });
                }
            }
        } else if (result.kind === 'images' && Array.isArray(result.images)) {
            blocks.push({ type: 'text', text: formatImagesHeader(att, result) });
            // Forced rendering can also carry the title-block text — inline it
            // when present, it is the cheapest half of the drawing.
            if (typeof result.text === 'string' && result.text) {
                const text = result.text.slice(0, Math.min(MAX_DOC_CHARS, Math.max(0, MAX_TOTAL_DOC_CHARS - totalChars)));
                totalChars += text.length;
                if (text) blocks.push({ type: 'text', text });
            }
            for (const img of result.images) {
                if (totalImages >= MAX_TOTAL_DOC_IMAGES) break;
                totalImages += 1;
                blocks.push({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.base64}` } });
            }
        } else {
            blocks.push({ type: 'text', text: formatFailureNote(att, result) });
        }
    }

    for (const descriptor of all.slice(MAX_DOCS)) {
        skipped.push(typeof descriptor.name === 'string' ? descriptor.name : 'document');
    }
    if (skipped.length) {
        blocks.push({
            type: 'text',
            text: `[${skipped.length} of ${all.length} documents were not included — the request would have been too large: ${skipped.slice(0, 10).join(', ')}${skipped.length > 10 ? ', …' : ''}. Re-run with fewer files, or split the request.]`,
        });
    }
    return blocks;
}

module.exports = {
    resolveOwnerModel,
    runStructured,
    runText,
    runTextWithTools,
    runStructuredWithTools,
    streamChat,
    groundWithKB,
    extractDocuments,
    // The guarded read of one app file (owner ledger, scan flag, viewer access).
    loadAttachment,
    // schema + coercion helpers (shared with the executor)
    fieldsToObjectSchema,
    normalizeSchemaFields,
    coerceValue,
    coerceRowToFields,
    modelSupportsVision,
    modelSupportsNativeDocuments,
    // caps (exported for the executor + tests)
    SCHEMA_FIELD_TYPES,
    MAX_KB_IDS,
    MAX_DOCS,
    MAX_DOC_CHARS,
    MAX_TOTAL_DOC_CHARS,
    MAX_TOTAL_DOC_BYTES,
    MAX_TOTAL_DOC_IMAGES,
    MAX_SCHEMA_FIELDS,
    MAX_EXTRACT_ROWS,
    STUDIO_APP_AI_TIMEOUT_MS,
    // test-only internals
    _loadAttachment: loadAttachment,
    _usageEntry: usageEntry,
};
