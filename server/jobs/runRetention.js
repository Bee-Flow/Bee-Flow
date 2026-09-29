/**
 * Run-history retention job (§WS3.1).
 *
 * Every execution writes one automation_runs row + N automation_run_steps rows
 * (each with full input/output JSONB). Without a reaper these two highest-volume
 * tables grow without bound, degrading the executions list and inflating storage.
 *
 * This pass DELETES terminal runs (success/error/cancelled) older than the
 * retention window in bounded batches; automation_run_steps cascade-delete via
 * their FK. In-flight runs (queued/running/awaiting_approval) are never touched.
 *
 * Window: AUTOMATION_RUN_RETENTION_DAYS (default 90). Set to 0 to disable.
 * Per-org retention windows are a future enhancement; today it's a single
 * platform-wide window (delete-by-age, deliberately simple — like the nonce GC).
 *
 * Per ROUTINE (handoff 5): `definition.runPolicy.retentionDays` (7..365), read
 * from the WORKING copy because runPolicy is a setting that applies without a
 * publish (core/automationRunner/definitionForRun.js SETTINGS_KEYS), keeps
 * that routine's runs for min(platform window, retentionDays). A second
 * bounded pass after the platform one; a routine can shorten its history,
 * never lengthen it past the platform window. It runs even when the platform
 * window is disabled, because a routine's own promise ("runs kept 30 days")
 * does not depend on the platform's.
 */

const automationStore = require('../stores/automationStore');
const { recordJobRun } = require('../telemetry/metrics');
const log = require('../telemetry/log');

const RETENTION_DAYS = (() => {
    const env = parseInt(process.env.AUTOMATION_RUN_RETENTION_DAYS, 10);
    return Number.isFinite(env) ? env : 90;
})();
const BATCH_SIZE = 5000;
// Bound the work per pass so a huge backlog drains over several passes rather
// than holding a long transaction. At 5k/batch this clears up to 100k per pass.
const MAX_BATCHES = 20;

/** The per-routine pass (runPolicy.retentionDays). Returns how many runs it deleted. */
async function routineRetentionPass(store = automationStore) {
    if (typeof store.deleteRunsPastAutomationRetention !== 'function') return 0;
    let deleted = 0;
    for (let i = 0; i < MAX_BATCHES; i++) {
        const n = await store.deleteRunsPastAutomationRetention({ platformDays: RETENTION_DAYS, limit: BATCH_SIZE });
        deleted += n;
        if (n < BATCH_SIZE) break;
    }
    return deleted;
}

async function runRetentionPass(store = automationStore) {
    const t0 = Date.now();
    let byRoutine = 0;
    let ok = true;
    try {
        byRoutine = await routineRetentionPass(store);
    } catch (e) {
        ok = false;
        log.error('[runRetention] per-routine pass error:', e.message);
    }
    if (byRoutine) log.info(`[runRetention] deleted ${byRoutine} run(s) past their routine's own retention`);
    if (!RETENTION_DAYS || RETENTION_DAYS <= 0) {
        recordJobRun({ job: 'run_retention', status: ok ? 'ok' : 'error', durationMs: Date.now() - t0 });
        return { deleted: byRoutine, byRoutine, disabled: true, ts: new Date().toISOString() };
    }
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60_000).toISOString();
    let deleted = 0;
    try {
        for (let i = 0; i < MAX_BATCHES; i++) {
            const n = await store.deleteRunsOlderThan(cutoff, { limit: BATCH_SIZE });
            deleted += n;
            if (n < BATCH_SIZE) break;
        }
    } catch (e) {
        ok = false;
        log.error('[runRetention] pass error:', e.message);
    }
    recordJobRun({ job: 'run_retention', status: ok ? 'ok' : 'error', durationMs: Date.now() - t0 });
    if (deleted) log.info(`[runRetention] deleted ${deleted} run(s) older than ${RETENTION_DAYS}d (cutoff ${cutoff})`);
    return { deleted: deleted + byRoutine, byRoutine, cutoff, ts: new Date().toISOString() };
}

module.exports = { runRetentionPass, RETENTION_DAYS };
