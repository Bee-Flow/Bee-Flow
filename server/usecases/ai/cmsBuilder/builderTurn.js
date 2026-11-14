// @typecheck strict
/**
 * CMS builder: one turn around its rounds (./turnLoop.js). Loads the site
 * draft before the stream opens; once it is open, announces the session and
 * the model, runs the rounds, stores the session snapshot, writes the turn's
 * one usage row and sends `done`.
 *
 * The usage store and the model stream come from the route
 * (routes/ai/cmsBuilder.js).
 */

'use strict';

const log = require('../../../telemetry/log');
const cmsStore = require('../../../stores/cmsStore');
const { usageTotalsLogFields } = require('../../../core/providers/usageNormalizer');
const { TOOL_SCHEMAS } = require('../../../cmsBuilder/builderTools');
const { buildSystemPrompt } = require('../../../cmsBuilder/builderPrompt');
const { getProfileForModel } = require('../../../cmsBuilder/builderModelProfiles');
const { onClientGone } = require('../../../core/http/sseHelpers');
const { renderDraftStateNote, sanitizeHistory } = require('../cmsBuilderMessages');
const { fallback, bestEffort, ignoreGone } = require('../../../utils/bestEffort');
const { runRounds } = require('./turnLoop');

/**
 * @typedef {import('./turnLoop').BuilderTurn} LoopTurn
 * @typedef {import('./turnLoop').TurnLoop} TurnLoop
 * @typedef {import('./turnLoop').Message} Message
 * @typedef {import('../../../cmsBuilder/builderTools').DraftWrap} DraftWrap
 * @typedef {{ sessionId?: string, messages?: unknown } | null} SessionSnapshot
 * @typedef {LoopTurn & {
 *   message: unknown, turnStartedAt: number, priorSnapshot: SessionSnapshot,
 *   editorContext: import('../cmsBuilderMessages').EditorContext | null,
 *   res: { writableEnded?: boolean, on: (event: string, listener: () => void) => unknown },
 *   validationErrorCount: number, usageLogged: boolean,
 * }} BuilderTurn
 * @typedef {{ logUsage: (row: Record<string, unknown>) => unknown }} UsageStore
 */

// Hard ceiling on rounds per turn regardless of profile. Pages are much
// cheaper to assemble than app trees: 16 is plenty.
const MAX_ITERATIONS = 16;

/**
 * The site draft the turn works on and the stored builder session, or null
 * when the site does not exist. getAdminPayload reads the SiteDoc, every
 * PageDoc and the locale overrides fresh: the builder needs
 * read-your-writes like the panel.
 * @param {{ siteId: string, userId: string, orgId: string | null, clientSession?: string | null }} input
 * @returns {Promise<{ draftWrap: DraftWrap, priorSnapshot: SessionSnapshot } | null>}
 */
async function loadSiteDraft({ siteId, userId, orgId, clientSession }) {
    const project = await cmsStore.getProject(siteId);
    if (!project) return null;
    /** @type {SessionSnapshot} */
    const priorSnapshot = await cmsStore.getBuilderSession(siteId).catch((/** @type {unknown} */ e) => fallback('routes/ai/cmsBuilder:anon', e, null));
    const payload = await cmsStore.getAdminPayload(siteId);
    const locales = new Set(Object.keys(payload.localeOverrides?.siteByLocale || {}));
    for (const perPage of Object.values(payload.localeOverrides?.pagesByLocale || {})) {
        for (const loc of Object.keys(perPage || {})) locales.add(loc);
    }
    /** @type {DraftWrap} */
    const draftWrap = {
        siteId,
        userId,
        orgId: /** @type {string} */ (orgId),
        builderSessionId: clientSession || priorSnapshot?.sessionId || `cms_${Date.now().toString(36)}`,
        site: payload.site,
        pages: new Map((payload.pages || []).map((/** @type {import('../../../stores/cms/shared').PageDoc} */ p) => [p.id, p])),
        defaultLocale: payload.defaultLocale || 'en',
        locales: [...locales].sort(),
        createdPageIds: [],
        touchedPageIds: new Set(),
    };
    return { draftWrap, priorSnapshot };
}

/**
 * Writes the turn's usage row, once: the done path and the failure path may
 * both ask. ai_usage_log has no metadata column, so the identifying fields
 * go into real columns (agent_id = site, conversation_id = session,
 * stop_reason = outcome) and the full metadata into one structured log line.
 * Fire-and-forget: usage logging never breaks a turn.
 * @param {BuilderTurn} turn
 * @param {string} outcome
 * @param {UsageStore} usageStore
 */
function logTurnUsage(turn, outcome, usageStore) {
    if (turn.usageLogged) return;
    turn.usageLogged = true;
    const { siteId, draftWrap } = turn;
    const durationMs = Date.now() - turn.turnStartedAt;
    const metadata = {
        siteId,
        sessionId: draftWrap.builderSessionId,
        tier: turn.model.resolvedTier,
        iterations: turn.iter,
        toolCallCount: turn.toolCallCount,
        mutatingToolCalls: turn.mutatingToolCalls,
        validationErrorCount: turn.validationErrorCount,
        createdPages: draftWrap.createdPageIds.length,
        touchedPages: draftWrap.touchedPageIds.size,
        outcome,
        durationMs,
    };
    Promise.resolve(
        usageStore.logUsage({
            user_id: turn.userId,
            organization_id: draftWrap.orgId || null,
            agent_id: siteId,
            agent_name: `CMS builder: ${draftWrap.site?.name || 'Untitled site'}`,
            agent_type: 'cms_builder',
            model: turn.model.modelId,
            ...usageTotalsLogFields(turn.usageTotals),
            duration_ms: durationMs,
            source: 'cms_builder',
            conversation_id: draftWrap.builderSessionId || siteId,
            stop_reason: outcome,
        }),
    ).catch((e) => log.error('[CmsBuilder] usage log failed (non-fatal):', e.message));
    log.info(`[CmsBuilder] usage ${JSON.stringify(metadata)}`);
}

/**
 * What the rounds start from. The live site state travels in ONE late
 * role:'user' machine message (never in the cached system prompt), with the
 * editor-context line inside it. The prior conversation comes from the
 * stored snapshot, machine notes stripped: the client does not resend it.
 * @param {BuilderTurn} turn
 * @param {Message[]} history
 * @returns {TurnLoop}
 */
function startLoop(turn, history) {
    const profile = getProfileForModel(turn.model.modelId);
    /** @type {Message[]} */
    const messages = [
        { role: 'system', content: buildSystemPrompt() },
        ...history,
        { role: 'user', content: renderDraftStateNote(turn.draftWrap, turn.editorContext) },
        { role: 'user', content: String(turn.message) },
    ];
    const iterationBudget = Math.min(profile.maxIterations || MAX_ITERATIONS, MAX_ITERATIONS);

    // The loop stops the moment the client disconnects. The flag ends the
    // LOOP; the signal ends the request in flight, which frees a single-slot
    // local model instead of leaving it generating an answer nobody reads.
    const client = { gone: false, abort: new AbortController() };
    onClientGone(turn.res, () => {
        client.gone = true;
        try { client.abort.abort(); } catch (err) { ignoreGone('routes/ai/cmsBuilder:abortOnClose', err); }
    });
    return {
        messages, profile, iterationBudget, client, tools: TOOL_SCHEMAS,
        lastValidation: null, escalateNextRound: false, streamFailed: false, sawFinalProse: false, proseParts: [],
    };
}

/**
 * The session snapshot for rehydration (site-scoped, shared between admins;
 * the store trims it past 64 KB, oldest messages first). A failure to store
 * it does not end the turn.
 * @param {BuilderTurn} turn
 * @param {TurnLoop} loop
 * @param {Message[]} history
 */
async function storeSession(turn, loop, history) {
    const { siteId } = turn;
    try {
        const conversationTail = [
            ...history,
            { role: 'user', content: String(turn.message) },
            ...(loop.proseParts.length ? [{ role: 'assistant', content: loop.proseParts.join('') }] : []),
        ].slice(-40);
        await cmsStore.setBuilderSession(siteId, {
            sessionId: turn.draftWrap.builderSessionId,
            siteId,
            messages: conversationTail,
            lastValidation: loop.lastValidation || null,
            updatedAt: new Date().toISOString(),
            lastTier: turn.model.resolvedTier,
        });
    } catch (err) { bestEffort('routes/ai/cmsBuilder:anon#2', err); /* non-fatal */ }
}

/**
 * @param {TurnLoop} loop
 * @param {boolean} budgetExhausted
 */
function outcomeOf(loop, budgetExhausted) {
    if (loop.streamFailed) return 'transient_upstream';
    if (budgetExhausted) return 'budget_exhausted';
    return loop.client.gone ? 'client_disconnected' : 'completed';
}

/**
 * The turn on its open stream, up to and including `done`.
 * @param {BuilderTurn} turn
 * @param {{ usageStore: UsageStore, streamWithRetry: import('./turnLoop').StreamWithRetry }} deps
 */
async function runBuilderTurn(turn, deps) {
    const { send, siteId, draftWrap } = turn;
    send('builder_session', { sessionId: draftWrap.builderSessionId, siteId });
    send('model_selected', { modelId: turn.model.modelId, tier: turn.model.resolvedTier });

    const history = sanitizeHistory(turn.priorSnapshot?.messages);
    const loop = startLoop(turn, history);
    await runRounds(turn, loop, deps.streamWithRetry);

    // The budget ran out before the model wrapped up. Everything it built is
    // already persisted (the tools write through), so this is informational:
    // the user sends another message to continue.
    const budgetExhausted = !loop.sawFinalProse && !loop.streamFailed && !loop.client.gone && turn.iter >= loop.iterationBudget;
    if (budgetExhausted) {
        turn.sendError('budget_exhausted', 'I ran out of build turns — everything so far is saved. Send another message and I\'ll keep going.');
    }

    await storeSession(turn, loop, history);

    turn.validationErrorCount = Array.isArray(loop.lastValidation?.errors) ? loop.lastValidation.errors.length : 0;
    logTurnUsage(turn, outcomeOf(loop, budgetExhausted), deps.usageStore);

    send('done', {
        siteId,
        createdPageIds: draftWrap.createdPageIds,
        touchedPageIds: [...draftWrap.touchedPageIds],
    });
}

module.exports = { loadSiteDraft, runBuilderTurn, logTurnUsage };
