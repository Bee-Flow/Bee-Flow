// @typecheck
/** @typedef {import('../../core/providers/base')} BaseProvider */
/**
 * CMS Builder — conversational SSE endpoint (trimmed clone of
 * routes/ai/appStudioBuilder.js for CMS page building).
 *
 *   POST /stream            mounted at /api/cms/builder in server/index.js
 *   GET  /session/:siteId   (BEFORE /api/cms so the specific prefix wins)
 *
 * Body: { message, siteId (required), builderSessionId?, modelTier='auto',
 *         context? ({activePageId, activeBlockId, activeLocale}), timezone? }
 *
 * Every mutating tool persists through stores/cmsStore immediately (there is
 * no finalize step), so a refresh recovers the site via the normal CMS admin
 * routes and the chat via GET /session/:siteId.
 *
 * SESSIONS ARE SITE-SCOPED AND SHARED BETWEEN ADMINS — the CMS admin surface
 * is a shared editing space (unlike the owner-scoped studio-app sessions):
 * any admin resuming the builder for a site sees the same conversation.
 *
 * SSE EVENT CONTRACT (FROZEN — the frontend is built against exactly these):
 *   builder_session   { sessionId, siteId }
 *   model_selected    { modelId, tier }
 *   thinking_start {} / thinking { delta } / thinking_stop {}
 *   message           { content }                     — assistant prose deltas
 *   tool_call         { name, label, ok, summary }
 *   draft             { siteId, kind:'site', site }   — after site-index mutations
 *   draft             { siteId, kind:'page', pageId, page } — after page mutations
 *   validation_errors { errors, warnings }
 *   usage             { inputTokens, outputTokens }
 *   done              { siteId, createdPageIds, touchedPageIds }
 *   error             { message, code }               — code ∈ subscription_limit |
 *       rate_limited | model_unavailable | transient_upstream | budget_exhausted |
 *       internal
 *
 * OBSERVABILITY: every turn logs ONE usageStore.logUsage row (agent_type
 * 'cms_builder', agent_id=siteId, conversation_id=sessionId, stop_reason=
 * outcome) and ships the full per-turn metadata as a structured stdout line
 * ("[CmsBuilder] usage {...}") → OpenObserve. Each SSE `error` additionally
 * emits a structured stderr line keyed by its taxonomy code.
 *
 * PROMPT-CACHE DISCIPLINE (mirrors appStudioBuilder.js): the system prompt
 * (instructions + block catalogue) is byte-stable across turns; the live
 * site state travels in ONE LATE role:'user' machine message each turn
 * (renderDraftState + the editor-context line) so provider prefix caches
 * keep hitting while the user iterates.
 */
const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();
const cmsStore = require('../../stores/cmsStore');
const usageStore = require('../../stores/usageStore');
const { getProviderForModel, getAIConfig } = require('../../core/aiAgent');
const { getAdapter } = require('../../core/providers');
const { getUserTierMap } = require('../../core/llm/modelResolver');
const { getPermittedTierKeys } = require('../../core/entitlements/userTiers');
const { isTransientChatError, applyBuilderTierFloor, streamWithRetry: sharedStreamWithRetry } = require('../../usecases/ai/builderShared');
const { perUserRateLimit } = require('../../utils/perUserRateLimit');
const { openSse } = require('../../core/http/sseHelpers');
const {
    VALIDATION_NOTE_PREFIX, DRAFT_STATE_PREFIX, EDITOR_CONTEXT_PREFIX, BLOCK_FEEDBACK_PREFIX,
    renderValidationNote, renderBlockFeedbackNote, sanitizeEditorContext,
    renderEditorContextNote, sanitizeHistory, labelForTool, summariseToolResult, parseToolArgs, truncateJson,
} = require('../../usecases/ai/cmsBuilderMessages');
// The same admin gate + siteId validation the CMS CRUD routes use — the
// builder must never be reachable below the admin bar.
const { requireAdmin, SITE_ID_RE } = require('../cmsShared');
const { validate } = require('../../core/http/validate');
const { z, worded, bodyOf, closedObject, typeError } = require('../../core/http/schemaParts');
const { bestEffort } = require('../../utils/bestEffort');
const { selectTurnModel } = require('../../usecases/ai/cmsBuilder/modelSelection');
const { loadSiteDraft, runBuilderTurn, logTurnUsage } = require('../../usecases/ai/cmsBuilder/builderTurn');

// ── What a caller may send ───────────────────────────────────────────
// The body keys the builder reads, and nothing else: a misspelled
// `modelTeir` used to run the turn on `auto` under a 200, and a misspelled
// `contxt` dropped what the person was looking at without a word. The value
// checks the handler made by hand are the schema's now, in the same words.
const SITE_TEXT = 'Valid siteId required';
const siteId = worded(SITE_TEXT).regex(SITE_ID_RE, SITE_TEXT);
const SessionParams = closedObject({ siteId: worded('Invalid siteId format').regex(SITE_ID_RE, 'Invalid siteId format') }, 'This address');
const StreamBody = bodyOf({
    message: worded('Message required').refine((m) => m.trim().length > 0, 'Message required'),
    siteId,
    builderSessionId: worded('builderSessionId is the id the previous turn handed back.').max(200, 'builderSessionId is at most 200 characters.').nullish(),
    modelTier: worded('modelTier is the name of a model tier.').max(100, 'modelTier is at most 100 characters.').optional(),
    // Accepted for parity with the other builders; pages carry no time semantics.
    timezone: worded('timezone is a zone name, like Europe/Amsterdam.').max(100, 'timezone is at most 100 characters.').optional(),
    // Whitelisted and bounded further by sanitizeEditorContext.
    context: z.record(z.string(), z.unknown(), { error: typeError({ invalid: "context is the editor's focus, an object." }) }).nullish(),
}, 'A builder turn');

// Each builder turn is a multi-iteration LLM conversation chaining many tool
// calls — expensive. Same ceiling as the other builders: 12/min/user.
const builderRateLimit = perUserRateLimit({ windowMs: 60_000, max: 12 });

// GET the persisted builder-session snapshot for a site. Used by the client
// on mount to rehydrate chat history + validation state after a refresh or
// SSE drop. Site-scoped and shared between admins (see the file header).
router.get('/session/:siteId', requireAdmin, validate({ params: SessionParams }), async (req, res) => {
    const { siteId } = req.params;
    if (!siteId || !SITE_ID_RE.test(siteId)) {
        return res.status(400).json({ error: 'Invalid siteId format' });
    }
    const project = await cmsStore.getProject(siteId);
    if (!project) return res.status(404).json({ error: 'Site not found' });
    const snapshot = await cmsStore.getBuilderSession(siteId);
    if (!snapshot) return res.status(404).json({ error: 'No builder session for this site' });
    res.json({ snapshot });
});

/** The model plumbing selectTurnModel asks; the classifier is loaded when a turn needs it. */
const MODEL_SELECTION = {
    getUserTierMap,
    getPermittedTierKeys,
    getAIConfig,
    classify: (message, tiers, who) => require('../../core/llm/promptClassifier').classifyWithLLM(message, tiers, who),
};

/**
 * What is wrong with the message or the site id, in the schema's own words.
 * @param {unknown} message
 * @param {unknown} siteId
 */
function inputRefusal(message, siteId) {
    if (!message || !String(message).trim()) return 'Message required';
    if (!siteId || typeof siteId !== 'string' || !SITE_ID_RE.test(siteId)) return 'Valid siteId required';
    return null;
}

/**
 * The organisation a turn counts against: the caller's first one.
 * @param {Set<string> | null | undefined} orgIds
 */
const firstOrgOf = (orgIds) => (orgIds && orgIds.size > 0 ? Array.from(orgIds)[0] : null);

/**
 * The tier, model, provider and adapter of the turn, or `refusal` when none
 * can be resolved (no model configured, no provider that serves it).
 * @param {import('../../usecases/ai/cmsBuilder/modelSelection').ModelRequest} request
 */
async function resolveTurnModel(request) {
    try {
        const selected = await selectTurnModel(request, MODEL_SELECTION);
        if ('refusal' in selected) return selected;
        const cfg = await getProviderForModel(selected.modelId);
        /** @type {BaseProvider} */
        const adapter = getAdapter(cfg.providerType, cfg.url);
        return { ...selected, cfg, adapter };
    } catch (e) {
        return { refusal: /** @type {Error} */ (e).message };
    }
}

router.post('/stream', requireAdmin, builderRateLimit, validate({ body: StreamBody }), async (req, res) => {
    const userId = req.session.user.id;
    // Wall-clock start of the turn: feeds the usage row's duration_ms and
    // the structured observability line. Set before any SSE so a turn that
    // dies mid-stream still reports a real duration.
    const turnStartedAt = Date.now();
    // timezone is accepted for parity with the other builders; pages carry no time semantics.
    const { message, siteId, builderSessionId: clientSession, modelTier = 'auto' } = req.body || {};
    // Editor context (what the user is looking at): whitelisted and bounded,
    // rendered as a machine message after the draft state (never persisted).
    const editorContext = sanitizeEditorContext(req.body?.context);

    const refused = inputRefusal(message, siteId);
    if (refused) return res.status(400).json({ error: refused });

    // Everything up to openSse answers in clean JSON: the subscription limit
    // (402, the same shape as appStudioBuilder), a site that does not exist
    // (404) and a model that cannot be resolved (400).
    const { checkSubscriptionLimits } = require('../../core/entitlements/limits');
    const { resolveUserOrgIds } = require('../../auth');
    const limitOrgId = firstOrgOf(await resolveUserOrgIds(req));
    const limitError = await checkSubscriptionLimits(limitOrgId, 'chat', userId);
    if (limitError) return res.status(402).json({ error: limitError, code: 'subscription_limit' });

    const orgId = req.session?.user?.organizationId || limitOrgId || null;
    const loaded = await loadSiteDraft({ siteId, userId, orgId, clientSession });
    if (!loaded) return res.status(404).json({ error: 'Site not found' });
    const { draftWrap, priorSnapshot } = loaded;

    const model = await resolveTurnModel({ modelTier, message, userId, userOrgId: orgId, session: req.session });
    if ('refusal' in model) return res.status(400).json({ error: model.refusal, code: 'model_unavailable' });

    // SSE from here on. flushHeaders and the 10s heartbeat are REQUIRED: a
    // thinking model can go silent for 30–60s and an idle gateway would
    // otherwise drop the stream into a false 504.
    const { send, stopHeartbeat } = openSse(res, { heartbeat: true, flush: true });

    // SSE `error` carries a machine `code` AND leaves a structured stderr
    // line (shipped to OpenObserve via stdout — no monitoring tables).
    /**
     * @param {string} code
     * @param {string} userMessage
     */
    const sendError = (code, userMessage) => {
        send('error', { message: userMessage, code });
        log.error(`[CmsBuilder] code=${code} siteId=${siteId} session=${draftWrap.builderSessionId || '-'} model=${model.modelId || '-'}`);
    };

    // The counters live on the turn, not inside runBuilderTurn, so a turn
    // that blew up still logs what it used.
    const turn = {
        siteId, userId, message, turnStartedAt, editorContext, draftWrap, priorSnapshot, model, send, sendError, res,
        usageTotals: { inputTokens: 0, outputTokens: 0 },
        iter: 0, toolCallCount: 0, mutatingToolCalls: 0, validationErrorCount: 0, usageLogged: false,
    };
    try {
        await runBuilderTurn(turn, { usageStore, streamWithRetry });
        stopHeartbeat();
        res.end();
    } catch (e) {
        log.error('[cmsBuilder/stream] error:', e);
        sendError('internal', /** @type {Error} */ (e).message);
        // Still record the turn's usage: a turn that died mid-stream burned
        // tokens too. logTurnUsage writes one row per turn, so a done-path
        // row that already ran wins.
        try { logTurnUsage(turn, 'internal', usageStore); } catch (err) { bestEffort('routes/ai/cmsBuilder:anon#3', err); /* never block cleanup */ }
        stopHeartbeat();
        res.end();
    }
});

// THIS route's SSE thinking shapes: no partId on start/stop; deltas go out
// as { delta } (the frontend renders a single rolling thinking bubble).
const CMS_SSE_THINKING = {
    start: (send) => send('thinking_start', {}),
    delta: (send, { text }) => send('thinking', { delta: text }),
    stop: (send) => send('thinking_stop', {}),
};

// Retry/assembly shell shared with the other builders (builderShared.js);
// this wrapper pins the route's thinking emitter and log prefix.
/**
 * @param {BaseProvider} adapter
 * @param {string} modelId
 */
function streamWithRetry(adapter, cfg, modelId, messages, options, opts = {}) {
    return sharedStreamWithRetry(adapter, cfg, modelId, messages, options, {
        emitThinking: CMS_SSE_THINKING,
        logPrefix: '[CmsBuilder]',
        ...opts,
    });
}

// Internals exposed for unit tests (server/routes/ai/cmsBuilder.test.js).
module.exports = Object.assign(router, {
    _test: {
        parseToolArgs,
        isTransientChatError,
        streamWithRetry,
        applyBuilderTierFloor,
        sanitizeHistory,
        sanitizeEditorContext,
        renderEditorContextNote,
        renderValidationNote,
        renderBlockFeedbackNote,
        summariseToolResult,
        labelForTool,
        truncateJson,
        VALIDATION_NOTE_PREFIX,
        DRAFT_STATE_PREFIX,
        EDITOR_CONTEXT_PREFIX,
        BLOCK_FEEDBACK_PREFIX,
    },
});

/**
 * @typedef {import('express').Router & { _test: Record<string, unknown> }} RouterExports
 */
