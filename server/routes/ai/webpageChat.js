/**
 * Webpage Chat — streaming AI chat scoped to a single webpage's three files.
 *
 * Mirrors notebookChat.js. Tools available:
 *   - webpage_file_read / webpage_file_write / webpage_file_replace
 *   - webpage_add_source
 *   - webpage_kb_search (when the webpage has KB sources)
 *   - agent_search (web search, when configured)
 *
 * The frontend is the source of truth for the three slot contents while a
 * chat turn is in flight: it sends html/css/js with each request and listens
 * for `webpage_doc_update` SSE events with `{ file, content }` to apply
 * tool-driven changes in real time. The server persists tool-driven changes
 * to RustFS at the END of the turn so versioning + sha256s stay in sync.
 *
 * This file keeps the request checks, the model resolution and the order of a
 * turn; the steps live in ./webpageChat/: context.js (KB grounding, slot
 * files, selection) with systemPrompt.js, messages.js (history and
 * attachments behind the Privacy Shield), toolLoop.js with tools.js and
 * validation.js (the rounds), finalize.js (persist, dependents index).
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();
const {
    getAIConfig,
    getProviderForModel,
} = require('../../core/aiAgent');
const { getAdapter } = require('../../core/providers');
const webpageStore = require('../../stores/webpageStore');
const { openSse } = require('../../core/http/sseHelpers');
const terminationStore = require('../../stores/terminationStore');
const { sanitizeError } = require('../../core/privacy/errorSanitizer');
const { emitPhase, emitPhaseEnd } = require('../../core/agentRuntime/phaseEvents');
const { resolveTurnTier } = require('../../core/llm/resolveTurnModel');
// The turn's steps, in the order the handler runs them.
const { buildTurnContext } = require('./webpageChat/context');
const { buildTurnMessages, STOP } = require('./webpageChat/messages');
const { runToolLoop } = require('./webpageChat/toolLoop');
const { finishTurn } = require('./webpageChat/finalize');

// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
const { requireAuth } = require('../../auth/permissions');
const { validate } = require('../../core/http/validate');
// The chat engine's bag: typed, not closed (see routes/ai/directChat/turnSchema.js).
const { WebpageTurnBody } = require('./directChat/turnSchema');

router.post('/chat/webpage/stream', requireAuth, validate({ body: WebpageTurnBody }), async (req, res) => {
    const {
        message, webpageId, history, modelTier, timezone, attachments,
        htmlContent, cssContent, jsContent, webpageSelection,
        planExecution, // { planId, action: 'execute' } when user approved a plan
        chatMode: rawChatMode, // 'ask' | 'auto' | 'plan'
    } = req.body;
    const userId = req.session.user.id;
    // Sanitise mode — fall back to 'auto' for unknown values.
    const chatMode = ['ask', 'auto', 'plan'].includes(rawChatMode) ? rawChatMode : 'auto';

    // Accept attachment-only turns (e.g. pasting an image with no text) — mirrors
    // the direct-chat guard. Previously an empty `message` 400'd before the SSE
    // stream opened, which the client surfaced as "Error generating response."
    // even though the image was valid (BFSF-189).
    if (!message && (!Array.isArray(attachments) || attachments.length === 0)) {
        return res.status(400).json({ error: 'Message or attachments required' });
    }
    if (!webpageId) return res.status(400).json({ error: 'Webpage ID required' });

    const webpage = await webpageStore.getWebpage(webpageId, userId);
    if (!webpage) return res.status(404).json({ error: 'Webpage not found' });

    // ── Subscription limit enforcement (mirrors /api/agents/:id/chat/stream) ──
    {
        const { checkSubscriptionLimits } = require('../../core/entitlements/limits');
        const { resolveUserOrgIds: _resolveOrgs } = require('../../auth');
        const orgIds = await _resolveOrgs(req);
        const limitOrgId = orgIds && orgIds.size > 0 ? Array.from(orgIds)[0] : null;
        const limitError = await checkSubscriptionLimits(limitOrgId, 'chat', userId);
        if (limitError) return res.status(402).json({ error: limitError });
    }

    const sources = await webpageStore.getSources(webpageId);
    const readySources = sources.filter(s => s.status === 'ready');

    // Org / EU mode resolution — cached tier-org (M2), collapses the
    // per-message getAllGroups scan to one lookup per user/~45s.
    const { getEUAwareTiers, resolveEffectiveOrgId } = require('../../core/llm/modelResolver');
    const userOrgForTiers = await resolveEffectiveOrgId(req, { userId });

    let tiers = await getEUAwareTiers({ userOrgId: userOrgForTiers, userId });

    // Which tier: core/llm/resolveTurnModel — `standard` is read as `fast`,
    // `auto` is classified, a tier the person's groups do not allow is refused.
    const turnTier = await resolveTurnTier({
        modelTier, message, tiers, userId, userOrgId: userOrgForTiers,
        surface: 'WebpageChat', standardIsFast: true,
    });
    if (turnTier.refusal) return res.status(turnTier.refusal.status).json({ error: turnTier.refusal.error, code: turnTier.refusal.code });
    const resolvedTier = turnTier.tier;

    const tier = tiers[resolvedTier] || {};
    let modelId = tier.modelId;
    if (!modelId) {
        const config = await getAIConfig();
        modelId = config.model;
        if (!modelId) throw new Error(`No model configured for tier "${resolvedTier}". Set up model tiers in Settings.`);
    }

    let config;
    let adapter;
    try {
        config = await getProviderForModel(modelId);
        adapter = getAdapter(config.providerType, (config.url || '').replace(/\/+$/, ''));
    } catch (providerErr) {
        log.error(`[WebpageChat] Provider resolution failed:`, providerErr.message);
        return res.status(400).json({ error: providerErr.message });
    }
    const apiKey = config.apiKey;
    const apiUrl = (config.url || '').replace(/\/+$/, '');
    const modelSupportsVision = typeof adapter?.supportsVision === 'function' ? adapter.supportsVision(modelId) : false;

    log.info(`[WebpageChat] Model: ${modelId} (tier: ${resolvedTier}) for webpage: "${webpage.name}" (${readySources.length} sources)`);

    // STOP: the composer's stop button aborts the browser fetch, which closes
    // this response. Without a listener the turn ran on — tool rounds and all —
    // and on a single-slot local model the next message queued behind an answer
    // nobody wanted. The keep-alive holds the stream warm through the NC AppAPI
    // proxy during long, silent webpage builds so it isn't idle-timed-out into
    // a 504 (BFSF-221).
    const { send, signal: clientSignal, isGone } = openSse(res, { heartbeat: true, tag: 'WebpageChat' });

    if (modelTier === 'auto') {
        send('model_selected', { tier: resolvedTier, modelId });
    }
    // Always emit a `model_resolved` phase so the UI can show the concrete
    // model name (e.g. "Using gpt-4o-mini") regardless of tier mode.
    emitPhase(send, 'model_resolved', modelId);
    emitPhaseEnd(send, 'model_resolved');

    try {
        // The turn's Privacy Shield: attachment scanning below, and the tool
        // block lists on the injected passages and in the tool loop (BFSF-354).
        const { resolveShieldFor: _resolveShieldFor } = require('../../core/privacy/orgShield');
        const _psShield = await _resolveShieldFor({ orgId: userOrgForTiers, userId }).catch(() => null);
        const toolPiiGate = require('../../core/privacy/toolPiiGate');
        const shieldGate = toolPiiGate.toolLoopGate({
            shield: _psShield, tag: 'WebpageChat',
            audit: (fields) => require('../../stores/guardrailEventStore').logGuardrailEvent({
                organization_id: userOrgForTiers || null, user_id: userId, conversation_id: webpageId || null,
                ...fields, source: 'webpage_chat', model: modelId || null,
            }),
        });

        const { systemPrompt, kbIds, searchAvailable, framework, html, css, js } = await buildTurnContext({
            send, webpage, message, userId, readySources, timezone, chatMode,
            htmlContent, cssContent, jsContent, webpageSelection, toolPiiGate, _psShield,
        });

        // ── Privacy Shield for attachments + response restore ──────────────
        // Webpage chat had NO PII pipeline. Mirror directChat: scan extracted
        // attachment text (tokenize PII / block per org policy) before it enters
        // the prompt, and restore tokens on the streamed reply. Token-scoped on
        // webpageId so the scan's mergeTokenMap + the un-tokeniser share a map.
        const _dlpConvId = webpageId || `wp-${require('crypto').randomUUID()}`;
        const _dlpActive = !!_psShield?.enabled;
        const messages = await buildTurnMessages({
            send, systemPrompt, planExecution, history, attachments, message,
            modelSupportsVision, adapter, modelId, config, _psShield, _dlpConvId, _dlpActive,
        });
        if (messages === STOP) return res.end();

        const loopResult = await runToolLoop({
            send, req, adapter, apiKey, apiUrl, modelId, messages, tiers, resolvedTier, clientSignal, isGone,
            webpage, webpageId, userId, userOrgForTiers, attachments, chatMode, planExecution,
            kbIds, searchAvailable, framework, html, css, js, sources, modelSupportsVision,
            shieldGate, _dlpConvId, _dlpActive,
        });

        await finishTurn({ send, webpageId, userId, ...loopResult });

        send('done', {});
        res.end();
    } catch (err) {
        // A cancelled answer is not an outage: no error event (nobody is
        // listening), and nothing logged as a termination.
        if (isGone() || err?.name === 'AbortError' || clientSignal.aborted) {
            log.info('[WebpageChat] turn cancelled by the client');
            try { if (!res.writableEnded) res.end(); } catch (_) { /* socket already gone */ }
            return;
        }
        log.error('[WebpageChat] Error:', err);
        try {
            terminationStore.logTermination({
                user_id: req.session?.user?.id || null,
                agent_id: req.body?.webpageId || null,
                agent_name: 'Webpage chat',
                source: 'webpage_chat',
                conversation_id: req.body?.webpageId || null,
                termination_type: 'error',
                ...sanitizeError(err),
            }).catch(() => {});
        } catch (_) { /* ignore logging failures */ }
        send('error', { error: `Chat error: ${err.message}` });
        res.end();
    }
});

module.exports = router;
