/**
 * Turn a spoken-language brief into a cowork spec.
 *
 * The Work composer is one box: the user types "elke ochtend een goede morgen,
 * en zorg dat ik positief begin" and expects Bee Flow to work out that this is
 * a daily 08:00 job and to write a proper instruction for the runner. This
 * module does that — one LLM call, then a normaliser that refuses to trust any
 * of it blindly.
 *
 * The normaliser is the important half and is pure, so it can be tested
 * without a model. Nothing the model returns reaches the database unchecked:
 *
 *   - repeatInterval / daysOfWeek / timeOfDay are whitelisted, not parsed.
 *   - title and prompt fall back to the user's own words rather than to
 *     something invented.
 *   - agentId is only honoured when the brief genuinely points at that agent.
 *     A model that "helpfully" assigns the user's Invoice agent to a
 *     good-morning greeting would silently run every future greeting through
 *     that agent's prompt, skills and connected apps — so the agent must be
 *     named in the brief, or the model must quote the words that chose it and
 *     that quote must actually appear in the brief.
 */

'use strict';

const { parseJsonObject } = require('../meetingNotes/llmJson');
const log = require('../../telemetry/log');

const VALID_REPEAT_INTERVALS = new Set([
    'hourly', 'daily', 'weekdays', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly',
]);
const VALID_DOW_TOKENS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const MAX_TITLE = 60;
const MAX_PROMPT = 4000;

// ── Prompt ──────────────────────────────────────────────

function buildComposePrompt({ agents = [], timezone = 'Europe/Amsterdam', nowLabel }) {
    const agentBlock = agents.length > 0
        ? agents.map(a => `- id: ${a.id} | name: ${a.name}${a.description ? ` | ${a.description}` : ''}`).join('\n')
        : '(this user has no agents)';

    return `You turn a short brief into a scheduled job for Bee Flow ("cowork").
The user typed the brief in a chat box. Return ONLY a JSON object, no prose, no code fence.

Fields:
- "title": a short label, max ${MAX_TITLE} characters, in the SAME language as the brief. No quotes, no trailing period.
- "prompt": the instruction the runner will execute, in the SAME language as the brief. Rewrite the brief as a direct, self-contained instruction to an assistant that will run UNATTENDED at the scheduled moment. Keep every concrete requirement the user stated. Do not invent extra tasks. Do not mention scheduling inside the prompt — the schedule is a separate field. Do not address the user by name.
- "repeatInterval": one of "hourly", "daily", "weekdays", "weekly", "biweekly", "monthly", "quarterly", "yearly", or null when the brief describes a one-off.
- "daysOfWeek": array of "sun","mon","tue","wed","thu","fri","sat" when the user named specific days; otherwise null.
- "timeOfDay": "HH:MM" (24h) when a time is stated or clearly implied; otherwise null.
    Vague parts of day map to: morning/ochtend = "08:00", midday/middag = "12:00", afternoon = "14:00", evening/avond = "18:00", night/nacht = "21:00".
- "runOnce": true when this should run a single time, false when it repeats.
- "agentId": the id of the agent that should run this, ONLY when the brief clearly asks for a specific agent. Otherwise null.
- "agentQuote": when you set agentId, the exact words from the brief that named the agent, copied verbatim. Otherwise null.

Rules for agentId — read carefully:
- Default to null. Most briefs do NOT name an agent.
- Set it ONLY when the user explicitly refers to one of the agents below, by its name or by an unmistakable description of it.
- A brief that merely relates to an agent's topic is NOT enough. "Summarise my invoices" does NOT select an Invoice agent.
- If you set agentId, agentQuote MUST be words copied from the brief. Never paraphrase.

Agents available to this user:
${agentBlock}

The user's timezone is ${timezone}. Current local time: ${nowLabel}.

Examples:
Brief: "elke ochtend een goede morgen wensen en zorgen dat ik positief begin"
{"title":"Goedemorgen-bericht","prompt":"Schrijf een kort, warm goedemorgenbericht ... ","repeatInterval":"daily","daysOfWeek":null,"timeOfDay":"08:00","runOnce":false,"agentId":null,"agentQuote":null}

Brief: "laat de Bugs & Feedback Agent elke maandag om 9 uur de openstaande bugs samenvatten"
{"title":"Wekelijkse bugsamenvatting","prompt":"Vat de openstaande bugs samen ...","repeatInterval":"weekly","daysOfWeek":["mon"],"timeOfDay":"09:00","runOnce":false,"agentId":"<that agent's id>","agentQuote":"Bugs & Feedback Agent"}

Brief: "vat morgen de notulen van de laatste vergadering samen"
{"title":"Notulen samenvatten","prompt":"Vat de notulen van de laatste vergadering samen ...","repeatInterval":null,"daysOfWeek":null,"timeOfDay":null,"runOnce":true,"agentId":null,"agentQuote":null}`;
}

// ── Normalising ─────────────────────────────────────────

function normaliseWhitespace(s) {
    return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function cleanText(value, max) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim().replace(/^["'`]+|["'`]+$/g, '').trim();
    if (!trimmed) return null;
    return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
}

/** First sentence / clause of the brief, as a last-resort title. */
function titleFromBrief(brief) {
    const flat = String(brief || '').replace(/\s+/g, ' ').trim();
    if (!flat) return 'Cowork';
    const cut = flat.split(/[.!?\n]/)[0].trim() || flat;
    return cut.length > MAX_TITLE ? `${cut.slice(0, MAX_TITLE - 1).trimEnd()}…` : cut;
}

/**
 * Decide whether the model's agent pick reflects a real instruction.
 *
 * Two independent ways to qualify, because either one on its own is solid
 * evidence and requiring both would reject legitimate picks:
 *   1. the agent's own name occurs in the brief, or
 *   2. the model quoted words that genuinely occur in the brief.
 * Anything else — including a confident-sounding model with no textual
 * support — is dropped.
 */
function resolveAgent(raw, { brief, agents }) {
    const wanted = typeof raw?.agentId === 'string' ? raw.agentId.trim() : '';
    if (!wanted) return { agentId: null, agentReason: null };

    const agent = agents.find(a => a.id === wanted);
    if (!agent) return { agentId: null, agentReason: null };

    const haystack = normaliseWhitespace(brief);
    const name = normaliseWhitespace(agent.name);
    if (name && haystack.includes(name)) {
        return { agentId: agent.id, agentReason: `You named ${agent.name}.` };
    }

    const quote = typeof raw.agentQuote === 'string' ? normaliseWhitespace(raw.agentQuote) : '';
    if (quote && quote.length >= 3 && haystack.includes(quote)) {
        return { agentId: agent.id, agentReason: `Matched “${raw.agentQuote.trim()}”.` };
    }

    // Model wanted an agent but nothing in the brief supports it.
    return { agentId: null, agentReason: null };
}

function normaliseDays(value) {
    if (!Array.isArray(value)) return null;
    const tokens = value
        .map(v => String(v).toLowerCase().slice(0, 3))
        .filter(v => VALID_DOW_TOKENS.includes(v));
    if (tokens.length === 0) return null;
    const unique = Array.from(new Set(tokens));
    // Keep calendar order so the UI and the runner read the same way.
    return VALID_DOW_TOKENS.filter(d => unique.includes(d));
}

/**
 * Coerce one model reply into a spec that is safe to persist.
 * Pure — no model, no DB. `raw` may be null (model failed entirely).
 */
function normaliseSpec(raw, { brief, agents = [] } = {}) {
    const obj = raw && typeof raw === 'object' ? raw : {};

    const repeatInterval = typeof obj.repeatInterval === 'string'
        && VALID_REPEAT_INTERVALS.has(obj.repeatInterval)
        ? obj.repeatInterval
        : null;

    const daysOfWeek = normaliseDays(obj.daysOfWeek);
    const timeOfDay = typeof obj.timeOfDay === 'string' && TIME_RE.test(obj.timeOfDay.trim())
        ? obj.timeOfDay.trim()
        : null;

    // runOnce is advisory; the absence of a repeat is what actually decides it,
    // so a model that says runOnce:false while giving no interval still gets a
    // one-off rather than a schedule that never repeats but claims it does.
    const runOnce = !repeatInterval && !daysOfWeek;

    const { agentId, agentReason } = resolveAgent(obj, { brief, agents });

    return {
        title: cleanText(obj.title, MAX_TITLE) || titleFromBrief(brief),
        prompt: cleanText(obj.prompt, MAX_PROMPT) || String(brief || '').trim(),
        repeatInterval,
        daysOfWeek,
        timeOfDay,
        runOnce,
        agentId,
        agentReason,
    };
}

/** The spec used when the model is unavailable — the user's own words, run once. */
function fallbackSpec(brief) {
    return normaliseSpec(null, { brief, agents: [] });
}

// ── The model call ──────────────────────────────────────

async function composeCowork({ brief, agents = [], timezone = 'Europe/Amsterdam', tier = 'fast', userId = null, userOrgId = null }) {
    const text = String(brief || '').trim();
    if (!text) return { ...fallbackSpec(''), composed: false };

    let nowLabel;
    try {
        nowLabel = new Date().toLocaleString('en-US', {
            timeZone: timezone,
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
            hour: '2-digit', minute: '2-digit', hour12: false,
        });
    } catch (_) {
        nowLabel = new Date().toISOString();
    }

    try {
        const { resolveModelForTier, TIER_DEFAULTS } = require('../llm/modelResolver');
        const { getProviderForModel } = require('../aiAgent');
        const { getAdapter } = require('../providers/index');

        // Same rule as the runner: the composer writes the brief FROM the
        // user's own words, so it resolves its model under that user's org —
        // EU overrides and org custom tiers included.
        const modelId = await resolveModelForTier(`tier:${tier}`, { userOrgId, userId });
        if (!modelId) throw new Error(`no model for tier ${tier}`);
        const config = await getProviderForModel(modelId);
        const adapter = getAdapter(config.providerType, config.url);
        if (!adapter || typeof adapter.chat !== 'function') throw new Error('adapter has no chat()');

        const defaults = TIER_DEFAULTS[tier] || TIER_DEFAULTS.fast || {};

        const messages = [
            { role: 'system', content: buildComposePrompt({ agents, timezone, nowLabel }) },
            { role: 'user', content: text },
        ];

        // Privacy shield on the composer's input (CW-10): behind the per-org
        // opt-in flag, the brief runs through the same PII passage as the
        // agent runtime. A masking action rewrites the user message in-place;
        // a block or a fail-closed guard outage throws into the catch below —
        // meaning: no model call, the user gets their own words back as a
        // one-off (fallbackSpec, data going to its own author), and the
        // resulting run is shielded again by the runner when it executes.
        // Flag off or no org: byte-identical behaviour, nothing extra loads.
        await require('./coworkShield').applyCoworkShieldToInput({
            orgId: userOrgId,
            userId,
            messages,
        });

        const callStart = Date.now();
        const response = await adapter.chat(config.apiKey, config.url, modelId, messages, {
            maxTokens: Math.min(defaults.maxTokens || 1500, 1500),
            // Deterministic: the same brief should not schedule differently on
            // two tries.
            temperature: 0,
        });

        // The composer's own model call is real spend too: same sink and the
        // same explicit-field attribution as every other call (owner user +
        // org). Fire-and-forget — bookkeeping never decides whether the user
        // gets a spec — and required lazily so this module stays DB-free to
        // load. Logged before the parse: a reply that fails to parse still
        // cost these tokens.
        try {
            const usage = response?.usage || {};
            require('../../stores/usageStore').logUsage({
                user_id: userId || null,
                organization_id: userOrgId || null,
                agent_type: 'cowork',
                model: modelId,
                source: 'cowork_compose',
                prompt_tokens: usage.prompt_tokens || 0,
                completion_tokens: usage.completion_tokens || 0,
                total_tokens: usage.total_tokens
                    || ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0)),
                duration_ms: Date.now() - callStart,
            }).catch(() => { /* bookkeeping only */ });
        } catch (_) { /* bookkeeping only */ }

        const parsed = parseJsonObject(response?.content || '');
        if (!parsed?.value) throw new Error('model returned no JSON object');
        return { ...normaliseSpec(parsed.value, { brief: text, agents }), composed: true };
    } catch (err) {
        // Never block the user's work on the composer: fall back to their own
        // words as a one-off, which is exactly what they got before this
        // existed.
        log.warn(`[CoworkCompose] falling back to the raw brief: ${err.message}`);
        return { ...fallbackSpec(text), composed: false };
    }
}

module.exports = {
    composeCowork,
    normaliseSpec,
    fallbackSpec,
    buildComposePrompt,
    titleFromBrief,
    VALID_REPEAT_INTERVALS,
    VALID_DOW_TOKENS,
};
