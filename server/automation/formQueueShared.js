// @typecheck strict
'use strict';

/**
 * Constants and small helpers shared by the form queue (formQueue.js) and the
 * pieces it is assembled from (formQueueWork.js, formQueueRecovery.js).
 */

/**
 * Rows and work units of the form queue. The stores hand back plain database
 * rows, so the session, the automation and the run are records.
 * @typedef {Record<string, any>} FormSession   a form_sessions row
 * @typedef {Record<string, any>} FormAutomation   an automation as the runner takes it
 * @typedef {Record<string, any>} FormRun   an automation run row
 * @typedef {Record<string, any>} FormWork   what sits in pending_work: { kind: 'submit' | 'resume', ... }
 * @typedef {{ automationId: string, sessionId: string, kind: string, thunk: () => Promise<any> }} FormQueueItem
 */

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

/** @param {number} ms */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Another pod held the automation's running marker, so this run did nothing.
 * Our own queue cannot see theirs, hence the back-off retry in runQueued.
 * @param {FormRun | null | undefined} run
 */
function lostToConcurrency(run) {
    return !!run && run.status === 'cancelled' && CANCELLED_RE.test(run.error || '');
}

/**
 * The answers-table row this journey writes to (its id rides on the trigger headers).
 * @param {FormSession | null | undefined} session
 */
function answersRefOf(session) {
    const h = session?.triggerHeaders || {};
    return h.answers_row_id ? { datatableId: h.answers_datatable_id || null, rowId: h.answers_row_id } : null;
}

module.exports = {
    QUEUE_DEPTH,
    RETRY_DELAYS_MS,
    CANCELLED_RE,
    LEASE_MS,
    LEASE_RENEW_MS,
    RETRY_LATER_MS,
    MAX_RECOVERIES,
    RECOVERY_BATCH,
    sleep,
    lostToConcurrency,
    answersRefOf,
};
