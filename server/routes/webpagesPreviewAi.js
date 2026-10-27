/**
 * Webpage preview AI bridge: the single-shot call (POST /:id/ai/chat, text
 * or JSON schema) and the streamed call (POST /:id/ai/stream, SSE). Both act
 * as the WEBPAGE AUTHOR. The routes, their token gate and their rate limits
 * are registered in routes/webpagesPreview.js. Split out of it; behaviour
 * unchanged.
 *
 * buildAiMessages lives in server/core/webpageAiMessages.js so the anonymous
 * public-share bridge can reuse it verbatim (with the publicGroundOnPage grant).
 */

const log = require('../telemetry/log');
const { HttpError } = require('../core/http/errors');
const { usageLogFields } = require('../core/providers/usageNormalizer');
const { loadAuthorContext } = require('../core/webpages/webpageBridgeAuth');
const llmClient = require('../core/llm/llmClient');
const { resolveModelForTier, TIER_DEFAULTS } = require('../core/llm/modelResolver');
const { buildAiMessages } = require('../core/webpages/webpageAiMessages');
const usageStore = require('../stores/usageStore');
const { openSse } = require('../core/http/sseHelpers');
const { bestEffort } = require('../utils/bestEffort');

/**
 * The tier the page asked for (or the grant's default), the model it resolves
 * to for the author, and that tier's defaults. `modelId` is falsy when the
 * tier has no model; each caller answers that in its own way.
 */
async function resolveBridgeModel(ctx, body) {
    const tierName = (body && typeof body.tier === 'string')
        ? body.tier
        : (ctx.bridgeGrants.ai.defaultTier || 'fast');
    const resolved = await resolveModelForTier(`tier:${tierName}`, { userOrgId: ctx.authorOrgId, userId: ctx.authorUserId });
    const modelId = resolved?.modelId || resolved?.model || resolved;
    const tierDefaults = TIER_DEFAULTS[tierName] || TIER_DEFAULTS['fast'];
    const maxTokens = Math.min(parseInt(body?.maxTokens, 10) || tierDefaults.maxTokens, 16384);
    return { tierName, modelId, tierDefaults, maxTokens };
}

/** The author's context, or a 404/403 already sent (returns null). */
async function loadAiContext(webpageId, res) {
    const ctx = await loadAuthorContext(webpageId);
    if (!ctx) { res.status(404).json({ error: 'Webpage not found' }); return null; }
    if (!ctx.bridgeGrants.ai.enabled) { res.status(403).json({ error: 'AI bridge is disabled for this webpage' }); return null; }
    return ctx;
}

// Structured-output mode: force a single tool call against the user's
// JSON Schema. Universal across providers — anything that supports
// tool calling can satisfy the schema, no native json_schema needed.
async function chatStructured(modelId, messages, baseOptions, schema) {
    const schemaTool = {
        type: 'function',
        function: {
            name: 'return_structured_output',
            description: 'Return the answer as structured JSON matching the provided schema. Call this tool exactly once.',
            parameters: schema,
        },
    };
    // The forced choice is provider-shaped: the OpenAI object form
    // for the cloud adapters, 'required' for Google and for every
    // self-hosted runtime — llama-server reads the object form as
    // "auto" (core/llm/llmClient.forcedToolChoice).
    const result = await llmClient.chat(modelId, messages, {
        ...baseOptions,
        tools: [schemaTool],
        toolChoice: await llmClient.forcedToolChoiceFor(modelId, 'return_structured_output'),
    });
    let structured = null;
    const call = (result.toolCalls || []).find(tc => tc?.function?.name === 'return_structured_output')
        || (result.toolCalls || [])[0];
    if (call) {
        try {
            const raw = call.function?.arguments;
            structured = typeof raw === 'string' ? JSON.parse(raw) : (raw || null);
        } catch (_) { structured = null; }
    }
    if (structured === null) {
        throw new HttpError(502, 'ai_unusable', 'Model did not return valid structured output');
    }
    return { result, structured };
}

function logBridgeUsage(ctx, webpageId, modelId, fields, t0) {
    usageStore.logUsage({
        user_id: ctx.authorUserId,
        organization_id: ctx.authorOrgId,
        agent_id: webpageId,
        agent_name: `Webpage: ${ctx.webpage.name || 'Untitled'}`,
        agent_type: 'webpage_bridge',
        model: modelId,
        ...fields,
        duration_ms: Date.now() - t0,
        source: 'webpage_bridge_ai',
        conversation_id: webpageId,
    }).catch((e) => bestEffort('routes/webpagesPreviewAi:logBridgeUsage', e));
}

// POST /:id/ai/chat
async function chat(req, res) {
    const { webpageId } = req.previewClaims;
    const ctx = await loadAiContext(webpageId, res);
    if (!ctx) return;

    const messages = await buildAiMessages(ctx, req.body || {});
    const { tierName, modelId, tierDefaults, maxTokens } = await resolveBridgeModel(ctx, req.body);
    if (!modelId) throw new HttpError(500, 'no_model', `No model configured for tier "${tierName}"`);

    const baseOptions = {
        maxTokens,
        temperature: typeof req.body?.temperature === 'number' ? req.body.temperature : tierDefaults.temperature,
    };

    const t0 = Date.now();
    let result;
    let structured = null;
    if (req.body && req.body.schema && typeof req.body.schema === 'object') {
        ({ result, structured } = await chatStructured(modelId, messages, baseOptions, req.body.schema));
    } else {
        result = await llmClient.chat(modelId, messages, baseOptions);
    }

    logBridgeUsage(ctx, webpageId, modelId, usageLogFields(result?.usage), t0);

    if (structured !== null) {
        res.json({ json: structured });
    } else {
        res.json({ text: result.content || '' });
    }
}

// POST /:id/ai/stream
async function stream(req, res) {
    const { webpageId } = req.previewClaims;
    const ctx = await loadAiContext(webpageId, res);
    if (!ctx) return;

    // Prevents a thinking-model silence from tripping an upstream gateway's
    // idle-connection drop (the same failure mode fixed for the automation
    // builder stream — see startSseHeartbeat's usage there).
    // isGone() turns true once the client disconnects. The underlying LLM fetch isn't
    // cancellable yet (the provider adapters don't accept an abort signal —
    // see webpageRuntimeManager's sibling design note), so this only stops us
    // writing to a dead socket; it doesn't cut short the in-flight request.
    const { send: sendEvent, isGone, stopHeartbeat } = openSse(res, { heartbeat: true });
    const send = (event, data) => {
        if (isGone()) return;
        sendEvent(event, data || {});
    };

    try {
        const messages = await buildAiMessages(ctx, req.body || {});
        const { tierName, modelId, tierDefaults, maxTokens } = await resolveBridgeModel(ctx, req.body);
        if (!modelId) {
            send('error', { error: `No model configured for tier "${tierName}"` });
            stopHeartbeat();
            return res.end();
        }

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

        logBridgeUsage(ctx, webpageId, modelId, {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
        }, t0);

        send('done', { prompt_tokens: promptTokens, completion_tokens: completionTokens });
        stopHeartbeat();
        res.end();
    } catch (err) {
        log.error(`[WebpagesPreview/ai/stream] ${err.message}`);
        send('error', { error: err.message });
        stopHeartbeat();
        res.end();
    }
}

module.exports = { chat, stream, resolveBridgeModel, loadAiContext };
