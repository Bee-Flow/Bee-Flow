/**
 * Webpage Preview Routes — cross-origin endpoints callable from the
 * sandboxed preview iframe (no `allow-same-origin`, opaque origin, no cookies).
 *
 * All routes are guarded by `requirePreviewToken` (HMAC bearer token bound to
 * a specific `(userId, webpageId)` pair). Mounted in server/index.js without
 * the beta-feature gate because the gate is session-based and the iframe has
 * no session — the token is the trust anchor here, and it can only have been
 * issued by a session-authenticated request through the regular routes.
 *
 * Endpoints:
 *   POST /:id/db/query                      read-only SELECT
 *   POST /:id/db/exec                       INSERT/UPDATE/DELETE/CREATE/etc.
 *   POST /:id/db/batch                      array of statements in a transaction
 *   GET  /:id/db/schema                     list tables + columns
 *
 *   POST /:id/ai/chat                       single-shot LLM call (text or JSON schema)
 *   POST /:id/ai/stream                     streaming LLM call (SSE)
 *   POST /:id/ai/ask                        agentic tool loop (SSE) — auto-uses granted bridges
 *
 *   GET  /:id/automations                   list granted automations
 *   POST /:id/automations/:autoId/run       trigger an automation as the author
 *   GET  /:id/automations/runs/:runId       run status (polling)
 *   GET  /:id/automations/runs/:runId/steps per-step outputs
 *   POST /:id/automations/runs/:runId/cancel
 *
 *   GET  /:id/integrations                  list granted integration tools
 *   POST /:id/integrations/run              call an integration tool as the author
 *
 *   POST /:id/tables/:tid/query             read a bound datatable  AS THE VIEWER
 *   POST /:id/tables/:tid/insert            add a row               AS THE VIEWER
 *   POST /:id/tables/:tid/update            edit a row              AS THE VIEWER
 *
 * The /tables/* routes are the ONE exception to the acts-as-author rule below:
 * a datatable grades every person separately, so they run as the logged-in
 * VIEWER (`previewClaims.viewerUserId`) — see routes/webpagesPreviewTables.js.
 *
 * All other bridge calls (ai / automations / integrations) act as the WEBPAGE AUTHOR
 * — see server/core/webpageBridgeAuth.js. The viewer's identity is captured
 * in `_viewerUserId` on automation trigger payloads but never used to scope
 * the call itself — and it is `previewClaims.viewerUserId`, never
 * `previewClaims.userId` (that is the AUTHOR; using it would make every run
 * report claim the author pressed the button).
 *
 * ── No request schema here, deliberately ───────────────────────────
 * Every body is built by the page's own bridge script from whatever the
 * page's code passes (`beeflowAI.chat(prompt, opts)`, `beeflowDB.exec(sql,
 * params)`, `fetch('/app/…')`). The AI bags are the same ones the public
 * share bridge takes, which leaves them open for the reason its header gives
 * (a refusal only one bridge makes breaks a page once it is shared); the SQL
 * is checked by webpageDbStore; `/app/*` hands the page's own query and body
 * to the page's own handler. What this file owns is the token, the rate
 * limits and the clamps on tokens and rounds. The one bridge with a schema,
 * the tables bridge, is in webpagesPreviewTables.js.
 */

const express = require('express');
const log = require('../telemetry/log');
const { usageLogFields, createUsageAccumulator } = require('../core/providers/usageNormalizer');
const router = express.Router();
const { llmBridgeLimiter, sideEffectBridgeLimiter, integrationBridgeLimiter, dbBridgeLimiter } = require('./webpagesPreviewRateLimits');

const webpageDbStore = require('../stores/webpageDbStore');
const webpageStore = require('../stores/webpageStore');
const automationStore = require('../stores/automationStore');
const { requirePreviewToken } = require('../auth/webpagePreviewToken');
const { loadAuthorContext } = require('../core/webpages/webpageBridgeAuth');
const llmClient = require('../core/llm/llmClient');
const { resolveModelForTier, TIER_DEFAULTS } = require('../core/llm/modelResolver');
const { searchWebpageKB } = require('../core/webpages/webpageKnowledgeSearch');
const { buildAiMessages } = require('../core/webpages/webpageAiMessages');
const usageStore = require('../stores/usageStore');
const { executeTool } = require('../core/tools/toolDispatcher');
const { findOwnerOfTool, loadTools } = require('../automation/toolRegistry');
const { resolveRuntime } = require('../integrations/webpageFramework');
const { executeApiHandler } = require('../integrations/webpageApiRuntime');
const { getProviderForModel } = require('../core/aiAgent');
const { getAdapter } = require('../core/providers');
const { startSseHeartbeat } = require('../core/http/sseHelpers');

// W3 — window.beeflowTables: `/:id/tables/:tid/query|insert|update`. Eigen
// bestand omdat die routes als DE INGELOGDE BEZOEKER draaien en niet
// acts-as-author zoals alles hieronder; zie de kop van webpagesPreviewTables.js.
router.use(require('./webpagesPreviewTables'));

// Soft cap to keep tool results from blowing up the prompt. Arrays/strings
// above these sizes are truncated with a count indicator; the page still gets
// the full result via the SSE `tool_result` event.
const MAX_TOOL_RESULT_ARRAY_ITEMS = 20;
const MAX_TOOL_RESULT_STRING_LEN = 4000;
function compactToolResultForLLM(result) {
    if (result == null) return result;
    if (typeof result === 'string') {
        return result.length > MAX_TOOL_RESULT_STRING_LEN
            ? `${result.slice(0, MAX_TOOL_RESULT_STRING_LEN)}\n…[truncated ${result.length - MAX_TOOL_RESULT_STRING_LEN} chars]`
            : result;
    }
    if (Array.isArray(result)) {
        if (result.length > MAX_TOOL_RESULT_ARRAY_ITEMS) {
            return { _truncated: true, totalItems: result.length, items: result.slice(0, MAX_TOOL_RESULT_ARRAY_ITEMS) };
        }
        return result;
    }
    if (typeof result === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(result)) {
            if (Array.isArray(v) && v.length > MAX_TOOL_RESULT_ARRAY_ITEMS) {
                out[k] = v.slice(0, MAX_TOOL_RESULT_ARRAY_ITEMS);
                out[`${k}_truncated`] = { totalItems: v.length, shown: MAX_TOOL_RESULT_ARRAY_ITEMS };
            } else if (typeof v === 'string' && v.length > MAX_TOOL_RESULT_STRING_LEN) {
                out[k] = `${v.slice(0, MAX_TOOL_RESULT_STRING_LEN)}…[truncated]`;
            } else {
                out[k] = v;
            }
        }
        return out;
    }
    return result;
}

// ── Database ─────────────────────────────────────────────────────────

router.post('/:id/db/query', requirePreviewToken, dbBridgeLimiter, async (req, res) => {
    const { userId, webpageId } = req.previewClaims;
    const { sql, params } = req.body || {};
    try {
        const result = await webpageDbStore.query(userId, webpageId, sql, params);
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

router.post('/:id/db/exec', requirePreviewToken, dbBridgeLimiter, async (req, res) => {
    const { userId, webpageId } = req.previewClaims;
    const { sql, params } = req.body || {};
    try {
        const result = await webpageDbStore.exec(userId, webpageId, sql, params);
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

router.post('/:id/db/batch', requirePreviewToken, dbBridgeLimiter, async (req, res) => {
    const { userId, webpageId } = req.previewClaims;
    const { statements } = req.body || {};
    try {
        const results = await webpageDbStore.batch(userId, webpageId, statements);
        res.json({ results });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

router.get('/:id/db/schema', requirePreviewToken, dbBridgeLimiter, async (req, res) => {
    const { userId, webpageId } = req.previewClaims;
    try {
        const schema = await webpageDbStore.schema(userId, webpageId);
        res.json(schema);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ── Light-tier backend: api/<route>.js handlers ──────────────────────
//
// The page calls /api/webpages-preview/:id/app/<route>; we run the matching
// api/<route>.js handler in an isolated-vm sandbox (acts-as-author). Only the
// light runtime tier uses this — the full tier proxies /app/* to the project's
// Node container instead (see the runtime manager).
router.all('/:id/app/*rest', requirePreviewToken, dbBridgeLimiter, async (req, res) => {
    const { webpageId } = req.previewClaims;
    try {
        const rest = req.params.rest;
        const route = Array.isArray(rest) ? rest.join('/') : (rest || '');

        // Gate to the light tier — the full tier serves its own backend.
        const wp = await webpageStore.getWebpageRaw(webpageId);
        if (resolveRuntime(wp) === 'full') {
            return res.status(409).json({ error: 'This project uses the full runtime tier; its backend runs in the project container.' });
        }

        const out = await executeApiHandler({
            webpageId,
            route,
            req: {
                method: req.method,
                path: route,
                query: req.query || {},
                body: (req.body && typeof req.body === 'object') ? req.body : {},
            },
        });
        if (out.headers) {
            for (const [k, v] of Object.entries(out.headers)) {
                try { res.setHeader(k, v); } catch (_) { /* ignore bad header */ }
            }
        }
        res.status(out.status || 200).json(out.body);
    } catch (err) {
        log.error('[WebpagesPreview] api handler failed:', err);
        res.status(500).json({ error: 'Handler execution failed' });
    }
});

// ── AI bridge ────────────────────────────────────────────────────────
//
// buildAiMessages lives in server/core/webpageAiMessages.js so the anonymous
// public-share bridge can reuse it verbatim (with the publicGroundOnPage grant).

router.post('/:id/ai/chat', requirePreviewToken, llmBridgeLimiter, async (req, res) => {
    const { webpageId } = req.previewClaims;
    const ctx = await loadAuthorContext(webpageId);
    if (!ctx) return res.status(404).json({ error: 'Webpage not found' });
    if (!ctx.bridgeGrants.ai.enabled) return res.status(403).json({ error: 'AI bridge is disabled for this webpage' });

    const messages = await buildAiMessages(ctx, req.body || {});
    const tierName = (req.body && typeof req.body.tier === 'string')
        ? req.body.tier
        : (ctx.bridgeGrants.ai.defaultTier || 'fast');
    const resolved = await resolveModelForTier(`tier:${tierName}`, { userOrgId: ctx.authorOrgId, userId: ctx.authorUserId });
    const modelId = resolved?.modelId || resolved?.model || resolved;
    if (!modelId) return res.status(500).json({ error: `No model configured for tier "${tierName}"` });

    const tierDefaults = TIER_DEFAULTS[tierName] || TIER_DEFAULTS['fast'];
    const maxTokens = Math.min(parseInt(req.body?.maxTokens, 10) || tierDefaults.maxTokens, 16384);
    const baseOptions = {
        maxTokens,
        temperature: typeof req.body?.temperature === 'number' ? req.body.temperature : tierDefaults.temperature,
    };

    const t0 = Date.now();
    let result;
    let structured = null;

    // Structured-output mode: force a single tool call against the user's
    // JSON Schema. Universal across providers — anything that supports
    // tool calling can satisfy the schema, no native json_schema needed.
    if (req.body && req.body.schema && typeof req.body.schema === 'object') {
        const schemaTool = {
            type: 'function',
            function: {
                name: 'return_structured_output',
                description: 'Return the answer as structured JSON matching the provided schema. Call this tool exactly once.',
                parameters: req.body.schema,
            },
        };
        // The forced choice is provider-shaped: the OpenAI object form
        // for the cloud adapters, 'required' for Google and for every
        // self-hosted runtime — llama-server reads the object form as
        // "auto" (core/llm/llmClient.forcedToolChoice).
        result = await llmClient.chat(modelId, messages, {
            ...baseOptions,
            tools: [schemaTool],
            toolChoice: await llmClient.forcedToolChoiceFor(modelId, 'return_structured_output'),
        });
        const call = (result.toolCalls || []).find(tc => tc?.function?.name === 'return_structured_output')
            || (result.toolCalls || [])[0];
        if (call) {
            try {
                const raw = call.function?.arguments;
                structured = typeof raw === 'string' ? JSON.parse(raw) : (raw || null);
            } catch (_) { structured = null; }
        }
        if (structured === null) {
            return res.status(502).json({ error: 'Model did not return valid structured output' });
        }
    } else {
        result = await llmClient.chat(modelId, messages, baseOptions);
    }

    usageStore.logUsage({
        user_id: ctx.authorUserId,
        organization_id: ctx.authorOrgId,
        agent_id: webpageId,
        agent_name: `Webpage: ${ctx.webpage.name || 'Untitled'}`,
        agent_type: 'webpage_bridge',
        model: modelId,
        ...usageLogFields(result?.usage),
        duration_ms: Date.now() - t0,
        source: 'webpage_bridge_ai',
        conversation_id: webpageId,
    }).catch(() => {});

    if (structured !== null) {
        res.json({ json: structured });
    } else {
        res.json({ text: result.content || '' });
    }
});

router.post('/:id/ai/stream', requirePreviewToken, llmBridgeLimiter, async (req, res) => {
    const { webpageId } = req.previewClaims;
    let ctx;
    ctx = await loadAuthorContext(webpageId);
    if (!ctx) return res.status(404).json({ error: 'Webpage not found' });
    if (!ctx.bridgeGrants.ai.enabled) return res.status(403).json({ error: 'AI bridge is disabled for this webpage' });

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    // Prevents a thinking-model silence from tripping an upstream gateway's
    // idle-connection drop (the same failure mode fixed for the automation
    // builder stream — see startSseHeartbeat's usage there).
    const stopHeartbeat = startSseHeartbeat(res);
    // Set once the client disconnects. The underlying LLM fetch isn't
    // cancellable yet (the provider adapters don't accept an abort signal —
    // see webpageRuntimeManager's sibling design note), so this only stops us
    // writing to a dead socket; it doesn't cut short the in-flight request.
    let aborted = false;
    res.on('close', () => { aborted = true; stopHeartbeat(); });
    const send = (event, data) => {
        if (aborted) return;
        try { res.write(`event: ${event}\ndata: ${JSON.stringify(data || {})}\n\n`); } catch (_) {}
    };

    try {
        const messages = await buildAiMessages(ctx, req.body || {});
        const tierName = (req.body && typeof req.body.tier === 'string')
            ? req.body.tier
            : (ctx.bridgeGrants.ai.defaultTier || 'fast');
        const resolved = await resolveModelForTier(`tier:${tierName}`, { userOrgId: ctx.authorOrgId, userId: ctx.authorUserId });
        const modelId = resolved?.modelId || resolved?.model || resolved;
        if (!modelId) {
            send('error', { error: `No model configured for tier "${tierName}"` });
            stopHeartbeat();
            return res.end();
        }
        const tierDefaults = TIER_DEFAULTS[tierName] || TIER_DEFAULTS['fast'];
        const maxTokens = Math.min(parseInt(req.body?.maxTokens, 10) || tierDefaults.maxTokens, 16384);

        const t0 = Date.now();
        let promptTokens = 0, completionTokens = 0;
        await llmClient.stream(modelId, messages, { maxTokens, temperature: tierDefaults.temperature }, (type, data) => {
            if (type === 'text') send('content', { text: data.text });
            else if (type === 'done') {
                promptTokens = data?.prompt_tokens || 0;
                completionTokens = data?.completion_tokens || 0;
            }
            else if (type === 'error') send('error', { error: data?.error || 'stream error' });
        });

        usageStore.logUsage({
            user_id: ctx.authorUserId,
            organization_id: ctx.authorOrgId,
            agent_id: webpageId,
            agent_name: `Webpage: ${ctx.webpage.name || 'Untitled'}`,
            agent_type: 'webpage_bridge',
            model: modelId,
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
            duration_ms: Date.now() - t0,
            source: 'webpage_bridge_ai',
            conversation_id: webpageId,
        }).catch(() => {});

        send('done', { prompt_tokens: promptTokens, completion_tokens: completionTokens });
        stopHeartbeat();
        res.end();
    } catch (err) {
        log.error(`[WebpagesPreview/ai/stream] ${err.message}`);
        send('error', { error: err.message });
        stopHeartbeat();
        res.end();
    }
});

/**
 * Agentic AI bridge — POST /:id/ai/ask
 *
 * Runs a multi-round tool loop server-side using the page's granted surface
 * (integrations + automations + KB grounding). The page just awaits one
 * promise; the server orchestrates web search, integration calls, KB lookup,
 * and automation triggers across rounds.
 *
 * SSE event types streamed back:
 *   text         { text }                       — assistant tokens
 *   tool_call    { id, name, args }             — before dispatch
 *   tool_result  { id, name, ok, summary }      — after dispatch (compact)
 *   error        { error }
 *   done         { rounds, truncated?, usage }
 *
 * Tool surface is built automatically from `bridge_grants`:
 *   - Every granted integration tool → dispatched via executeTool (acts-as-author)
 *   - Every granted automation       → synthetic `automation_<id>` tool
 *   - If groundOnPage + KBs          → synthetic `page_knowledge_search` tool
 */
const MAX_ASK_ROUNDS_DEFAULT = 6;
const MAX_ASK_ROUNDS_HARD_CAP = 10;

function buildAskToolSurface(ctx) {
    const tools = [];
    const integrationGrantByTool = new Map();
    const automationGrantById = new Map();

    for (const grant of (ctx.bridgeGrants.integrations || [])) {
        const owner = findOwnerOfTool(grant.tool);
        if (!owner) continue;
        const def = loadTools(owner).find(t => t?.function?.name === grant.tool);
        if (!def) continue;
        integrationGrantByTool.set(grant.tool, grant);
        // Hide pinned fields from the model — the server merges them in.
        const params = def.function.parameters || { type: 'object', properties: {} };
        let trimmedParams = params;
        if (grant.fixedArgs && typeof grant.fixedArgs === 'object' && params.properties) {
            const props = { ...params.properties };
            for (const key of Object.keys(grant.fixedArgs)) delete props[key];
            trimmedParams = {
                ...params,
                properties: props,
                required: Array.isArray(params.required)
                    ? params.required.filter(k => !(k in grant.fixedArgs))
                    : params.required,
            };
        }
        tools.push({
            type: 'function',
            function: {
                name: def.function.name,
                description: def.function.description || '',
                parameters: trimmedParams,
            },
        });
    }

    for (const grant of (ctx.bridgeGrants.automations || [])) {
        automationGrantById.set(grant.automationId, grant);
        const toolName = `automation_${grant.automationId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        tools.push({
            type: 'function',
            function: {
                name: toolName,
                description: `Run the author's automation "${grant.label || grant.automationId}". Returns the automation's final output.`,
                parameters: {
                    type: 'object',
                    properties: {
                        inputs: { type: 'object', description: 'Input values for the automation.' },
                    },
                },
            },
        });
    }

    const kbIds = Array.isArray(ctx.webpage.knowledgeBaseIds) ? ctx.webpage.knowledgeBaseIds : [];
    const groundEnabled = !!ctx.bridgeGrants.ai.groundOnPage && kbIds.length > 0;
    if (groundEnabled) {
        tools.push({
            type: 'function',
            function: {
                name: 'page_knowledge_search',
                description: `Search the webpage's own knowledge base (uploaded sources, attached KBs). Use this first when the user asks about page-specific content.`,
                parameters: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: 'What to search for.' },
                        topK: { type: 'integer', description: 'Max chunks to return (default 6).' },
                    },
                    required: ['query'],
                },
            },
        });
    }

    return { tools, integrationGrantByTool, automationGrantById, groundEnabled, kbIds };
}

router.post('/:id/ai/ask', requirePreviewToken, llmBridgeLimiter, async (req, res) => {
    // `viewerUserId`, NOOIT `userId`: dat laatste is de EIGENAAR van de pagina
    // (auth/webpagePreviewToken.js legt uit waarom die twee claims naast elkaar
    // bestaan). Het runverslag zei daardoor dat de auteur de automatisering had gestart,
    // ook als een ingelogde lezer op een <bf-button> klikte — en dit is sinds W4
    // het pad dat zonder één regel JavaScript bereikbaar is. Geen terugval op
    // `userId`: een onbekende bezoeker is `null`, en `null` is eerlijk.
    const { viewerUserId, webpageId } = req.previewClaims;
    let ctx;
    ctx = await loadAuthorContext(webpageId);
    if (!ctx) return res.status(404).json({ error: 'Webpage not found' });
    if (!ctx.bridgeGrants.ai.enabled) return res.status(403).json({ error: 'AI bridge is disabled for this webpage' });

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    // Prevents an idle-timeout gateway drop during long thinking-model
    // silences, and lets the round loop below notice a disconnect and stop
    // spending tokens / dispatching integration+automation side effects on
    // behalf of a client that's no longer listening.
    const stopHeartbeat = startSseHeartbeat(res);
    let aborted = false;
    res.on('close', () => { aborted = true; stopHeartbeat(); });
    const send = (event, data) => {
        if (aborted) return;
        try { res.write(`event: ${event}\ndata: ${JSON.stringify(data || {})}\n\n`); } catch (_) {}
    };

    const t0 = Date.now();
    // Every round of the loop, cache read/write included (providers/usageNormalizer.js).
    const usageAcc = createUsageAccumulator();

    try {
        const messages = await buildAiMessages(ctx, req.body || {});
        // Layer in agentic-loop guidance the static system message doesn't have
        messages.unshift({
            role: 'system',
            content: `You have access to tools that let you fetch information and take actions on the page author's behalf. When the user asks for something that requires fresh information, search the web or the page knowledge base before answering. Cite sources inline. Keep responses concise.`,
        });

        const tierName = (req.body && typeof req.body.tier === 'string')
            ? req.body.tier
            : (ctx.bridgeGrants.ai.defaultTier || 'fast');
        const resolved = await resolveModelForTier(`tier:${tierName}`, { userOrgId: ctx.authorOrgId, userId: ctx.authorUserId });
        const modelId = resolved?.modelId || resolved?.model || resolved;
        if (!modelId) {
            send('error', { error: `No model configured for tier "${tierName}"` });
            return res.end();
        }

        const config = await getProviderForModel(modelId);
        const adapter = getAdapter(config.providerType, (config.url || '').replace(/\/+$/, ''));
        const apiKey = config.apiKey;
        const apiUrl = (config.url || '').replace(/\/+$/, '');

        const tierDefaults = TIER_DEFAULTS[tierName] || TIER_DEFAULTS['fast'];
        const maxTokens = Math.min(parseInt(req.body?.maxTokens, 10) || tierDefaults.maxTokens, 16384);
        const maxRoundsRequested = parseInt(req.body?.maxRounds, 10);
        const maxRounds = Math.min(
            Number.isFinite(maxRoundsRequested) && maxRoundsRequested > 0 ? maxRoundsRequested : MAX_ASK_ROUNDS_DEFAULT,
            MAX_ASK_ROUNDS_HARD_CAP
        );

        const surface = buildAskToolSurface(ctx);
        const tools = surface.tools;

        // The author's Privacy Shield tool block lists ("Outside tools" / "Own
        // server"): the bridge acts as the author, so the author's rules hold
        // (BFSF-354). Rules in core/privacy/toolPiiGate.js; a failed lookup
        // leaves the lists unapplied, as a missing shield does elsewhere.
        const toolPiiGate = require('../core/privacy/toolPiiGate');
        const shield = tools.length > 0
            ? await toolPiiGate.resolveToolShield(() => require('../core/privacy/orgShield').resolveShieldFor({
                orgId: ctx.authorOrgId || null, userId: ctx.authorUserId || null,
            }), 'WebpageAsk')
            : null;
        const shieldGate = toolPiiGate.toolLoopGate({
            shield, tag: 'WebpageAsk',
            audit: (fields) => require('../stores/guardrailEventStore').logGuardrailEvent({
                organization_id: ctx.authorOrgId || null, user_id: ctx.authorUserId || null,
                ...fields, source: 'webpage_ai', model: modelId,
            }),
        });

        async function dispatchAskTool(toolCall) {
            const toolName = toolCall.function?.name || toolCall.name;
            let toolArgs = {};
            try { toolArgs = JSON.parse(toolCall.function?.arguments || '{}'); } catch (_) {}

            send('tool_call', { id: toolCall.id, name: toolName, args: toolArgs });
            const refusal = await shieldGate.refuse(toolName, toolArgs);
            if (refusal) {
                send('tool_result', { id: toolCall.id, name: toolName, ok: false, summary: refusal.uiResult });
                return { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ error: refusal.modelError }) };
            }
            let toolResult;

            try {
                if (toolName === 'page_knowledge_search' && surface.groundEnabled) {
                    const query = String(toolArgs.query || '').trim();
                    if (!query) toolResult = { error: 'query is required' };
                    else {
                        const r = await searchWebpageKB({
                            userId: ctx.authorUserId,
                            kbIds: surface.kbIds,
                            query,
                            options: { topK: Math.min(parseInt(toolArgs.topK, 10) || 6, 20), rerank: true, minScore: 0.2 },
                        });
                        toolResult = { chunks: r?.chunks || [], contextPrompt: r?.contextPrompt || '' };
                    }
                } else if (toolName.startsWith('automation_')) {
                    // Find the original grant by reversing the sanitized name match
                    let grant = null;
                    for (const [autoId, g] of surface.automationGrantById.entries()) {
                        if (`automation_${autoId.replace(/[^a-zA-Z0-9_-]/g, '_')}` === toolName) { grant = g; break; }
                    }
                    if (!grant) toolResult = { error: `Automation not granted: ${toolName}` };
                    else {
                        const automation = await automationStore.getAutomation(grant.automationId).catch(() => null);
                        if (!automation || automation.userId !== ctx.authorUserId) {
                            toolResult = { error: 'Automation unavailable' };
                        } else {
                            const runner = require('../core/automationRunner');
                            const run = await runner.executeAutomation(automation, {
                                triggerKind: 'webpage',
                                triggerPayload: {
                                    inputs: (toolArgs && typeof toolArgs.inputs === 'object') ? toolArgs.inputs : {},
                                    _viewerUserId: viewerUserId || null,
                                    _webpageId: webpageId,
                                    _via: 'beeflowAI.ask',
                                },
                                mode: 'live',
                            });
                            toolResult = { runId: run.id, status: run.status, output: run.output ?? null, error: run.error || null };
                        }
                    }
                } else if (surface.integrationGrantByTool.has(toolName)) {
                    const grant = surface.integrationGrantByTool.get(toolName);
                    const mergedArgs = { ...(toolArgs || {}), ...(grant.fixedArgs || {}) };
                    toolResult = await executeTool(toolName, mergedArgs, {
                        userId: ctx.authorUserId,
                        session: ctx.authorSession,
                        orgId: ctx.authorOrgId,
                        autoSend: true,
                        // Acts as the page's author; the chokepoint writes the
                        // egress row, grouped per page like an automation's.
                        egress: {
                            source: 'webpage_ai',
                            ids: {
                                organization_id: ctx.authorOrgId || null,
                                user_id: ctx.authorUserId || null,
                                automation_id: webpageId || null,
                            },
                        },
                    });
                } else {
                    toolResult = { error: `Tool not granted: ${toolName}` };
                }
            } catch (err) {
                toolResult = { error: err.message || 'tool dispatch failed' };
            }

            const compact = compactToolResultForLLM(toolResult);
            send('tool_result', {
                id: toolCall.id,
                name: toolName,
                ok: !(toolResult && typeof toolResult === 'object' && toolResult.error),
                summary: compact,
            });

            return {
                role: 'tool',
                tool_call_id: toolCall.id,
                // What the model reads, with the categories this tool's class
                // forbids stripped out (BFSF-354).
                content: await shieldGate.forModel(typeof compact === 'string' ? compact : JSON.stringify(compact), toolName),
            };
        }

        let rounds = 0;
        let truncated = false;
        let fullContent = '';
        let streamToolCalls = [];

        const streamCallback = (type, data) => {
            if (type === 'text') {
                fullContent += data.text;
                send('text', { text: data.text });
            } else if (type === 'tool_use' || type === 'tool_call') {
                streamToolCalls.push({
                    id: data.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
                    type: 'function',
                    function: {
                        name: data.name || data.function?.name,
                        arguments: typeof data.input !== 'undefined'
                            ? JSON.stringify(data.input || {})
                            : (data.function?.arguments || '{}'),
                    },
                });
            } else if (type === 'done') {
                usageAcc.add(data);
            } else if (type === 'error') {
                send('error', { error: data?.error || 'stream error' });
            }
        };

        while (rounds < maxRounds) {
            // A client that disconnected mid-loop shouldn't cause further LLM
            // spend or trigger the next round's integration/automation side
            // effects (Slack messages, Sheets writes, …) for nobody to see.
            if (aborted) break;
            fullContent = '';
            streamToolCalls = [];

            const streamOptions = { maxTokens, temperature: tierDefaults.temperature };
            if (tools.length > 0) {
                streamOptions.tools = tools;
                streamOptions.toolChoice = 'auto';
            }

            await adapter.stream(apiKey, apiUrl, modelId, messages, streamOptions, streamCallback);

            if (aborted || streamToolCalls.length === 0) break;

            messages.push({
                role: 'assistant',
                content: fullContent || null,
                tool_calls: streamToolCalls,
            });
            rounds++;
            const toolResults = await Promise.all(streamToolCalls.map(dispatchAskTool));
            messages.push(...toolResults);
        }

        if (!aborted && rounds >= maxRounds && streamToolCalls.length > 0) {
            truncated = true;
            // Last chance to summarise without offering more tools.
            try {
                fullContent = '';
                streamToolCalls = [];
                await adapter.stream(apiKey, apiUrl, modelId, messages, { maxTokens, temperature: tierDefaults.temperature }, streamCallback);
            } catch (_) { /* best-effort */ }
        }

        // Logged regardless of client disconnect — real tokens were spent
        // either way, so the usage record should reflect that.
        usageStore.logUsage({
            user_id: ctx.authorUserId,
            organization_id: ctx.authorOrgId,
            agent_id: webpageId,
            agent_name: `Webpage: ${ctx.webpage.name || 'Untitled'}`,
            agent_type: 'webpage_bridge',
            model: modelId,
            ...usageLogFields(usageAcc.total()),
            duration_ms: Date.now() - t0,
            source: 'webpage_bridge_ai_agentic',
            conversation_id: webpageId,
        }).catch(() => {});

        send('done', { rounds, truncated, prompt_tokens: usageAcc.total().prompt_tokens, completion_tokens: usageAcc.total().completion_tokens });
        stopHeartbeat();
        try { res.end(); } catch (_) { /* already closed */ }
    } catch (err) {
        log.error(`[WebpagesPreview/ai/ask] ${err.message}`);
        send('error', { error: err.message });
        stopHeartbeat();
        try { res.end(); } catch (_) { /* already closed */ }
    }
});

// ── Automations bridge ───────────────────────────────────────────────

router.get('/:id/automations', requirePreviewToken, async (req, res) => {
    const { webpageId } = req.previewClaims;
    const ctx = await loadAuthorContext(webpageId);
    if (!ctx) return res.status(404).json({ error: 'Webpage not found' });
    const grants = ctx.bridgeGrants.automations || [];
    // Enrich each grant with the live automation metadata. Filters out
    // grants whose automation has since been deleted or transferred.
    const list = [];
    for (const g of grants) {
        const a = await automationStore.getAutomation(g.automationId).catch(() => null);
        if (!a) continue;
        if (a.userId !== ctx.authorUserId) continue;
        list.push({
            automationId: a.id,
            title: a.title,
            description: a.description || '',
            label: g.label || a.title,
            isActive: !!a.isActive,
        });
    }
    res.json({ automations: list });
});

router.post('/:id/automations/:autoId/run', requirePreviewToken, sideEffectBridgeLimiter, async (req, res) => {
    // Zie /ai/ask hierboven: de bezoeker is `viewerUserId`, de auteur is `userId`.
    const { viewerUserId, webpageId } = req.previewClaims;
    const autoId = req.params.autoId;
    const ctx = await loadAuthorContext(webpageId);
    if (!ctx) return res.status(404).json({ error: 'Webpage not found' });

    const grant = (ctx.bridgeGrants.automations || []).find(g => g.automationId === autoId);
    if (!grant) return res.status(403).json({ error: 'Automation not granted to this webpage' });

    const automation = await automationStore.getAutomation(autoId);
    if (!automation) return res.status(404).json({ error: 'Automation not found' });
    if (automation.userId !== ctx.authorUserId) return res.status(403).json({ error: 'Automation does not belong to the page author' });

    const runner = require('../core/automationRunner');
    const triggerPayload = {
        inputs: (req.body && typeof req.body.inputs === 'object') ? req.body.inputs : {},
        _viewerUserId: viewerUserId || null,
        _webpageId: webpageId,
    };
    // Best-effort 60s sync wait so the page gets a result without polling.
    // Long runs still complete server-side; the page can poll the run by ID.
    const wait = req.body?.wait !== false;
    if (wait) {
        const run = await runner.executeAutomation(automation, {
            triggerKind: 'webpage',
            triggerPayload,
            mode: 'live',
        });
        const steps = await automationStore.getRunSteps(run.id).catch(() => []);
        return res.json({ runId: run.id, status: run.status, output: run.output ?? null, error: run.error || null, steps });
    }
    // Async path: fire and respond with the run ID for polling.
    const run = await runner.executeAutomation(automation, {
        triggerKind: 'webpage',
        triggerPayload,
        mode: 'live',
    }).catch(err => ({ id: null, status: 'error', error: err.message }));
    res.json({ runId: run.id || null, status: run.status || 'pending', error: run.error || null });
});

router.get('/:id/automations/runs/:runId', requirePreviewToken, async (req, res) => {
    const { webpageId } = req.previewClaims;
    const ctx = await loadAuthorContext(webpageId);
    if (!ctx) return res.status(404).json({ error: 'Webpage not found' });
    const run = await automationStore.getRun(req.params.runId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (run.userId !== ctx.authorUserId) return res.status(403).json({ error: 'Forbidden' });
    res.json({ runId: run.id, status: run.status, error: run.error || null, output: run.output ?? null });
});

router.get('/:id/automations/runs/:runId/steps', requirePreviewToken, async (req, res) => {
    const { webpageId } = req.previewClaims;
    const ctx = await loadAuthorContext(webpageId);
    if (!ctx) return res.status(404).json({ error: 'Webpage not found' });
    const run = await automationStore.getRun(req.params.runId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (run.userId !== ctx.authorUserId) return res.status(403).json({ error: 'Forbidden' });
    const steps = await automationStore.getRunSteps(req.params.runId);
    res.json({ steps });
});

router.post('/:id/automations/runs/:runId/cancel', requirePreviewToken, async (req, res) => {
    const { webpageId } = req.previewClaims;
    const ctx = await loadAuthorContext(webpageId);
    if (!ctx) return res.status(404).json({ error: 'Webpage not found' });
    const run = await automationStore.getRun(req.params.runId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (run.userId !== ctx.authorUserId) return res.status(403).json({ error: 'Forbidden' });
    const runner = require('../core/automationRunner');
    await runner.requestCancel(req.params.runId);
    res.json({ ok: true });
});

// ── Integrations bridge ──────────────────────────────────────────────

router.get('/:id/integrations', requirePreviewToken, async (req, res) => {
    const { webpageId } = req.previewClaims;
    const ctx = await loadAuthorContext(webpageId);
    if (!ctx) return res.status(404).json({ error: 'Webpage not found' });
    const grants = ctx.bridgeGrants.integrations || [];
    const enriched = grants.map(g => {
        const owner = findOwnerOfTool(g.tool);
        const tools = owner ? loadTools(owner) : [];
        const def = tools.find(t => t?.function?.name === g.tool);
        return {
            tool: g.tool,
            label: g.label || (def?.function?.name || g.tool).replace(/_/g, ' '),
            description: def?.function?.description || '',
            schema: def?.function?.parameters || null,
            integrationId: owner?.app || null,
            hasFixedArgs: !!(g.fixedArgs && Object.keys(g.fixedArgs).length > 0),
        };
    });
    res.json({ integrations: enriched });
});

// Tier is picked per tool: read-only tools get the 60/min read bucket, anything
// that writes keeps the strict 10/min side-effect bucket (see the selector in
// webpagesPreviewRateLimits.js — fail-closed for unknown tools).
router.post('/:id/integrations/run', requirePreviewToken, integrationBridgeLimiter, async (req, res) => {
    const { webpageId } = req.previewClaims;
    const { tool, args } = req.body || {};
    if (typeof tool !== 'string' || !tool.trim()) return res.status(400).json({ error: 'tool is required' });
    const ctx = await loadAuthorContext(webpageId);
    if (!ctx) return res.status(404).json({ error: 'Webpage not found' });

    const grant = (ctx.bridgeGrants.integrations || []).find(e => e.tool === tool);
    if (!grant) return res.status(403).json({ error: `Tool "${tool}" not granted to this webpage` });

    // Merge viewer-supplied args with author-pinned fixedArgs. fixedArgs
    // ALWAYS wins — that's the whole point of pinning (author retains
    // control over sensitive fields like channel, recipient, sheet ID).
    const mergedArgs = { ...(args || {}), ...(grant.fixedArgs || {}) };

    const result = await executeTool(tool, mergedArgs, {
        userId: ctx.authorUserId,
        session: ctx.authorSession,
        orgId: ctx.authorOrgId,
        autoSend: true,
        // The page's integration bridge, acting as its author: the
        // chokepoint writes the egress row, grouped per page.
        egress: {
            source: 'webpage_bridge',
            ids: {
                organization_id: ctx.authorOrgId || null,
                user_id: ctx.authorUserId || null,
                automation_id: webpageId || null,
            },
        },
    });
    res.json({ result });
});

module.exports = router;
