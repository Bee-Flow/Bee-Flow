// @typecheck
/**
 * The participation engine: when a human writes in a conversation whose AI
 * mode is `auto`, decide — later, quietly, cheaply — whether the AI joins.
 *
 *   1. onHumanMessage (post path, cheap): the pre-gate rules (preGate.js). A
 *      message that passes starts or pushes back the debounced `quiet` watch;
 *      one that does not still pushes an existing watch back, because people
 *      are talking. A reply by another member closes an open `unanswered`
 *      watch. An explicit request (@ai, "Ask AI") cancels the quiet watch: the
 *      AI is answering anyway.
 *   2. processWatch (background job): re-reads the conversation, re-runs the
 *      rules with the caps and the turn lock, checks the subscription limit,
 *      reserves the ONE gate call for this exact state, asks the relevance
 *      gate, and then answers, defers to people (`unanswered` watch) or stays
 *      silent. Every outcome is one row in project_ai_decisions, as codes.
 *
 * ── Surfaces ────────────────────────────────────────────────────────────────
 *
 * A surface is a kind of conversation: `chat` (team chats, registered by
 * index.js) and `comment` (comment threads, registered by their owner). An
 * adapter provides:
 *
 *   lockType                     the conversation_turn_locks type
 *   loadContext(containerId, { light })
 *                             →  { projectId, orgId, aiMode, closed,
 *                                  autoPausedUntil?, title?, extraContext?,
 *                                  memberCount?, readByOthers?(message),
 *                                  messages: [{ id, seq, authorKind,
 *                                    authorUserId, text, createdAt, replyTo,
 *                                    mentionsAi, mentionsHuman }] } | null
 *                                  `light: true` asks for what the rules
 *                                  read (the post path, the stale check):
 *                                  the adapter may then leave out
 *                                  `extraContext`, which only an answer uses
 *                                  and which can cost a whole-document read.
 *   answer?(job)              →  { status, messageId? }   writes the answer itself
 *   postAnswer?(p)            →  { messageId } | { stale: true } | null
 *                                  (the engine writes the answer, answerWriter.js)
 *
 * ── Failing ─────────────────────────────────────────────────────────────────
 *
 * Silent. Neither function throws; nothing here publishes an event or an
 * error. A failure is a decision row with a skip reason and a log line with
 * ids and codes, never content. Repeated gate failures open a circuit breaker
 * (the disclosureClassifier pattern), during which the job claims nothing and
 * the watches wait.
 */

'use strict';

const crypto = require('crypto');
const log = require('../../telemetry/log');
const { preGate, SKIP } = require('./preGate');
const { gateLinesFrom } = require('./relevanceGate');
const { thresholdFor } = require('./policy');

const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 30_000;
/** Gate failures that say something about the model, not about this conversation. */
const BREAKER_FAILURES = Object.freeze(['timeout', 'error', 'unparseable', 'model_unavailable']);

/**
 * @param {object} deps
 * @param {object}   deps.store          stores/projectAiParticipationStore surface
 * @param {object}   deps.policy         policy.makePolicy() surface
 * @param {Function} deps.gate           relevanceGate.makeRelevanceGate() result
 * @param {Function} [deps.checkLimits]  (limitOrgId, userId) => error text | null
 * @param {Function} [deps.isLockHeld]   (containerId) => boolean
 * @param {object}   [deps.writer]       answerWriter.makeAnswerWriter() surface
 * @param {() => number} [deps.now]
 * @param {() => string} [deps.newId]
 */
function makeParticipationEngine(deps) {
    const { store, policy, gate } = deps;
    const checkLimits = deps.checkLimits
        || ((limitOrgId, userId) => require('../../core/entitlements/limits').checkSubscriptionLimits(limitOrgId, 'chat', userId));
    const isLockHeld = deps.isLockHeld
        || (async (containerId) => !!(await require('../../stores/conversationLockStore').getTurn(containerId)));
    const writer = () => deps.writer || require('./answerWriter').defaultAnswerWriter();
    const now = deps.now || (() => Date.now());
    const newId = deps.newId || (() => crypto.randomUUID());

    /** @type {Map<string, any>} */
    const surfaces = new Map();
    let failures = 0;
    let openUntil = 0;

    /**
     * @param {string} name
     * @param {{ lockType: string, loadContext: Function, answer?: Function, postAnswer?: Function }} adapter
     */
    function registerSurface(name, adapter) {
        if (!['chat', 'comment'].includes(name)) throw new Error(`Unknown participation surface "${name}"`);
        if (!adapter || typeof adapter.loadContext !== 'function' || typeof adapter.lockType !== 'string') {
            throw new Error(`The "${name}" surface needs lockType and loadContext()`);
        }
        if (typeof adapter.answer !== 'function' && typeof adapter.postAnswer !== 'function') {
            throw new Error(`The "${name}" surface needs answer() or postAnswer()`);
        }
        surfaces.set(name, adapter);
    }

    const breakerOpen = () => now() < openUntil;
    function noteGate(result) {
        if (!result.available && BREAKER_FAILURES.includes(result.skipReason)) {
            failures += 1;
            if (failures >= BREAKER_THRESHOLD && !breakerOpen()) {
                openUntil = now() + BREAKER_COOLDOWN_MS;
                log.warn(`[AiParticipation] gate failed ${failures}x in a row; pausing for ${BREAKER_COOLDOWN_MS} ms`);
            }
        } else if (result.available) {
            failures = 0;
            openUntil = 0;
        }
    }

    /** The organisation whose policy applies: the project's, else the poster's. */
    const policyOrg = (ctx, fallback) => (ctx && ctx.orgId) || fallback || null;

    /**
     * A human message was stored. Never throws.
     *
     * @param {{ surface: string, containerId: string, messageId: string, authorUserId: string,
     *           orgId?: string|null, limitOrgId?: string|null, projectId?: string, explicit?: boolean }} p
     * @returns {Promise<{ watched: boolean, reason?: string }>}
     */
    async function onHumanMessage({ surface, containerId, messageId, authorUserId, orgId = null, limitOrgId = null, explicit = false }) {
        try {
            const adapter = surfaces.get(surface);
            if (!adapter) return { watched: false, reason: 'surface_unavailable' };
            if (explicit) await store.cancelPending(surface, containerId, 'quiet');

            const ctx = await adapter.loadContext(containerId, { light: true });
            if (!ctx) return { watched: false, reason: 'container_gone' };
            const message = (ctx.messages || []).find((m) => m.id === messageId);

            // Somebody else writing (or replying to the question) answers it.
            const open = await store.getPendingWatch(surface, containerId, 'unanswered');
            if (open && message && (message.authorUserId !== open.authorUserId || message.replyTo === open.messageId)) {
                await store.cancelPending(surface, containerId, 'unanswered');
            }
            if (explicit) return { watched: false, reason: SKIP.EXPLICIT };
            if (ctx.aiMode !== 'auto') return { watched: false, reason: SKIP.MODE };

            const orgPolicy = await policy.resolveOrgPolicy(policyOrg(ctx, orgId));
            const pref = await policy.resolveUserPreference(authorUserId);
            const caps = await store.capsFor({ surface, containerId, projectId: ctx.projectId, orgId: policyOrg(ctx, orgId) });
            const verdict = preGate({
                stage: 'post',
                triggerKind: 'quiet',
                now: now(),
                surface,
                mode: ctx.aiMode,
                closed: !!ctx.closed,
                pausedUntil: ctx.autoPausedUntil || null,
                policy: orgPolicy,
                authorOptedOut: !pref.autoJoinOnMyMessages,
                message,
                recent: ctx.messages || [],
                caps,
            });
            const delays = { delaySeconds: orgPolicy.quietSeconds, maxDelaySeconds: orgPolicy.maxDebounceSeconds };
            if (!verdict.ok) {
                // People are still talking: an earlier watch waits for them.
                await store.postponeWatch({ surface, containerId, kind: 'quiet', ...delays });
                return { watched: false, reason: verdict.reason };
            }
            await store.upsertWatch({
                projectId: ctx.projectId,
                surface,
                containerId,
                messageId,
                authorUserId,
                orgId,
                limitOrgId,
                kind: 'quiet',
                ...delays,
            });
            return { watched: true };
        } catch (err) {
            // Codes only: an error from deeper down may quote what it was handling.
            log.warn(`[AiParticipation] ${surface} ${containerId}: message ${messageId} not considered: ${err?.code || err?.name || 'error'}`);
            return { watched: false, reason: 'error' };
        }
    }

    /** The mode changed away from `auto`, or the container is gone: nothing stays queued. */
    async function cancelContainer(surface, containerId) {
        try {
            return await store.cancelPending(surface, containerId);
        } catch (err) {
            log.warn(`[AiParticipation] ${surface} ${containerId}: pending watches not cancelled: ${err && err.message}`);
            return 0;
        }
    }

    /**
     * Handle one claimed watch to its end. Never throws.
     *
     * @param {ReturnType<typeof import('../../stores/projectAiParticipationStore').rowToWatch>} watch
     * @returns {Promise<{ decision: string, skipReason?: string|null, outcome?: string, messageId?: string }>}
     */
    async function processWatch(watch) {
        const base = {
            projectId: watch.projectId,
            orgId: watch.orgId,
            surface: watch.surface,
            containerId: watch.containerId,
            triggerMessageId: watch.messageId,
            triggerKind: watch.kind,
        };
        let reservation = null;
        /** @param {string} skipReason */
        const skip = async (skipReason, extra = {}) => {
            if (reservation) await store.completeDecision(reservation.id, { decision: 'skipped', skipReason, ...extra });
            else await store.recordDecision({ ...base, decision: 'skipped', skipReason, ...extra });
            return { decision: 'skipped', skipReason };
        };
        try {
            const adapter = surfaces.get(watch.surface);
            if (!adapter) return await skip('surface_unavailable');
            const ctx = await adapter.loadContext(watch.containerId);
            if (!ctx) return await skip('container_gone');
            base.orgId = policyOrg(ctx, watch.orgId);

            const orgPolicy = await policy.resolveOrgPolicy(base.orgId);
            const pref = await policy.resolveUserPreference(watch.authorUserId);
            const messages = ctx.messages || [];
            const trigger = messages.find((m) => m.id === watch.messageId) || null;
            const caps = await store.capsFor({ surface: watch.surface, containerId: watch.containerId, projectId: ctx.projectId, orgId: base.orgId });
            const verdict = preGate({
                stage: 'job',
                triggerKind: watch.kind,
                now: now(),
                surface: watch.surface,
                mode: ctx.aiMode,
                closed: !!ctx.closed,
                pausedUntil: ctx.autoPausedUntil || null,
                policy: orgPolicy,
                authorOptedOut: !pref.autoJoinOnMyMessages,
                message: trigger,
                recent: messages,
                caps,
                lockHeld: await isLockHeld(watch.containerId),
            });
            if (!verdict.ok) return await skip(verdict.reason);
            if (trigger.authorUserId !== watch.authorUserId) return await skip(SKIP.MOVED_ON);

            try {
                if (await checkLimits(watch.limitOrgId, watch.authorUserId)) return await skip('limit');
            } catch (err) {
                log.warn(`[AiParticipation] limit check failed for ${watch.surface} ${watch.containerId}: ${err && err.message}`);
                return await skip('limit_unavailable');
            }

            const lastSeq = messages.reduce((max, m) => (Number.isFinite(m.seq) && m.seq > max ? m.seq : max), 0);
            reservation = await store.reserveGate({ ...base, lastSeq });
            // This exact conversation was already put to the gate: nothing new to decide.
            if (!reservation) return { decision: 'skipped', skipReason: 'already_gated' };

            let readByOthers = null;
            if (typeof ctx.readByOthers === 'function') {
                try { readByOthers = await ctx.readByOthers(trigger); } catch (_) { readByOthers = null; }
            }
            const result = await gate({
                surface: watch.surface,
                containerId: watch.containerId,
                orgId: watch.orgId,
                userId: watch.authorUserId,
                triggerKind: watch.kind,
                lines: gateLinesFrom(messages, now()),
                memberCount: Number.isFinite(ctx.memberCount) ? ctx.memberCount : null,
                readByOthers,
                threshold: thresholdFor(orgPolicy),
            });
            noteGate(result);
            if (!result.available) return await skip(result.skipReason, { model: result.model || null });

            const judged = { reasonCode: result.verdict.reasonCode, confidence: result.verdict.confidence, model: result.model };
            if (result.outcome === 'wait') {
                await store.upsertWatch({
                    projectId: ctx.projectId,
                    surface: watch.surface,
                    containerId: watch.containerId,
                    messageId: trigger.id,
                    authorUserId: watch.authorUserId,
                    orgId: watch.orgId,
                    limitOrgId: watch.limitOrgId,
                    kind: 'unanswered',
                    delaySeconds: (watch.surface === 'comment' ? orgPolicy.commentUnansweredMinutes : orgPolicy.unansweredMinutes) * 60,
                });
                await store.completeDecision(reservation.id, { decision: 'deferred', ...judged });
                return { decision: 'deferred', outcome: 'wait' };
            }
            if (result.outcome !== 'reply') {
                await store.completeDecision(reservation.id, { decision: 'silent', ...judged });
                return { decision: 'silent', outcome: result.outcome };
            }

            const job = {
                ctx,
                watch,
                trigger,
                triggerKind: watch.kind,
                aiTrigger: watch.kind === 'unanswered' ? 'auto_unanswered' : 'auto_quiet',
                reasonCode: result.verdict.reasonCode,
                gateLastSeq: lastSeq,
                runId: newId(),
            };
            const answered = typeof adapter.answer === 'function'
                ? await adapter.answer(job)
                : await writer().write({ adapter, ...job });
            if (answered && answered.status === 'answered') {
                await store.completeDecision(reservation.id, { decision: 'replied', replyMessageId: answered.messageId || null, ...judged });
                return { decision: 'replied', messageId: answered.messageId };
            }
            const why = answered?.reason === 'skip_sentinel' ? 'skip_sentinel' : (answered?.status || 'failed');
            return await skip(why, judged);
        } catch (err) {
            log.warn(`[AiParticipation] watch ${watch.id} (${watch.surface} ${watch.containerId}) failed: ${err?.code || err?.name || 'error'}`);
            try { return await skip('error'); } catch (_) { return { decision: 'skipped', skipReason: 'error' }; }
        }
    }

    return {
        registerSurface,
        surfaceNames: () => [...surfaces.keys()],
        getSurface: (name) => surfaces.get(name) || null,
        onHumanMessage,
        cancelContainer,
        processWatch,
        breakerOpen,
        _resetBreaker: () => { failures = 0; openUntil = 0; },
    };
}

module.exports = { BREAKER_THRESHOLD, BREAKER_COOLDOWN_MS, makeParticipationEngine };
