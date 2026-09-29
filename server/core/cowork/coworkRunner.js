/**
 * Cowork Runner — the scheduler tick for cowork schedules.
 *
 * Deliberately thin. All it owns is "which schedules are due and how many run
 * at once"; the execution itself is `aiTaskRunner.executeTask` with
 * `store: coworkStore` injected, so cowork inherits the tool loop, agent
 * dispatch, credential refresh, outcome recovery and notifications rather than
 * growing a second, subtly-different copy of them.
 *
 * The 60s tick matches aiTaskRunner's — anything finer just burns queries,
 * since the finest schedule the UI can express is hourly.
 */

const coworkStore = require('../../stores/coworkStore');
const { executeTask } = require('../aiTaskRunner');
const log = require('../../telemetry/log');

const RUNNER_INTERVAL_MS = 60_000;
const MAX_CONCURRENT = 5;

/**
 * Run one schedule now. `manual` leaves next_run_at alone, as in aiTaskRunner.
 * `surface` is what the notification will call it — the runner is shared with
 * Routines, the vocabulary is not.
 */
async function executeCowork(schedule, { manual = false } = {}) {
    return executeTask(schedule, { manual, store: coworkStore, surface: 'cowork' });
}

async function processDueCowork() {
    try {
        // A crash or an early return mid-run leaves last_status='running' and
        // an open history row behind, and getDueSchedules skips 'running' — so
        // without this sweep that schedule never runs again. Reaping before
        // the query means a wedged item recovers on the very next tick.
        await coworkStore.reapStaleRuns().catch(() => {});

        const due = await coworkStore.getDueSchedules();
        if (due.length === 0) return;

        log.info(`[CoworkRunner] Found ${due.length} due cowork schedule(s)`);

        for (let i = 0; i < due.length; i += MAX_CONCURRENT) {
            const batch = due.slice(i, i + MAX_CONCURRENT);
            await Promise.allSettled(batch.map(s => executeCowork(s)));
        }
    } catch (err) {
        log.error('[CoworkRunner] Background checker error:', err.message);
    }
}

// ── Run-history retention ───────────────────────────────
//
// cowork_runs keeps one row per attempt with the full result text (up to 50k
// chars) and nothing ever deleted it — the one unbounded growth cowork has.
// Same pattern as jobs/runRetention.js, the canonical reaper for automation
// runs: a platform-wide delete-by-age window, closed rows only, bounded
// batches. The delete is strictly age-based and therefore idempotent, so
// several replicas sweeping at once is safe without an advisory lock (the
// startupTasks orgHealth prune documents that precedent); it lives here
// rather than on the scheduler tick because this module already owns every
// other cowork_runs janitor (reapStaleRuns).
//
// Window: COWORK_RUN_RETENTION_DAYS (default 90). Set to 0 to disable.
const RETENTION_DAYS = (() => {
    const env = parseInt(process.env.COWORK_RUN_RETENTION_DAYS, 10);
    return Number.isFinite(env) ? env : 90;
})();
const RETENTION_BATCH_SIZE = 5000;
// Bound the work per pass so a huge backlog drains over several passes rather
// than holding long-running deletes. At 5k/batch this clears up to 100k/pass.
const RETENTION_MAX_BATCHES = 20;
const RETENTION_INTERVAL_MS = 60 * 60_000; // hourly, like the automation reaper

async function pruneOldRuns() {
    if (!RETENTION_DAYS || RETENTION_DAYS <= 0) {
        return { deleted: 0, disabled: true, ts: new Date().toISOString() };
    }
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60_000).toISOString();
    let deleted = 0;
    try {
        for (let i = 0; i < RETENTION_MAX_BATCHES; i++) {
            const n = await coworkStore.deleteRunsOlderThan(cutoff, { limit: RETENTION_BATCH_SIZE });
            deleted += n;
            if (n < RETENTION_BATCH_SIZE) break;
        }
    } catch (err) {
        // Retention is housekeeping: a failed pass just means the next hourly
        // one has slightly more to do.
        log.error(`[CoworkRunner] Retention pass error: ${err.message}`);
    }
    if (deleted > 0) {
        log.info(`[CoworkRunner] Pruned ${deleted} cowork run(s) older than ${RETENTION_DAYS}d (cutoff ${cutoff})`);
    }
    return { deleted, cutoff, ts: new Date().toISOString() };
}

// Same start-up shape as aiTaskRunner: first sweep after 10s so the stores and
// the migration have settled, then every minute.
const _interval = setInterval(processDueCowork, RUNNER_INTERVAL_MS);
if (_interval.unref) _interval.unref();
setTimeout(processDueCowork, 10_000).unref?.();

// Retention runs hourly with a boot kickoff, all unref'd — the
// _coveragePruneInterval shape from aiTaskRunner. Kickoff a little after the
// due-sweep's 10s so boot isn't doing both at once.
const _retentionInterval = setInterval(pruneOldRuns, RETENTION_INTERVAL_MS);
if (_retentionInterval.unref) _retentionInterval.unref();
setTimeout(pruneOldRuns, 30_000).unref?.();

log.info('[CoworkRunner] Background runner started (60s interval)');

module.exports = {
    processDueCowork,
    executeCowork,
    pruneOldRuns,
    // Exposed so a settings/UI surface can state the real window instead of
    // hard-coding "90 days" (mirrors jobs/runRetention.js exporting its own).
    RETENTION_DAYS,
};
