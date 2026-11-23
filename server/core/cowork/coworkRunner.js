// @typecheck strict
/**
 * Cowork Runner — the scheduler tick for cowork schedules.
 *
 * Deliberately thin. All it owns is "which schedules are due and how many run
 * at once"; the execution itself is `aiTaskRunner.executeTask` with
 * `store: coworkStore` injected, so cowork inherits the tool loop, agent
 * dispatch, credential refresh, outcome recovery and notifications rather than
 * growing a second, subtly-different copy of them.
 *
 * A 60s tick — anything finer just burns queries, since the finest schedule
 * the UI can express is hourly. It is the only scheduler of these runs: the
 * old ai_tasks table moved here and has no tick of its own any more.
 */

const coworkStore = require('../../stores/coworkStore');
const { executeTask, failRun } = require('../aiTaskRunner');
const { claimAttempt } = require('./runClaim.mts');
const log = require('../../telemetry/log');
const { bestEffort, fallback } = require('../../utils/bestEffort');
const { runMaxMs } = require('./runDeadline.mts');
const { isRepeating } = require('./runShared.mts');

const RUNNER_INTERVAL_MS = 60_000;
const MAX_CONCURRENT = 5;

/**
 * A run the organisation's policy stopped: a row of its own that fails with the reason, so the schedule moves on and
 * the owner sees why. A mail run already holds its row (`runId`).
 * @param {Parameters<typeof executeTask>[0]} task
 * @param {string} reason
 * @param {{ manual: boolean, due: boolean, runId: string | null, quiet?: boolean }} opts
 */
async function refuseTask(task, reason, { manual, due, runId, quiet = false }) {
    // A run that holds its own row (a mail, an event, a follow-up) is not the item's moment: refusing it neither moves
    // the clock nor switches a one-off item off. Told before this month: its row closes without a second notice.
    if (runId && quiet) return coworkStore.markError(task.id, reason, { runId });
    const attempt = runId ? { runId } : await claimAttempt(coworkStore, task, { manual, due });
    // failRun is untyped JavaScript; this is the shape its `close` option takes.
    const fail = /** @type {(t: typeof task, e: Error, o: { manual: boolean, store: typeof coworkStore, close: { runId: string | null } }) => Promise<unknown>} */ (/** @type {unknown} */ (failRun));
    if (attempt) await fail(task, new Error(reason), { manual: manual || !!runId, store: coworkStore, close: { runId: attempt.runId } });
}

/**
 * @typedef {{ policyOf?: (userId: string) => Promise<import('../entitlements/coworkPolicy.mts').CoworkPolicy>, budgetRefusal?: (task: Parameters<typeof executeTask>[0]) => Promise<string | null>, orgRefusal?: (task: Parameters<typeof executeTask>[0], budget: number | null) => Promise<{ reason: string, quiet: boolean } | null>, executeTask?: typeof executeTask }} StartDeps
 */

/**
 * What stops this start, in order: the organisation's policy (read-only, unreadable), its monthly budget and
 * subscription limits (./orgBudget.mts, told once and then quiet), the item's own budget (./runBudget.mts, at which
 * the item pauses itself).
 * @param {Parameters<typeof executeTask>[0]} schedule
 * @param {StartDeps} deps
 * @returns {Promise<{ ownerPolicy: import('../entitlements/coworkPolicy.mts').CoworkPolicy, refusal: string | null, quiet: boolean }>}
 */
async function startRefusal(schedule, deps) {
    const policy = require('../entitlements/coworkPolicy.mts');
    const ownerPolicy = await (deps.policyOf || policy.policyOfOwner)(schedule.userId);
    const policyRefusal = policy.runRefusalOf(ownerPolicy);
    if (policyRefusal) return { ownerPolicy, refusal: policyRefusal, quiet: false };
    const org = await (deps.orgRefusal || require('./orgBudget.mts').orgBudgetRefusal)(schedule, ownerPolicy.monthlyBudget ?? null);
    if (org) return { ownerPolicy, refusal: org.reason, quiet: org.quiet };
    return { ownerPolicy, refusal: await (deps.budgetRefusal || require('./runBudget.mts').budgetRefusal)(schedule), quiet: false };
}

/**
 * Say that a run ended (./runEnded.mts): the items that start after this one hear it (./afterCowork.mts).
 * @param {Parameters<typeof executeTask>[0]} schedule
 */
async function announceEnd(schedule) {
    const starts = require('../../stores/coworkStarts.mts').coworkStarts();
    const latest = await starts.latestRunId(schedule.id).catch((/** @type {unknown} */ e) => fallback('core/cowork/coworkRunner:latestRunId', e, null));
    require('./runEnded.mts').runEnded(schedule, latest);
}

/**
 * Run one schedule now. `manual` leaves next_run_at alone. `due` is the tick's
 * own: the run is for a moment that was due when the tick read it, and the
 * claim then requires that it still is (two replicas read the same due row).
 * `trigger`: a run a new mail started (./mailTriggerRun.mts) or a review's
 * follow-up, which holds its row. Every start goes through here, so the
 * organisation's policy and budgets are asked first (./startRefusal above).
 * A refusal the owner already heard this month lets a due moment move on
 * without a failed run.
 * @param {Parameters<typeof executeTask>[0]} schedule
 * @param {{ manual?: boolean, due?: boolean, trigger?: any }} [opts]
 * @param {StartDeps} [deps]
 */
async function executeCowork(schedule, { manual = false, due = false, trigger = null } = {}, deps = {}) {
    const { ownerPolicy, refusal, quiet } = await startRefusal(schedule, deps);
    const silent = quiet && due && !trigger && isRepeating(schedule);
    if (silent) return coworkStore.advanceSchedule(schedule.id, schedule.nextRunAt, schedule.repeatInterval, schedule.daysOfWeek);
    if (refusal) return refuseTask(schedule, refusal, { manual, due, runId: trigger?.runId ?? null, quiet });
    // The apps it may use while nobody watches travel with the run (./runApps.mts), so no runner reads the policy again.
    const task = { ...schedule, unattendedApps: ownerPolicy.unattendedApps };
    await (deps.executeTask || executeTask)(task, { manual, due, store: coworkStore, ...(trigger ? { trigger } : {}) });
    await announceEnd(schedule);
}

/**
 * How long a run may be open before the reaper closes it as interrupted: at
 * least thirty minutes, and always ten minutes more than a run may take
 * (./runDeadline.mts), so the reaper only ever closes what a stopped server
 * left behind and never a run its own deadline is about to end.
 */
function staleAfterMs() {
    return Math.max(30 * 60_000, runMaxMs() + 10 * 60_000);
}

async function processDueCowork() {
    try {
        // A crash or an early return mid-run leaves last_status='running' and
        // an open history row behind, and getDueSchedules skips 'running' — so
        // without this sweep that schedule never runs again. Reaping before
        // the query means a wedged item recovers on the very next tick.
        await coworkStore.reapStaleRuns({ olderThanMs: staleAfterMs() }).catch((e) => bestEffort('core/cowork/coworkRunner:processDueCowork', e));

        const due = await coworkStore.getDueSchedules();
        if (due.length === 0) return;

        log.info(`[CoworkRunner] Found ${due.length} due cowork schedule(s)`);

        for (let i = 0; i < due.length; i += MAX_CONCURRENT) {
            const batch = due.slice(i, i + MAX_CONCURRENT);
            await Promise.allSettled(batch.map(s => executeCowork(s, { due: true })));
        }
    } catch (err) {
        log.error('[CoworkRunner] Background checker error:', /** @type {Error} */ (err).message);
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
    const env = parseInt(process.env.COWORK_RUN_RETENTION_DAYS ?? '', 10);
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
        log.error(`[CoworkRunner] Retention pass error: ${/** @type {Error} */ (err).message}`);
    }
    if (deleted > 0) {
        log.info(`[CoworkRunner] Pruned ${deleted} cowork run(s) older than ${RETENTION_DAYS}d (cutoff ${cutoff})`);
    }
    return { deleted, cutoff, ts: new Date().toISOString() };
}

// ── Background timers ────────────────────────────────────
// Armed by start(), which boot calls (boot/startupJobs.js), never by requiring this
// module: the routes require it for executeCowork, and so does every script,
// generator and test that loads the app. All handles are unref'd.

/** @type {NodeJS.Timeout[] | null} */
let _timers = null;

/**
 * Start the scheduler tick and the retention sweep. Idempotent.
 * @returns {boolean} whether this call started them
 */
function start() {
    if (_timers) return false;
    _timers = [
        // First sweep after 10s so the stores and the migration have settled,
        // then every minute.
        setInterval(processDueCowork, RUNNER_INTERVAL_MS),
        setTimeout(processDueCowork, 10_000),
        // Retention runs hourly with a boot kickoff, a little after the
        // due-sweep's 10s so boot isn't doing both at once.
        setInterval(pruneOldRuns, RETENTION_INTERVAL_MS),
        setTimeout(pruneOldRuns, 30_000),
    ];
    for (const timer of _timers) timer.unref?.();
    // A plan run that waited for its owner's decision is closed when its journey ends (./planRunFollowUp.mts).
    require('./planRunFollowUp.mts').start();
    log.info('[CoworkRunner] Background runner started (60s interval)');
    return true;
}

/** Stop the timers start() armed (shutdown, tests). */
function stop() {
    // clearTimeout cancels an interval as well: both are the same kind of handle.
    for (const timer of _timers || []) clearTimeout(timer);
    _timers = null;
    require('./planRunFollowUp.mts').stop();
}

module.exports = {
    processDueCowork,
    executeCowork,
    pruneOldRuns,
    staleAfterMs,
    start,
    stop,
    // Exposed so a settings/UI surface can state the real window instead of
    // hard-coding "90 days" (mirrors jobs/runRetention.js exporting its own).
    RETENTION_DAYS,
};
