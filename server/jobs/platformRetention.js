// @typecheck strict
/**
 * Platform retention — the retention passes that belong to no module.
 *
 *   1. Monitoring ledgers (jobs/monitoringRetention.js): integration_activity_log,
 *      guardrail_events and, when configured, the access-audit trail.
 *   2. The PII scan ledger (stores/piiScanLedgerStore.prune): bounded by SIZE,
 *      not age — rows from a superseded key version and the coldest rows past
 *      the cap.
 *   3. "Find repeating work" (stores/suggestionScanCache and
 *      stores/suggestionFeedbackStore pruneExpired): scans older than 30 days
 *      and lapsed dismissed/snoozed/opened feedback. Both stores documented a
 *      30-day retention that nothing enforced. Each DELETE is idempotent and
 *      cheap, so two pods running it at once is harmless: no lock.
 *   4. App Studio action runs (stores/studioAppData/actionRuns.mts pruneRuns): a run on hold
 *      longer than the retention, or for a starter whose account is gone, is ended; payloads
 *      nulled after STUDIO_APP_RUN_RESULT_TTL_HOURS, rows deleted after
 *      STUDIO_APP_RUN_RETENTION_DAYS (stores/studioAppData/runPolicy.mts; 0 = keep). Run
 *      rows can carry customer values in their result, so this is a retention duty and
 *      sits here, ungated, under its own advisory lock (0xBEEF115). The same pass closes
 *      idle browser runs of the run log and applies STUDIO_APP_RUN_LOG_MAX_RUNS_PER_APP;
 *      step rows (studio_app_action_run_steps) go with their run (ON DELETE CASCADE).
 *
 * ── WHY THIS IS NOT ON THE AUTOMATION RUNNER'S TICK ─────────────────
 * Both must not ride processRunRetention in core/automationRunner/scheduler/
 * ticks.js. That tick is `moduleGatedTick('automation', …)`, and the whole
 * runner only starts when `isModuleAvailable('automation')`. The tables these
 * passes bound are fed by chat and DLP traffic, which keeps flowing on an
 * instance where Automations was removed in the Modules panel, or was never in
 * the edition (BEEFLOW_EDITION=core, a BEEFLOW_MODULES list without it). There
 * the passes never ran, and guardrail_events — Privacy Shield data — grew
 * without bound (BFSF-439). A retention obligation must not be gated on a
 * billable feature, so this job is started unconditionally at boot, with no
 * module gate, the same reasoning as jobs/datatableRetention.js.
 *
 * MULTI-POD SAFE: the monitoring pass takes its own advisory lock (0xBEEF10B);
 * the ledger prune takes 0xBEEF111 here. One pod per pass. The suggestion
 * prunes need none (see 3).
 */

'use strict';

const telemetryLog = require('../telemetry/log');

const LEDGER_PRUNE_LOCK_KEY = 0xBEEF111;
const ACTION_RUN_PRUNE_LOCK_KEY = 0xBEEF115;
// Accepted / rejected / stale AI suggestions on documents (stores/documentSuggestionStore.js).
const DOCUMENT_SUGGESTION_RETENTION_DAYS = 30;
const INTERVAL_MS = 60 * 60 * 1000;
// The first interval fire is an hour away — longer than plenty of pods live —
// so a short boot delay is the only pass a short-lived replica ever runs.
const BOOT_DELAY_MS = 60 * 1000;

/** @type {NodeJS.Timeout | null} */
let _timer = null;
/** @type {NodeJS.Timeout | null} */
let _bootTimer = null;
let _running = false;

// Dependencies resolve lazily, so a test that injects stand-ins through
// _setDeps never loads a store (and never opens a pool).
/**
 * @typedef {{
 *   pool: typeof import('../db').pool,
 *   monitoringRetentionPass: typeof import('./monitoringRetention').monitoringRetentionPass,
 *   pruneScanLedger: typeof import('../stores/piiScanLedgerStore').prune,
 *   ledgerKeyVersion: typeof import('../core/dlp/scanLedger').LEDGER_KEY_VERSION,
 *   pruneSuggestionScans: () => ReturnType<typeof import('../stores/suggestionScanCache').pruneExpired>,
 *   pruneSuggestionFeedback: () => ReturnType<typeof import('../stores/suggestionFeedbackStore').pruneExpired>,
 *   pruneDocumentSuggestions: () => ReturnType<typeof import('../stores/documentSuggestionStore').purgeResolved>,
 *   pruneStudioActionRuns?: (opts: { resultTtlHours: number, retentionDays: number, batch?: number }) => Promise<{ nulled: number, deleted: number, expired?: number }>,
 *   pruneStudioRunLog?: (opts: { maxPerApp: number, idleMs: number, staleMs: number, batch?: number }) => Promise<{ closed: number, overflow: number }>,
 *   pruneStudioWebhookDeliveries?: () => Promise<number>,
 *   log: typeof import('../telemetry/log'),
 * }} PlatformRetentionDeps
 */
/** @type {PlatformRetentionDeps | null} */
let _deps = null;
function deps() {
    if (!_deps) {
        _deps = {
            pool: require('../db').pool,
            monitoringRetentionPass: require('./monitoringRetention').monitoringRetentionPass,
            pruneScanLedger: require('../stores/piiScanLedgerStore').prune,
            ledgerKeyVersion: require('../core/dlp/scanLedger').LEDGER_KEY_VERSION,
            pruneSuggestionScans: () => require('../stores/suggestionScanCache').pruneExpired(),
            pruneSuggestionFeedback: () => require('../stores/suggestionFeedbackStore').pruneExpired(),
            pruneDocumentSuggestions: () => require('../stores/documentSuggestionStore').purgeResolved(DOCUMENT_SUGGESTION_RETENTION_DAYS),
            pruneStudioActionRuns: (opts) => require('../stores/studioAppData/actionRuns.mts').actionRunStore().pruneRuns(opts),
            pruneStudioRunLog: async (opts) => {
                const store = require('../stores/studioAppData/runLogStore.mts').runLogStore();
                const closed = await store.closeIdleRuns({ idleMs: opts.idleMs, staleMs: opts.staleMs, limit: opts.batch });
                const overflow = await store.pruneOverflow({ maxPerApp: opts.maxPerApp, batch: opts.batch });
                return { closed, overflow };
            },
            // The delivery log of webhook triggers: STUDIO_APP_WEBHOOK_DELIVERY_RETENTION_DAYS (0 = keep).
            pruneStudioWebhookDeliveries: () => require('../stores/studioAppData/webhookTriggers.mts').pruneWebhookDeliveries(),
            log: require('../telemetry/log'),
        };
    }
    return _deps;
}

/**
 * Test hook: inject every dependency above; pass nothing to restore the real ones.
 * @param {PlatformRetentionDeps | null} [d]
 */
function _setDeps(d) {
    _deps = d || null;
    _running = false;
}

/**
 * PII scan ledger. Deliberately NOT time-based: a memoised verdict stays
 * correct until the content or the policy changes, so ageing rows out would
 * only buy re-scans. What this does bound is SIZE.
 * @param {PlatformRetentionDeps} d
 */
async function _pruneScanLedger(d) {
    let acquired = false;
    let client;
    try {
        client = await d.pool.connect();
        const lockRes = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [LEDGER_PRUNE_LOCK_KEY]);
        acquired = !!lockRes.rows[0]?.locked;
        if (!acquired) return; // another pod owns this pass
        const maxRows = Math.max(1000, Number(process.env.PII_LEDGER_MAX_ROWS || 500000));
        const { deleted } = await d.pruneScanLedger({ keyVersion: d.ledgerKeyVersion, maxRows });
        if (deleted) d.log.info(`[platformRetention] pruned ${deleted} PII scan-ledger row(s)`);
    } catch (e) {
        d.log.warn('[platformRetention] scan-ledger prune failed:', /** @type {Error} */ (e).message);
    } finally {
        if (client) {
            try { if (acquired) await client.query('SELECT pg_advisory_unlock($1)', [LEDGER_PRUNE_LOCK_KEY]); } catch (err) { telemetryLog.debug('best-effort', err); }
            client.release();
        }
    }
}

/**
 * The suggestion scan cache and feedback, then resolved document suggestions. One failing never skips the others.
 * @param {PlatformRetentionDeps} d
 */
async function _pruneSuggestions(d) {
    for (const [label, prune] of [['suggestion scan', d.pruneSuggestionScans], ['suggestion feedback', d.pruneSuggestionFeedback], ['document suggestion', d.pruneDocumentSuggestions]]) {
        if (typeof prune !== 'function') continue;
        try {
            const n = await prune();
            if (n) d.log.info(`[platformRetention] pruned ${n} ${label} row(s)`);
        } catch (e) {
            d.log.warn(`[platformRetention] ${label} prune failed:`, /** @type {Error} */ (e).message);
        }
    }
}

/**
 * App Studio action runs: payloads after the result TTL, rows after the retention. Skipped
 * when both knobs are 0. One pod per pass (advisory lock).
 * @param {PlatformRetentionDeps} d
 */
async function _pruneStudioActionRuns(d) {
    if (typeof d.pruneStudioActionRuns !== 'function') return;
    const policy = require('../stores/studioAppData/runPolicy.mts');
    const resultTtlHours = policy.resultTtlHours();
    const retentionDays = policy.retentionDays();
    const runLog = typeof d.pruneStudioRunLog === 'function' ? d.pruneStudioRunLog : null;
    if (!resultTtlHours && !retentionDays && !runLog) return;
    let acquired = false;
    let client;
    try {
        client = await d.pool.connect();
        const lockRes = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [ACTION_RUN_PRUNE_LOCK_KEY]);
        acquired = !!lockRes.rows[0]?.locked;
        if (!acquired) return;
        await _actionRunPasses(d, { resultTtlHours, retentionDays }, runLog, policy);
    } catch (e) {
        d.log.warn('[platformRetention] action-run prune failed:', /** @type {Error} */ (e).message);
    } finally {
        if (client) {
            try { if (acquired) await client.query('SELECT pg_advisory_unlock($1)', [ACTION_RUN_PRUNE_LOCK_KEY]); } catch (err) { telemetryLog.debug('best-effort', err); }
            client.release();
        }
    }
}

/**
 * Under the action-run lock: payloads, old rows and runs on hold that can never continue, then the run log.
 * @param {PlatformRetentionDeps} d
 * @param {{ resultTtlHours: number, retentionDays: number }} knobs
 * @param {PlatformRetentionDeps['pruneStudioRunLog'] | null} runLog
 * @param {typeof import('../stores/studioAppData/runPolicy.mts')} policy
 */
async function _actionRunPasses(d, knobs, runLog, policy) {
    // Also with both knobs at 0: a run on hold whose starter's account is gone is ended whatever the retention.
    if (d.pruneStudioActionRuns) {
        const { nulled, deleted, expired = 0 } = await d.pruneStudioActionRuns({ ...knobs, batch: 5000 });
        if (nulled || deleted || expired) d.log.info(`[platformRetention] action runs: ${nulled} payload(s) cleared, ${deleted} row(s) deleted, ${expired} run(s) on hold ended`);
    }
    if (runLog) await _pruneRunLog(d, runLog, policy);
    if (d.pruneStudioWebhookDeliveries) {
        const gone = await d.pruneStudioWebhookDeliveries();
        if (gone) d.log.info(`[platformRetention] webhook triggers: ${gone} delivery log row(s) deleted`);
    }
}

/**
 * The run log's part of the pass (under the action-run lock): browser runs that never reported
 * their end are closed, and an app keeps at most STUDIO_APP_RUN_LOG_MAX_RUNS_PER_APP runs
 * (0 = no ceiling). Step rows cascade with their run.
 * @param {PlatformRetentionDeps} d
 * @param {NonNullable<PlatformRetentionDeps['pruneStudioRunLog']>} runLog
 * @param {typeof import('../stores/studioAppData/runPolicy.mts')} policy
 */
async function _pruneRunLog(d, runLog, policy) {
    const { closed, overflow } = await runLog({ maxPerApp: policy.maxRunsPerApp(), idleMs: policy.idleCloseMs(), staleMs: policy.staleStepMs(), batch: 5000 });
    if (closed || overflow) d.log.info(`[platformRetention] run log: ${closed} idle run(s) closed, ${overflow} run(s) over the per-app ceiling deleted`);
}

/** One pass of all of them. A failing pass never skips the ones after it. */
async function runOnce() {
    if (_running) return;
    _running = true;
    const d = deps();
    try {
        try {
            await d.monitoringRetentionPass();
        } catch (e) {
            d.log.error('[platformRetention] monitoring retention failed:', /** @type {Error} */ (e).message);
        }
        await _pruneScanLedger(d);
        await _pruneSuggestions(d);
        await _pruneStudioActionRuns(d);
    } finally {
        _running = false;
    }
}

function start() {
    if (_timer) return;
    _bootTimer = setTimeout(() => {
        _bootTimer = null;
        runOnce().catch(e => deps().log.warn('[platformRetention] initial pass failed:', e.message));
    }, BOOT_DELAY_MS);
    if (_bootTimer.unref) _bootTimer.unref();
    _timer = setInterval(() => {
        runOnce().catch(e => deps().log.warn('[platformRetention] scheduled pass failed:', e.message));
    }, INTERVAL_MS);
    if (_timer.unref) _timer.unref();
    deps().log.info(`[platformRetention] Started — interval ${INTERVAL_MS / 60000} min`);
}

function stop() {
    if (_bootTimer) { clearTimeout(_bootTimer); _bootTimer = null; }
    if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { start, stop, runOnce, LEDGER_PRUNE_LOCK_KEY, ACTION_RUN_PRUNE_LOCK_KEY, _setDeps };
