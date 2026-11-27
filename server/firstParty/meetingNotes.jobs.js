// @typecheck strict
/**
 * The startup job and the shutdown drain of the first-party module "meetingNotes" (part "jobs"
 * of firstParty/meetingNotes.js; contract in modules/firstParty/contract.js). Moved verbatim out
 * of boot/startupJobs.js and boot/lifecycle.js: the job starts in the same phase through
 * loader.runStartupPhase, which logs a throw as '[Server] <label> load failed:' like the old
 * catch did; the drain runs inside loader.drain, next to the other modules' drains.
 */

'use strict';

const defaultLog = require('../telemetry/log');

/** @type {import('../modules/firstParty/contract').JobRow[]} */
const jobs = [
    // Safety net for meeting audio: give any recording still on this pod's disk
    // a durable object-storage copy. The request paths repair opportunistically;
    // this catches notes nobody happens to open.
    { key: 'meetingNotes:savedAudioBackfill', phase: 'startSupportAndSyncJobs', label: 'Saved-audio backfill',
        start: () => { require('../jobs/savedAudioBackfill').start(); } },
];

/**
 * Meeting-notes runs live in this process and die with it: mark them failed now, so the user
 * sees Retry instead of a spinner until the reaper comes round. First, while the database is
 * surely there. Its own bound (5 s), whatever the shared drain budget is.
 * @param {{ timeoutMs: number }} [_opts] the shared drain budget (unused: the bound above is its own)
 * @param {{ meetingRuns?: { failInFlight(o: { timeoutMs: number }): Promise<number> }, log?: import('../modules/firstParty/contract').Log }} [deps] test seam
 */
async function drain(_opts, deps = {}) {
    const log = deps.log || defaultLog;
    try {
        const meetingRuns = deps.meetingRuns || require('../core/meetingNotes/processingRuns.mts');
        const failed = await meetingRuns.failInFlight({ timeoutMs: 5000 });
        if (failed) log.info(`[Server] ${failed} meeting note run(s) interrupted by the shutdown, marked failed for a retry`);
    } catch (e) { log.warn('[Server] marking interrupted meeting runs failed:', /** @type {Error} */ (e).message); }
}

module.exports = { jobs, drain };
