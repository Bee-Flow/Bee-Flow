// @typecheck strict
'use strict';

/**
 * The per-automation FIFO behind the form surface (routes/automation/formPublic.js),
 * driven from the database.
 *
 * ── Why a queue at all ───────────────────────────────────────────────────
 * automationRunner single-flights live runs: a second run started while the
 * first is going is CANCELLED with "Skipped: automation already running". For a
 * webhook that is arguably fine; for a form it silently drops a real person's
 * submission — and for a RESUME it drops an answer to a form the visitor is
 * already halfway through. So all form work for one automation is serialised
 * here, first submissions and resumes alike.
 *
 * ── Why the database ─────────────────────────────────────────────────────
 * The visitor gets a 202 the moment a submission is accepted; the run happens
 * in the background. A queue in this process's memory alone would lose, on
 * a deploy or a crash with work still waiting, submissions the visitor had
 * been told were received. So the work is written onto the visitor's session
 * row (`pending_work`) BEFORE the 202, and:
 *
 *   - the pod that accepted it holds a LEASE on it (`pending_lease_until`) and
 *     renews it while the work waits in its in-memory FIFO;
 *   - the work is cleared once the run that carries it exists, so the payload
 *     does not outlive its purpose;
 *   - a lapsed lease (the pod died) is claimed by the sweep on any pod
 *     (recoverPending, from the runner's reaper tick), which rebuilds the exact
 *     same call from the row alone;
 *   - on shutdown, stop() takes no new work off the queue and hands everything
 *     still waiting back at once, so another pod — or this one after its
 *     restart — picks it up without waiting out the lease.
 *
 * The in-memory FIFO is still what serialises work on one pod. Across pods the
 * runner's own lock is what serialises, and a loser comes back `cancelled`
 * with that message — which is what CANCELLED_RE + the retry below exist for.
 *
 * Nothing here changes what the visitor sees: the same 202 / 503 bodies, and the
 * poll still derives its state from the run row.
 */

const log = require('../telemetry/log');
const { HttpError } = require('../core/http/errors');

const {
    QUEUE_DEPTH,
    RETRY_DELAYS_MS,
    LEASE_MS,
    RETRY_LATER_MS,
    MAX_RECOVERIES,
    sleep,
    lostToConcurrency,
} = require('./formQueueShared');
const { createFormWork } = require('./formQueueWork');
const { createFormLeases } = require('./formQueueLeases');
const { createFormRecovery } = require('./formQueueRecovery');
const { bestEffort } = require('../utils/bestEffort');

/**
 * One queue with its own state. The server uses the single instance this
 * module exports; a test builds its own with fake dependencies, so nothing has
 * to be stubbed through the module system.
 *
 * @param {{ store?: any, runner?: any, formAnswers?: any, automationForRun?: Function }} [overrides]
 */
function createFormQueue(overrides = {}) {
    const automationStore = overrides.store || require('../stores/automationStore');
    const runner = () => overrides.runner || require('../core/automationRunner');
    const formAnswers = () => overrides.formAnswers || require('./formAnswers').write;
    const automationForRun = overrides.automationForRun
        || ((/** @type {import('./formQueueShared').FormAutomation} */ stored, /** @type {{ mode?: string }} */ opts) => require('../core/automationRunner/definitionForRun').automationForRun(stored, opts));

    /** automationId → { running: bool, items: [], reserved: number, current: item|null } */
    /** @type {Map<string, { running: boolean, items: import('./formQueueShared').FormQueueItem[], reserved: number, current: import('./formQueueShared').FormQueueItem | null }>} */
    const queues = new Map();
    let stopping = false;

    const { makeItem, stopServingPage } = createFormWork({ automationStore, runner, formAnswers });

    const { heldSessionIds, ensureRenewal, stopRenewal, clearPending, settleUnfinished } = createFormLeases({ automationStore, queues });

    // ── The FIFO ──────────────────────────────────────────

    /** @param {string} automationId */
    function queueFor(automationId) {
        let q = queues.get(automationId);
        if (!q) { q = { running: false, items: [], reserved: 0, current: null }; queues.set(automationId, q); }
        return q;
    }

    /** @param {import('./formQueueShared').FormQueueItem} item */
    function push(item) {
        const q = queueFor(item.automationId);
        q.items.push(item);
        ensureRenewal();
        if (!q.running) drainQueue(item.automationId);
    }

    /**
     * Accept a unit of form work: persist it, ack the visitor, queue it. The
     * visitor never waits on the automation — only on the one write that makes
     * the 202 true.
     *
     * Throws when the work cannot be persisted (500) or the queue is full (503 form_busy).
     *
     * @param {{ automation: { id: string }, session: { id: string }, work: object }} unit
     * @param {import('express').Response} res
     * @param {Record<string, unknown>} [extra] merged into the 202 body
     * @returns {Promise<undefined>}
     */
    async function accept({ automation, session, work }, res, extra = {}) {
        const q = queueFor(automation.id);
        if (q.items.length + q.reserved >= QUEUE_DEPTH) {
            throw new HttpError(503, 'form_busy', 'This form is busy right now — please try again in a moment.');
        }
        // Hold the slot across the write, so a burst cannot all pass the depth
        // check before any of them is queued.
        const dropIfIdle = () => {
            if (queues.get(automation.id) === q && !q.running && !q.items.length && !q.reserved) queues.delete(automation.id);
        };
        q.reserved += 1;
        try {
            // While shutting down, the work is persisted with its lease already
            // lapsed: another pod (or this one after its restart) runs it.
            await automationStore.setFormSessionPending(session.id, work, stopping ? 0 : LEASE_MS);
        } catch (e) {
            q.reserved -= 1;
            dropIfIdle();
            throw e;
        }
        q.reserved -= 1;
        res.status(202).json({ accepted: true, ...extra });
        if (stopping) {
            dropIfIdle();
            return undefined;
        }
        push(makeItem(automation, session, work));
        return undefined;
    }

    /** @param {import('./formQueueShared').FormQueueItem} item */
    async function runQueued(item) {
        const { sessionId, thunk } = item;
        for (let attempt = 0; ; attempt++) {
            let run;
            try {
                run = await thunk();
            } catch (e) {
                await settleUnfinished(item, RETRY_LATER_MS);
                throw e;
            }
            if (!lostToConcurrency(run)) {
                if (sessionId && run?.id) await automationStore.attachFormSessionRun(sessionId, run.id).catch((/** @type {unknown} */ e) => bestEffort('automation/formQueue:runQueued', e));
                await clearPending(sessionId);
                return;
            }
            if (attempt >= RETRY_DELAYS_MS.length || stopping) {
                log.warn(`[automation/form] gave up after ${attempt} retries — automation stayed busy`);
                // Deliberately NOT attached: `run` here is the run that lost the
                // race and did nothing. A resume's thunk has already pointed the
                // session back at the paused parent and restored its page; a first
                // submission goes back to the sweep instead of being dropped.
                await settleUnfinished(item, stopping ? 0 : RETRY_LATER_MS);
                return;
            }
            await sleep(RETRY_DELAYS_MS[attempt]);
        }
    }

    /** @param {string} automationId */
    async function drainQueue(automationId) {
        const q = queues.get(automationId);
        if (!q || q.running) return;
        q.running = true;
        try {
            while (q.items.length && !stopping) {
                const item = q.items.shift();
                if (!item) break; // the loop condition saw a non-empty queue
                q.current = item;
                try {
                    await runQueued(item);
                } catch (e) {
                    log.error('[automation/form] run error:', /** @type {Error} */ (e).message);
                } finally {
                    q.current = null;
                }
            }
        } finally {
            q.running = false;
            // Only this queue's own entry: after a reset (tests) the id may name a newer one.
            if (queues.get(automationId) === q) {
                if (!q.items.length && !q.reserved) queues.delete(automationId);
                else if (!stopping) drainQueue(automationId);
            }
        }
    }

    // ── Recovery (the sweep) ──────────────────────────────  (formQueueRecovery.js)
    const recovery = createFormRecovery({
        automationStore, automationForRun, clearPending, makeItem, push, heldSessionIds,
        isStopping: () => stopping,
    });

    /**
     * Shutdown: take nothing more off the queue and hand everything still waiting
     * back at once. The unit that is running keeps running; the runner's own drain
     * waits for its run, and if the process dies first its lease lapses and the
     * sweep checks whether its run exists before doing anything.
     *
     * @returns {Promise<number>} units handed back
     */
    async function stop() {
        stopping = true;
        stopRenewal();
        /** @type {string[]} */
        const waiting = [];
        for (const q of queues.values()) {
            for (const it of q.items) waiting.push(it.sessionId);
            q.items.length = 0;
        }
        if (waiting.length) {
            await automationStore.releaseFormSessionLeases(waiting, 0)
                .catch(/** @param {Error} e */ e => log.warn('[automation/form] could not hand queued form work back:', e.message));
            log.info(`[automation/form] handed ${waiting.length} queued form submission(s) back for another instance`);
        }
        return waiting.length;
    }

    /** Tests only: forget a previous stop(). */
    function _reset() {
        stopping = false;
        queues.clear();
        stopRenewal();
    }

    return {
        accept,
        stop,
        stopServingPage,
        ...recovery,
        _queues: queues,
        _reset,
    };
}

const defaultQueue = createFormQueue();

module.exports = {
    accept: defaultQueue.accept,
    recoverPending: defaultQueue.recoverPending,
    stop: defaultQueue.stop,
    stopServingPage: defaultQueue.stopServingPage,
    lostToConcurrency,
    createFormQueue,
    QUEUE_DEPTH,
    RETRY_DELAYS_MS,
    LEASE_MS,
    MAX_RECOVERIES,
    _queues: defaultQueue._queues,
    _reset: defaultQueue._reset,
};
