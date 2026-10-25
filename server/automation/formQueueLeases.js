// @typecheck noImplicitAny
'use strict';

/**
 * The leases behind the form queue (formQueue.js). The pod that accepted form
 * work holds a lease on its session row and renews it while the work waits in
 * the in-memory FIFO; only a dead (or wedged) pod lets it lapse.
 */

const log = require('../telemetry/log');
const { LEASE_MS, LEASE_RENEW_MS } = require('./formQueueShared');

/**
 * @param {{ automationStore: any, queues: Map<string, { items: import('./formQueueShared').FormQueueItem[], current: import('./formQueueShared').FormQueueItem | null }> }} deps
 */
function createFormLeases({ automationStore, queues }) {
    /** @type {NodeJS.Timeout | null} */
    let renewTimer = null;

    function heldSessionIds() {
        /** @type {string[]} */
        const ids = [];
        for (const q of queues.values()) {
            if (q.current) ids.push(q.current.sessionId);
            for (const it of q.items) ids.push(it.sessionId);
        }
        return ids;
    }

    function ensureRenewal() {
        if (renewTimer) return;
        renewTimer = setInterval(() => {
            const ids = heldSessionIds();
            if (!ids.length) { clearInterval(renewTimer); renewTimer = null; return; }
            automationStore.renewFormSessionLeases(ids, LEASE_MS)
                .catch(/** @param {Error} e */ e => log.warn('[automation/form] lease renewal failed:', e.message));
        }, LEASE_RENEW_MS);
        renewTimer.unref?.();
    }

    /** @param {string} sessionId */
    const clearPending = (sessionId) => automationStore.clearFormSessionPending(sessionId)
        .catch(/** @param {Error} e */ e => log.warn('[automation/form] could not clear finished form work:', e.message));

    /**
     * The work did not produce a run. A first submission goes back to the sweep
     * (after `delayMs`), so a collision or a crash does not cost the visitor their
     * answers. A resume is dropped: its thunk has already put the page back up,
     * so the visitor answers again rather than having the old answer replayed
     * behind their back.
     * @param {import('./formQueueShared').FormQueueItem} item
     * @param {number} delayMs
     */
    async function settleUnfinished(item, delayMs) {
        if (item.kind === 'resume') return clearPending(item.sessionId);
        return automationStore.releaseFormSessionLeases([item.sessionId], delayMs)
            .catch(/** @param {Error} e */ e => log.warn('[automation/form] could not hand form work back:', e.message));
    }

    function stopRenewal() {
        if (renewTimer) { clearInterval(renewTimer); renewTimer = null; }
    }

    return { heldSessionIds, ensureRenewal, stopRenewal, clearPending, settleUnfinished };
}

module.exports = { createFormLeases };
