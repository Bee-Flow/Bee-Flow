// @typecheck strict
/**
 * The startup jobs and the shutdown of the first-party module "apps" (App Studio; part "jobs"
 * of firstParty/apps.js, contract in modules/firstParty/contract.js). Moved verbatim out of
 * boot/startupJobs.js and boot/lifecycle.js: one row per try block there, started by
 * loader.runStartupPhase in the same phase, which logs a throw as '[Server] <label> <failText>:'
 * like the old catch did; the drain runs inside loader.drain, the flush inside loader.close.
 */

'use strict';

const log = require('../telemetry/log');

/** @type {import('../modules/firstParty/contract').JobRow[]} */
const jobs = [
    // The run log of browser runs (App Studio /step): on against the real store from here on.
    { key: 'apps:clickRuns', phase: 'startRetentionAndComplianceJobs', label: 'App Studio run log', failText: 'not enabled',
        start: () => { require('../appStudio/runLog/clickRuns.mts').configureClickRuns(); } },
    // App Studio connector → table sync. Refreshes the tables that studio apps
    // fill from an external app on the owner's schedule, so viewers read local
    // rows instead of hitting the upstream API on every screen paint.
    // Advisory-locked; each sync is additionally claimed per (app, connector).
    // One row for the five jobs, as it was one try block: a throw stops the ones after it.
    { key: 'apps:studioJobs', phase: 'startSupportAndSyncJobs', label: 'Studio app connector sync',
        start: () => {
            require('../jobs/studioAppConnectorSync').start();
            require('../jobs/datasetIngest').start();
            // Background actions: rows whose process died stop beating → interrupted.
            require('../jobs/studioAppActionRuns').start();
            // Server runs on hold: the ones whose wake time passed go on (or end).
            require('../jobs/studioAppRunWake').start({ wake: () => require('../appStudio/backgroundRun.mts').wakeDueRuns() });
            // Server triggers of published apps: the ones that are due fire, earlier fires are settled.
            // The same pass delivers the changed records that wait for a record trigger (triggers/recordDrain.mts).
            require('../jobs/studioAppTriggers').start({ pass: () => require('../appStudio/triggers/recordDrain.mts').triggerAndRecordPass() });
        } },
];

/**
 * App Studio background actions drain in parallel with the other modules under the shared
 * budget, minus two seconds (at least one); what does not finish in time is marked interrupted
 * (there is no resume).
 * @param {{ timeoutMs: number }} opts the shared drain budget
 */
async function drain({ timeoutMs }) {
    try {
        const backgroundRun = require('../appStudio/backgroundRun.mts');
        await backgroundRun.stop({ timeoutMs: Math.max(1000, timeoutMs - 2000) });
    } catch (e) { log.warn('[Server] background action drain failed:', /** @type {Error} */ (e).message); }
}

/**
 * Flush the SQLite blob engine's dirty handles BEFORE the process exits. Its own SIGTERM
 * listener fires concurrently, but the process.exit() of the shutdown races it: an unawaited
 * flush loses up to the debounce window of committed app writes on every single deploy.
 * Bounded by loader.close, so a hung RustFS can't stall the pod past its termination grace.
 */
async function close() {
    try {
        await Promise.allSettled([require('../stores/studioAppDbStore').closeAll()]);
    } catch (e) { log.warn('[Server] Blob-engine shutdown flush failed:', /** @type {Error} */ (e).message); }
}

module.exports = { jobs, drain, close };
