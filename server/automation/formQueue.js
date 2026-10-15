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
 * in the background. That queue used to live only in this process's memory, so
 * a deploy or a crash with work still waiting lost submissions the visitor had
 * been told were received. Now the work is written onto the visitor's session
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

const QUEUE_DEPTH = 25;
// Cross-pod collision backoff. Three tries covers a normal run's length
// without holding a browser's poll open indefinitely.
const RETRY_DELAYS_MS = [1000, 3000, 9000];
const CANCELLED_RE = /already running/i;
// How long a pod owns work it has queued without renewing. Renewed every
// LEASE_RENEW_MS while held, so only a dead (or wedged) pod lets it lapse.
const LEASE_MS = 2 * 60_000;
const LEASE_RENEW_MS = 40_000;
// A first submission whose live attempt gave up (the automation stayed busy on
// another pod) goes back to the sweep after this long rather than being lost.
const RETRY_LATER_MS = 60_000;
// How often the sweep may pick the same work up before it is given up on.
const MAX_RECOVERIES = 3;
const RECOVERY_BATCH = 25;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Another pod held the automation's running marker, so this run did nothing.
 * Our own queue cannot see theirs, hence the back-off retry in runQueued.
 */
function lostToConcurrency(run) {
    return !!run && run.status === 'cancelled' && CANCELLED_RE.test(run.error || '');
}

/** The answers-table row this journey writes to (its id rides on the trigger headers). */
function answersRefOf(session) {
    const h = session?.triggerHeaders || {};
    return h.answers_row_id ? { datatableId: h.answers_datatable_id || null, rowId: h.answers_row_id } : null;
}

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
        || ((stored, opts) => require('../core/automationRunner/definitionForRun').automationForRun(stored, opts));

    /** automationId → { running: bool, items: [], reserved: number, current: item|null } */
    const queues = new Map();
    let stopping = false;
    let renewTimer = null;

    /**
     * Close out the run the visitor just resumed.
     *
     * resumeFromStep starts a CHILD run and leaves the parent sitting in
     * 'awaiting_form' forever — so reapExpiredFormWaits later flipped a form the
     * visitor had actually COMPLETED to a "FormExpired" error, and the owner's run
     * history recorded a failure for a submission that worked (W5-15). The
     * approve-step endpoint has always finalised its parent this way; this is the
     * same shape for the form pause: the parent's own portion, up to the pause,
     * succeeded, and its summary points at the child that carries the continuation.
     *
     * The session is re-pointed at the child FIRST. It happens again in runQueued
     * (idempotent), but doing it here closes a real window: the poll reads
     * `session.runId`, and a parent flipped to 'success' while the session still
     * pointed at it would answer `state: 'done'` — ending the visitor's journey
     * before the child had a chance to serve the next page.
     */
    async function finaliseResumedParent(session, parentRunId, child) {
        if (session?.id) await automationStore.attachFormSessionRun(session.id, child.id).catch(() => {});
        await automationStore.updateRun(parentRunId, {
            status: 'success',
            summary: `Resumed from the form — see child run ${child.id}`,
            finishedAt: new Date().toISOString(),
            awaitingStepId: null,
        }).catch(() => {});
    }

    // ── The work itself ───────────────────────────────────
    //
    // Built from (automation, session, work) and nothing else, so the call a
    // recovered row makes is exactly the call the original request would have
    // made. `work` is what sits in pending_work:
    //
    //   { kind: 'submit', payload, submitterId }
    //   { kind: 'resume', parentRunId, stepId, values, submitterId }

    /** A first submission: start the automation with the visitor's answers. */
    function submitThunk(automation, session, work) {
        const answers = answersRefOf(session);
        const submitterId = work.submitterId || null;
        return () => runner().executeAutomation(automation, {
            triggerKind: 'form',
            triggerPayload: { ...(work.payload || {}) },
            triggerHeaders: session.triggerHeaders,
            rootStepId: session.rootStepId || null,
            // Point the session at the run the MOMENT it exists, not when it
            // returns. executeAutomation resolves only once the automation has
            // paused or finished, so waiting for it left session.runId null for
            // the whole first stretch — and the poll has nothing to report
            // progress from without a run to read.
            onRunCreated: async (r) => {
                await automationStore.attachFormSessionRun(session.id, r.id);
                // FRM-08: who submitted, on the run — and the run, on the row.
                if (submitterId) await automationStore.updateRun(r.id, { submittedByUserId: submitterId }).catch(() => {});
                if (answers) await formAnswers().attachRun({ automation, datatableId: answers.datatableId, rowId: answers.rowId, run: r });
            },
            // No more pages to answer: the journey is complete (an error is
            // "complete" too — nothing further will be asked).
            onRunFinished: answers
                ? (r, { status }) => ((status === 'success' || status === 'error')
                    ? formAnswers().markCompleted({ automation, datatableId: answers.datatableId, rowId: answers.rowId })
                    : null)
                : null,
        });
    }

    /** Stop handing the answered page back while its resume is in flight (see formPublic.js). */
    function stopServingPage(parentRunId) {
        return automationStore.updateRun(parentRunId, { awaitingStepId: null }).catch(() => {});
    }

    /** A later page: resume the paused run with this page's answers. */
    function resumeThunk(automation, session, work) {
        const answersRef = answersRefOf(session);
        const submitterId = work.submitterId || null;
        const parentRunId = work.parentRunId;
        const stepId = work.stepId;
        const serveAgain = () => automationStore.updateRun(parentRunId, { awaitingStepId: stepId }).catch(() => {});
        // The session is pointed at the child as soon as it exists (below), so
        // a resume that never completed has to hand the pointer BACK — else the
        // poll reads a dead child and shows a failure for an answer that is
        // about to be retried.
        const pointAtParent = () => automationStore.attachFormSessionRun(session.id, parentRunId).catch(() => {});
        return async () => {
            await stopServingPage(parentRunId);   // idempotent: runQueued may retry this thunk
            let child;
            try {
                child = await runner().resumeFromStep(parentRunId, stepId, {
                    decision: { ...(work.values || {}) },
                    rootStepId: session.rootStepId,
                    triggerHeaders: session.triggerHeaders,
                    // Same reason as the first submission: the child is where
                    // the work happens, and it must be readable while it
                    // happens. finaliseResumedParent only runs once the child
                    // is DONE, which is far too late to show progress.
                    onRunCreated: async (r) => {
                        await automationStore.attachFormSessionRun(session.id, r.id);
                        if (submitterId) await automationStore.updateRun(r.id, { submittedByUserId: submitterId }).catch(() => {});
                    },
                    onRunFinished: answersRef
                        ? (r, { status }) => ((status === 'success' || status === 'error')
                            ? formAnswers().markCompleted({ automation, ...answersRef })
                            : null)
                        : null,
                });
            } catch (e) {
                await pointAtParent();
                await serveAgain();    // the answer never ran — let them retry
                throw e;
            }
            // A lost cross-pod race is not a completed resume — leave the
            // parent paused so runQueued's retry can try again.
            if (child?.id && !lostToConcurrency(child)) {
                await finaliseResumedParent(session, parentRunId, child);
            } else {
                await pointAtParent();
                await serveAgain();
            }
            return child;
        };
    }

    function makeItem(automation, session, work) {
        const thunk = work.kind === 'resume' ? resumeThunk(automation, session, work) : submitThunk(automation, session, work);
        return { automationId: automation.id, sessionId: session.id, kind: work.kind, thunk };
    }

    // ── Leases ────────────────────────────────────────────

    function heldSessionIds() {
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
                .catch(e => log.warn('[automation/form] lease renewal failed:', e.message));
        }, LEASE_RENEW_MS);
        renewTimer.unref?.();
    }

    const clearPending = (sessionId) => automationStore.clearFormSessionPending(sessionId)
        .catch(e => log.warn('[automation/form] could not clear finished form work:', e.message));

    /**
     * The work did not produce a run. A first submission goes back to the sweep
     * (after `delayMs`), so a collision or a crash does not cost the visitor their
     * answers. A resume is dropped: its thunk has already put the page back up,
     * so the visitor answers again rather than having the old answer replayed
     * behind their back.
     */
    async function settleUnfinished(item, delayMs) {
        if (item.kind === 'resume') return clearPending(item.sessionId);
        return automationStore.releaseFormSessionLeases([item.sessionId], delayMs)
            .catch(e => log.warn('[automation/form] could not hand form work back:', e.message));
    }

    // ── The FIFO ──────────────────────────────────────────

    function queueFor(automationId) {
        let q = queues.get(automationId);
        if (!q) { q = { running: false, items: [], reserved: 0, current: null }; queues.set(automationId, q); }
        return q;
    }

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
     * @param {*} res
     * @param {object} [extra] merged into the 202 body
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
                if (sessionId && run?.id) await automationStore.attachFormSessionRun(sessionId, run.id).catch(() => {});
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

    async function drainQueue(automationId) {
        const q = queues.get(automationId);
        if (!q || q.running) return;
        q.running = true;
        try {
            while (q.items.length && !stopping) {
                const item = q.items.shift();
                q.current = item;
                try {
                    await runQueued(item);
                } catch (e) {
                    log.error('[automation/form] run error:', e.message);
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

    // ── Recovery (the sweep) ──────────────────────────────

    function isHeld(sessionId) {
        return heldSessionIds().includes(sessionId);
    }

    /**
     * Turn a claimed row back into a queue item, or settle it when there is
     * nothing (left) to run. Never runs anything twice: a submission whose run
     * already exists, or a resume whose child already exists, is only cleared.
     */
    async function itemFromRow(session) {
        const work = session.pendingWork;
        if (!work || (work.kind !== 'submit' && work.kind !== 'resume')) {
            await clearPending(session.id);
            return null;
        }
        const restorePage = async () => {
            if (work.kind !== 'resume') return;
            const parent = await automationStore.getRun(work.parentRunId).catch(() => null);
            if (parent?.status === 'awaiting_form' && session.runId === work.parentRunId) {
                await automationStore.updateRun(work.parentRunId, { awaitingStepId: work.stepId }).catch(() => {});
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
     */
    async function recoverPending({ limit = RECOVERY_BATCH } = {}) {
        if (stopping) return 0;
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
                log.warn('[automation/form] could not recover queued form work:', e.message);
            }
        }
        if (queued) log.info(`[automation/form] recovered ${queued} queued form submission(s)`);
        return queued;
    }

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
        if (renewTimer) { clearInterval(renewTimer); renewTimer = null; }
        const waiting = [];
        for (const q of queues.values()) {
            for (const it of q.items) waiting.push(it.sessionId);
            q.items.length = 0;
        }
        if (waiting.length) {
            await automationStore.releaseFormSessionLeases(waiting, 0)
                .catch(e => log.warn('[automation/form] could not hand queued form work back:', e.message));
            log.info(`[automation/form] handed ${waiting.length} queued form submission(s) back for another instance`);
        }
        return waiting.length;
    }

    /** Tests only: forget a previous stop(). */
    function _reset() {
        stopping = false;
        queues.clear();
        if (renewTimer) { clearInterval(renewTimer); renewTimer = null; }
    }

    return {
        accept,
        recoverPending,
        stop,
        stopServingPage,
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
