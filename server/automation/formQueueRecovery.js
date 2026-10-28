// @typecheck strict
'use strict';

/**
 * The sweep behind the form queue (formQueue.js): claim form work whose lease
 * lapsed and turn each row back into a queue item.
 */

const log = require('../telemetry/log');
const { lostToConcurrency, LEASE_MS, MAX_RECOVERIES, RECOVERY_BATCH } = require('./formQueueShared');
const { fallback, bestEffort } = require('../utils/bestEffort');

/** @typedef {{ limit?: number }} RecoverPendingArgs */
/**
 * @param {{
 *   automationStore: any,
 *   automationForRun: Function,
 *   clearPending: (sessionId: string) => Promise<any>,
 *   makeItem: Function,
 *   push: Function,
 *   heldSessionIds: () => string[],
 *   isStopping: () => boolean,
 * }} deps
 */
function createFormRecovery({ automationStore, automationForRun, clearPending, makeItem, push, heldSessionIds, isStopping }) {
    /**
     * @param {string} sessionId
     */
    function isHeld(sessionId) {
        return heldSessionIds().includes(sessionId);
    }

    /**
     * Turn a claimed row back into a queue item, or settle it when there is
     * nothing (left) to run. Never runs anything twice: a submission whose run
     * already exists, or a resume whose child already exists, is only cleared.
     * @param {import('./formQueueShared').FormSession} session
     */
    async function itemFromRow(session) {
        const work = session.pendingWork;
        if (!work || (work.kind !== 'submit' && work.kind !== 'resume')) {
            await clearPending(session.id);
            return null;
        }
        /** @returns {Promise<void>} */
        const restorePage = async () => {
            if (work.kind !== 'resume') return;
            const parent = await automationStore.getRun(work.parentRunId).catch((/** @type {unknown} */ e) => fallback('automation/formQueueRecovery:restorePage', e, null));
            if (parent?.status === 'awaiting_form' && session.runId === work.parentRunId) {
                await automationStore.updateRun(work.parentRunId, { awaitingStepId: work.stepId }).catch((/** @type {unknown} */ e) => bestEffort('automation/formQueueRecovery:restorePage#2', e));
            }
        };
        if ((session.pendingAttempts || 0) > MAX_RECOVERIES) {
            log.warn(`[automation/form] gave up on queued form work for automation ${session.automationId} after ${MAX_RECOVERIES} recoveries`);
            await restorePage();
            await clearPending(session.id);
            return null;
        }
        // The same gate a visitor meets (loadForm): a form that is closed or gone
        // runs nothing.
        const stored = await automationStore.getAutomation(session.automationId);
        if (!stored || !stored.isActive || stored.isDraft) {
            await restorePage();
            await clearPending(session.id);
            return null;
        }
        const automation = automationForRun(stored, { mode: 'live' });

        if (work.kind === 'submit') {
            // The run already exists (the pod died after creating it): done.
            if (session.runId) {
                const run = await automationStore.getRun(session.runId);
                if (run && !lostToConcurrency(run)) { await clearPending(session.id); return null; }
            }
        } else {
            // The child already exists, or the parent is no longer waiting for
            // this answer (expired, cancelled, continued elsewhere): done.
            if (session.runId !== work.parentRunId) { await clearPending(session.id); return null; }
            const parent = await automationStore.getRun(work.parentRunId);
            if (!parent || parent.status !== 'awaiting_form') { await clearPending(session.id); return null; }
        }
        return makeItem(automation, session, work);
    }

    /**
     * Claim form work whose lease lapsed and queue it on this pod. Called from the
     * runner's reaper tick and once shortly after boot. Returns how many units
     * were queued.
     * @param {RecoverPendingArgs} [param0]
     */
    async function recoverPending({ limit = RECOVERY_BATCH } = {}) {
        if (isStopping()) return 0;
        const rows = await automationStore.claimStaleFormSessionWork(limit, LEASE_MS);
        let queued = 0;
        for (const session of rows) {
            if (isHeld(session.id)) continue;
            try {
                const item = await itemFromRow(session);
                if (!item) continue;
                push(item);
                queued += 1;
            } catch (e) {
                // Left leased: it lapses again and the next sweep retries it.
                log.warn('[automation/form] could not recover queued form work:', /** @type {Error} */ (e).message);
            }
        }
        if (queued) log.info(`[automation/form] recovered ${queued} queued form submission(s)`);
        return queued;
    }

    return { recoverPending };
}

module.exports = { createFormRecovery };
