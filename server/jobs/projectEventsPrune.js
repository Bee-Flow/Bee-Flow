// @typecheck
/**
 * Project live-feed retention: drop `project_events` rows older than a week.
 *
 * `project_events` is the ordered feed a project page tails (GET
 * /api/projects/:id/stream). Its rows only serve a reconnecting client's
 * catch-up, and a client that was away longer than the replay window
 * refetches instead of replaying (projectStore.listProjectEvents sees the
 * hole a pass leaves behind its cursor and asks for a resync), so a week is
 * generous. The durable record is
 * `project_activity`, which this job does not touch. `pruneProjectEvents`
 * existed from the start but nothing ever called it, so the table grew
 * without bound; this job is its caller.
 *
 * Not gated on a module: every workspace writes events, on every edition.
 *
 * MULTI-POD SAFE: one pass at a time across replicas, under a session
 * advisory lock keyed by name (hashtext), so it cannot collide with the
 * numbered job locks.
 *
 * Started from boot like jobs/platformRetention.js:
 *   require('../jobs/projectEventsPrune').start();
 */

'use strict';

const { withNamedLock } = require('./lib/namedLock');
const { periodicJob } = require('./lib/periodicTimer');

const LOCK_NAME = 'beeflow:job:projectEventsPrune';
const RETENTION_DAYS = 7;
const INTERVAL_MS = 6 * 60 * 60 * 1000;
// A short-lived replica may never see its first interval; the boot pass is
// what keeps a fleet of such replicas pruning.
const BOOT_DELAY_MS = 90 * 1000;

let _running = false;

let _deps = null;
function deps() {
    if (!_deps) {
        _deps = {
            pool: require('../db').pool,
            pruneProjectEvents: require('../stores/projectStore').pruneProjectEvents,
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
 * One pass. Resolves to the number of rows deleted, or null when another
 * replica holds the lock or the pass failed (logged, never thrown).
 * @returns {Promise<number|null>}
 */
async function runOnce() {
    if (_running) return null;
    _running = true;
    const d = deps();
    try {
        const out = await withNamedLock(d.pool, LOCK_NAME, () => d.pruneProjectEvents(RETENTION_DAYS));
        if (!out.ran) return null;
        const deleted = Number(out.value) || 0;
        if (deleted) d.log.info(`[projectEventsPrune] pruned ${deleted} project event(s) older than ${RETENTION_DAYS} days`);
        return deleted;
    } catch (err) {
        d.log.warn('[projectEventsPrune] pass failed:', err.message);
        return null;
    } finally {
        _running = false;
    }
}

const { start, stop } = periodicJob({
    bootDelayMs: BOOT_DELAY_MS, intervalMs: INTERVAL_MS, run: () => runOnce(),
    onStart: () => deps().log.info(`[projectEventsPrune] Started — every ${INTERVAL_MS / 3_600_000} h, keeps ${RETENTION_DAYS} days`),
});

module.exports = { start, stop, runOnce, _setDeps, LOCK_NAME, RETENTION_DAYS };
