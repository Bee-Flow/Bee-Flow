// @typecheck
/**
 * Keep a journey's tables alive while it waits.
 *
 * A table expires after its own TTL (default 7 days). A run that pauses for an
 * approval (up to 30 days) or a form page resumes in a new leg that reads the
 * tables the first leg wrote; if they expired during the wait, the first table
 * step after the resume would fail with table_not_found. So when a run pauses,
 * the live tables of its whole journey are pushed out to the pause deadline
 * (plus a margin for the steps that run after the resume), the same thing the
 * approval path does for generated files. The expiry only ever moves out.
 *
 * The store comes in as an argument, so this module stays outside the server's
 * import cycle, like the rest of the run-finalize path.
 */

'use strict';

const log = require('../../../telemetry/log');

/** How long past the deadline the tables live, so a resume at the last minute still finds them. */
const RESUME_MARGIN_MS = 60 * 60 * 1000;

/**
 * @param {{ getRunsInChain: Function, listLiveRunTableIdsForRuns: Function, extendRunTableExpiry: Function }} store
 * @param {{ id: string, rootRunId?: string|null }} run
 * @param {string|Date|null|undefined} deadline  when the pause ends
 * @returns {Promise<number>} how many tables were extended (0 when nothing to do or on a failure)
 */
async function extendJourneyTablesForPause(store, run, deadline) {
    const at = deadline ? new Date(deadline).getTime() : NaN;
    if (!run || !Number.isFinite(at)) return 0;
    try {
        const chain = await store.getRunsInChain(run.rootRunId || run.id);
        const runIds = new Set((chain || []).map(r => r.id));
        runIds.add(run.id);
        const ids = await store.listLiveRunTableIdsForRuns([...runIds]);
        if (!ids.length) return 0;
        return await store.extendRunTableExpiry(ids, new Date(at + RESUME_MARGIN_MS));
    } catch (e) {
        // Best effort, like the attachment snapshot: a failure never takes the pause down.
        log.warn(`[tables] could not extend the tables of run ${run.id} for its pause: ${e.message}`);
        return 0;
    }
}

module.exports = { extendJourneyTablesForPause, RESUME_MARGIN_MS };
