// @typecheck
/**
 * App Studio — a CLIENT-SAFE refusal on the READ path.
 *
 * `safe` is what a router is allowed to pass on as the message literally
 * (routes/studioAppData.js handleErr, routes/studioAppPublic.js handleErr, and
 * dataReadRunner.runBatch for a per-read status). These strings are therefore written to be
 * read by someone who did not make the app: no internal paths, no SQL, no names of other
 * people's organisations.
 *
 * Why a separate small file: there are two modules on the read path that make such a refusal
 * — dataReadRunner.js (the table does not exist / this role may not read) and
 * datatableSource.js (the linked Studio table) — and the flag should be set in one place. Two
 * copies of these four lines are two places where someone later puts `safe: true` on an
 * internal error message.
 *
 * The WRITE path uses the same refusal: actionExecutor/records.js calls datatableSource (with a
 * write action instead of a read) and translates what comes out into a step error. So there is
 * one kind of refusal for both, and the name `readError` is by now an understatement — it
 * covers every client-safe refusal around a table.
 *
 * ── MIND THE STATUS ─────────────────────────────────────────────────
 * The runtime client degrades a 404 to "empty": see
 * agent-hub/.../runtime/useAppDataSource.js (`if (res.status === 404) return []`)
 * and runtime/dataBatchClient.js (`unwrapRead` returns the notFoundValue).
 * A refusal that answers 404 therefore appears on screen as an empty list — and "empty" and
 * "unreadable" are different answers.
 *
 * That is why a refusal is NEVER a 404:
 *   403  you may not read this
 *   422  the link in the model is wrong (the app points at something broken)
 *   503  we could not establish it (outage, no answer)
 * 404 stays what it always was: "that table does not exist in this model".
 */

'use strict';

/**
 * Een weigering met status + boodschap die de router letterlijk doorgeeft.
 * @param {number} status
 * @param {string} message
 */
function readError(status, message) {
    const err = /** @type {Error & {status?: number, safe?: boolean}} */ (new Error(message));
    err.status = status;
    err.safe = true;
    return err;
}

module.exports = { readError };
