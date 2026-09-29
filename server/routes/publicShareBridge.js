/**
 * Public-Share AI Bridge — anonymous, cross-origin AI endpoints callable from
 * an externally-shared webpage (the sandboxed /share/:token content iframe).
 *
 * This is the anonymous sibling of server/routes/webpagesPreview.js. Where that
 * one is gated by a session-minted preview token, these are gated by a
 * SHARE-scoped bridge token (server/auth/publicShareToken.js `bridge` purpose)
 * minted at content-serve time only when the webpage author opted the share
 * into public AI (bridge_grants.ai.publicEnabled).
 *
 * Mounted at /api/public-share with permissive CORS (the opaque-origin iframe
 * sends `Origin: null` and no cookie — the bearer token is the sole trust
 * anchor). Only plain LLM completion is exposed:
 *   POST /ai/chat    single-shot (text or JSON schema)
 *   POST /ai/stream  SSE streaming
 * DB / automations / integrations / agentic ai.ask are deliberately absent —
 * they run side-effecting tools acts-as-author, unacceptable for an anonymous
 * prompt (prompt injection → data exfiltration / actions as the author).
 *
 * Every request runs acts-as-author (webpageBridgeAuth.loadAuthorContext), so
 * the author's model config/keys are used and the author's budget is spent —
 * bounded by per-share + per-IP rate limits, a rolling-24h spend cap, and hard
 * tier/token/size clamps below.
 *
 * ── The body stays OPEN, deliberately — no zod schema here ─────────────
 *
 * The body is `Object.assign({ prompt }, opts)` in the page's own bridge
 * script (services/publicBridgeScript.js), and `opts` is whatever the page's
 * code passes. That code is written — by the author or the builder AI — and
 * TESTED against the in-app preview bridge (webpagesPreview.js), which takes
 * the same bag and honours keys this route ignores on purpose (`tier`: an
 * anonymous visitor never picks the tier). A refusal here that preview does
 * not make would break a page only once it is shared, where its author is not
 * looking. So the shape is left to the two bridges together; what THIS route
 * owns is the budget, and that is enforced in clampBody below — by size,
 * which is the only thing an anonymous visitor could use against the author.
 *
 * One refusal clampBody does make on content: a call with nothing to answer
 * (no prompt text and no messages). buildAiMessages throws on that, and it
 * used to throw OUTSIDE any answer — /ai/chat became a bare 500, and /ai/stream
 * had already opened its 200 and sent an `error` event the page's stream()
 * never reads, so it resolved with an empty string. Neither bridge can answer
 * such a call, so refusing it first breaks nothing that worked in preview.
 */

const express = require('express');
const log = require('../telemetry/log');
const router = express.Router();

const publicShareToken = require('../auth/publicShareToken');
const publicShareStore = require('../stores/webpagePublicShareStore');
const webpageStore = require('../stores/webpageStore');
const { loadAuthorContext } = require('../core/webpages/webpageBridgeAuth');
const { buildAiMessages } = require('../core/webpages/webpageAiMessages');
const llmClient = require('../core/llm/llmClient');
const { resolveModelForTier, TIER_DEFAULTS } = require('../core/llm/modelResolver');
const usageStore = require('../stores/usageStore');
const { startSseHeartbeat } = require('../core/http/sseHelpers');
const { publicAiLimiter, publicIpLimiter } = require('./publicShareBridgeRateLimits');

// Distinct usage source so anonymous spend is isolated from the author's own
// preview spend ('webpage_bridge_ai') and can be summed for the spend cap.
const PUBLIC_USAGE_SOURCE = 'public_share_bridge_ai';
// Anonymous callers get a low output ceiling (authors get 16384).
const PUBLIC_MAX_TOKENS = 2048;
// Reject oversized prompts/conversations — a global 20mb body parser is far too
// permissive for an anonymous LLM call that spends the author's budget.
const PUBLIC_MAX_PROMPT_CHARS = 8000;
const PUBLIC_MAX_MESSAGES = 20;
// A chatJSON schema goes to the model as a tool definition, so it is prompt
// text as well — and it was the one part of the body no clamp counted.
// `{"prompt":"hi","schema":{"type":"object","description":"<19 MB>"}}` fit the
// global body parser and reached the author's model whole, however tight the
// prompt limits above. Generous for a real output schema; nowhere near 20 MB.
const PUBLIC_MAX_SCHEMA_CHARS = PUBLIC_MAX_PROMPT_CHARS * 2;

// ── Auth middleware ──────────────────────────────────────────────────
function requireShareBridgeToken(req, res, next) {
    const auth = req.headers['authorization'] || req.headers['Authorization'];
    const m = (typeof auth === 'string' ? auth : '').match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'Missing bearer token' });
    const claims = publicShareToken.verifyBridgeToken(m[1].trim());
    if (!claims) return res.status(401).json({ error: 'Invalid or expired token' });
    req.shareBridgeClaims = claims; // { shareId, webpageId }
    next();
}

// ── Shared per-request resolution ────────────────────────────────────
//
// Returns { ctx, grants } on success, or { error, status } to short-circuit.
// Re-checks the share on EVERY call so revoking a share kills public AI
// immediately — the 30-min token TTL is only a backstop.
async function resolveContext({ shareId, webpageId }) {
    const share = await publicShareStore.getShareById(shareId);
    if (!share || share.webpageId !== webpageId) return { status: 401, error: 'Share not found' };
    if (share.revokedAt) return { status: 401, error: 'This share has been revoked' };
    if (share.expiresAt && new Date(share.expiresAt).getTime() < Date.now()) {
        return { status: 401, error: 'This share has expired' };
    }

    const grants = await webpageStore.getBridgeGrants(webpageId);
    if (!grants?.ai?.publicEnabled) return { status: 403, error: 'AI is not enabled for this shared page' };

    // Spend cap — rolling 24h estimated cost for this webpage's public AI.
    const cap = Number(grants.ai.publicSpendCapUsd);
    if (Number.isFinite(cap) && cap >= 0) {
        try {
            const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
            const summary = await usageStore.getUsageSummary({ agentId: webpageId, source: PUBLIC_USAGE_SOURCE, startDate: since });
            if (Number(summary?.total_estimated_cost || 0) >= cap) {
                return { status: 429, error: 'This page has reached its AI usage limit for today.' };
            }
        } catch (_) { /* usage lookup failure should not open the gate but must not 500 the call */ }
    }

    const ctx = await loadAuthorContext(webpageId);
    if (!ctx) return { status: 404, error: 'Webpage not found' };
    return { ctx, grants };
}

// Clamp inputs so an anonymous caller can neither pick an expensive tier nor
// inflate token/prompt size. Returns { error } if the body is rejected.
function clampBody(body, grants) {
    const prompt = typeof body.prompt === 'string' ? body.prompt : '';
    const messages = Array.isArray(body.messages) ? body.messages : [];
    // buildAiMessages' own condition, asked before anything is opened or spent.
    if (!prompt && messages.length === 0) return { error: 'A prompt is required: the text to answer, or a list of messages.' };
    if (prompt.length > PUBLIC_MAX_PROMPT_CHARS) return { error: 'Prompt is too long.' };
    if (messages.length > PUBLIC_MAX_MESSAGES) return { error: 'Too many messages.' };
    const totalLen = prompt.length + messages.reduce((n, m) => n + (typeof m?.content === 'string' ? m.content.length : 0), 0);
    if (totalLen > PUBLIC_MAX_PROMPT_CHARS * 2) return { error: 'Conversation is too long.' };
    // Measured the way it will be sent: serialised. A parsed JSON body always
    // stringifies, so there is no throw to catch here.
    if (body.schema && typeof body.schema === 'object'
        && JSON.stringify(body.schema).length > PUBLIC_MAX_SCHEMA_CHARS) {
        return { error: 'Output schema is too large.' };
    }
    // Force the author's public tier — ignore any viewer-supplied tier.
    const tierName = grants.ai.publicDefaultTier || 'fast';
    return { tierName };
}

function logPublicUsage(ctx, webpageId, modelId, promptTokens, completionTokens, t0) {
    usageStore.logUsage({
        user_id: ctx.authorUserId,
        organization_id: ctx.authorOrgId,
        agent_id: webpageId,
        agent_name: `Webpage (public): ${ctx.webpage.name || 'Untitled'}`,
        agent_type: 'webpage_bridge',
        model: modelId,
        prompt_tokens: promptTokens || 0,
        completion_tokens: completionTokens || 0,
        total_tokens: (promptTokens || 0) + (completionTokens || 0),
        duration_ms: Date.now() - t0,
        source: PUBLIC_USAGE_SOURCE,
        conversation_id: webpageId,
    }).catch(() => {});
}

// ── POST /ai/chat ────────────────────────────────────────────────────
router.post('/ai/chat', requireShareBridgeToken, publicAiLimiter, publicIpLimiter, async (req, res) => {
    const { shareId, webpageId } = req.shareBridgeClaims;
    const r = await resolveContext({ shareId, webpageId });
    if (r.error) return res.status(r.status).json({ error: r.error });
    const { ctx, grants } = r;

    const clamp = clampBody(req.body || {}, grants);
    if (clamp.error) return res.status(400).json({ error: clamp.error });

    const messages = await buildAiMessages(ctx, req.body || {}, { groundGrantKey: 'publicGroundOnPage' });
    const resolved = await resolveModelForTier(`tier:${clamp.tierName}`, { userOrgId: ctx.authorOrgId, userId: ctx.authorUserId });
    const modelId = resolved?.modelId || resolved?.model || resolved;
    if (!modelId) return res.status(500).json({ error: `No model configured for tier "${clamp.tierName}"` });

    const tierDefaults = TIER_DEFAULTS[clamp.tierName] || TIER_DEFAULTS['fast'];
    const maxTokens = Math.min(parseInt(req.body?.maxTokens, 10) || tierDefaults.maxTokens, PUBLIC_MAX_TOKENS);
    const baseOptions = {
        maxTokens,
        temperature: typeof req.body?.temperature === 'number' ? req.body.temperature : tierDefaults.temperature,
    };

    const t0 = Date.now();
    let result;
    let structured = null;

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

    logPublicUsage(ctx, webpageId, modelId, result?.usage?.prompt_tokens, result?.usage?.completion_tokens, t0);

    if (structured !== null) res.json({ json: structured });
    else res.json({ text: result.content || '' });
});

// ── POST /ai/stream ──────────────────────────────────────────────────
router.post('/ai/stream', requireShareBridgeToken, publicAiLimiter, publicIpLimiter, async (req, res) => {
    const { shareId, webpageId } = req.shareBridgeClaims;
    let ctx, grants, tierName;
    const r = await resolveContext({ shareId, webpageId });
    if (r.error) return res.status(r.status).json({ error: r.error });
    ctx = r.ctx; grants = r.grants;
    const clamp = clampBody(req.body || {}, grants);
    if (clamp.error) return res.status(400).json({ error: clamp.error });
    tierName = clamp.tierName;

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    const stopHeartbeat = startSseHeartbeat(res);
    let aborted = false;
    res.on('close', () => { aborted = true; stopHeartbeat(); });
    const send = (event, data) => {
        if (aborted) return;
        try { res.write(`event: ${event}\ndata: ${JSON.stringify(data || {})}\n\n`); } catch (_) {}
    };

    try {
        const messages = await buildAiMessages(ctx, req.body || {}, { groundGrantKey: 'publicGroundOnPage' });
        const resolved = await resolveModelForTier(`tier:${tierName}`, { userOrgId: ctx.authorOrgId, userId: ctx.authorUserId });
        const modelId = resolved?.modelId || resolved?.model || resolved;
        if (!modelId) {
            send('error', { error: `No model configured for tier "${tierName}"` });
            stopHeartbeat();
            return res.end();
        }
        const tierDefaults = TIER_DEFAULTS[tierName] || TIER_DEFAULTS['fast'];
        const maxTokens = Math.min(parseInt(req.body?.maxTokens, 10) || tierDefaults.maxTokens, PUBLIC_MAX_TOKENS);

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

        logPublicUsage(ctx, webpageId, modelId, promptTokens, completionTokens, t0);
        send('done', { prompt_tokens: promptTokens, completion_tokens: completionTokens });
        stopHeartbeat();
        res.end();
    } catch (err) {
        log.error(`[PublicShareBridge/ai/stream] ${err.message}`);
        send('error', { error: err.message });
        stopHeartbeat();
        res.end();
    }
});

module.exports = router;
