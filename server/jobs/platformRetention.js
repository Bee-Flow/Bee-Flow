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
 *
 * ── WHY THIS IS NOT ON THE AUTOMATION RUNNER'S TICK ─────────────────
 * Both used to ride processRunRetention in core/automationRunner/scheduler/
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

const LEDGER_PRUNE_LOCK_KEY = 0xBEEF111;
const INTERVAL_MS = 60 * 60 * 1000;
// The first interval fire is an hour away — longer than plenty of pods live —
// so a short boot delay is the only pass a short-lived replica ever runs.
const BOOT_DELAY_MS = 60 * 1000;

let _timer = null;
let _bootTimer = null;
let _running = false;

// Dependencies resolve lazily, so a test that injects stand-ins through
// _setDeps never loads a store (and never opens a pool).
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
            log: require('../telemetry/log'),
        };
    }
    return _deps;
}

/** Test hook: inject every dependency above; pass nothing to restore the real ones. */
function _setDeps(d) {
    _deps = d || null;
    _running = false;
}

/**
 * PII scan ledger. Deliberately NOT time-based: a memoised verdict stays
 * correct until the content or the policy changes, so ageing rows out would
 * only buy re-scans. What this does bound is SIZE.
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
        d.log.warn('[platformRetention] scan-ledger prune failed:', e.message);
    } finally {
        if (client) {
            try { if (acquired) await client.query('SELECT pg_advisory_unlock($1)', [LEDGER_PRUNE_LOCK_KEY]); } catch (_) { /* best-effort */ }
            client.release();
        }
    }
}

/** The suggestion scan cache and feedback. One failing never skips the other. */
async function _pruneSuggestions(d) {
    for (const [label, prune] of [['suggestion scan', d.pruneSuggestionScans], ['suggestion feedback', d.pruneSuggestionFeedback]]) {
        if (typeof prune !== 'function') continue;
        try {
            const n = await prune();
            if (n) d.log.info(`[platformRetention] pruned ${n} ${label} row(s)`);
        } catch (e) {
            d.log.warn(`[platformRetention] ${label} prune failed:`, e.message);
        }
    }
}

/** One pass of all three. A failing pass never skips the ones after it. */
async function runOnce() {
    if (_running) return;
    _running = true;
    const d = deps();
    try {
        try {
            await d.monitoringRetentionPass();
        } catch (e) {
            d.log.error('[platformRetention] monitoring retention failed:', e.message);
        }
        await _pruneScanLedger(d);
        await _pruneSuggestions(d);
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

module.exports = { start, stop, runOnce, LEDGER_PRUNE_LOCK_KEY, _setDeps };
