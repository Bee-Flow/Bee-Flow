/**
 * Compliance Scheduler — periodic runAll across every organization.
 *
 * Behaviour:
 *   - 90 s after boot, kicks off the first sweep (lets PII / Guardrails come up first).
 *   - Every 6 hours thereafter, iterates `userStore.getAllOrganizations()` and
 *     runs all registered checks for each org sequentially. Sequential is
 *     intentional — concurrent runs across many orgs would saturate the DB
 *     pool (40 connections) and starve user-facing queries.
 *   - Always includes orgId='default' so single-tenant installs and shared
 *     fallbacks still get a scan.
 *   - ONE replica sweeps at a time. The in-process `_running` flag only stops
 *     a slow sweep from overlapping itself; with several replicas each one used
 *     to sweep every org, doubling every result and evidence row. A Postgres
 *     session advisory lock (the isoEvidenceCollector pattern) now decides who
 *     sweeps this tick; the others skip it. When the lock cannot be asked for
 *     at all (the database is unreachable) the sweep would fail anyway, so it
 *     is skipped too, with a log line.
 *   - After each org's sweep, the daily project-findings digest
 *     (compliance/projectDigest.js) gets its chance; it sends at most one
 *     notice per org per day and never throws.
 *   - Once per tick, after every org, the project hint dismissals whose
 *     project or person no longer exists are pruned
 *     (complianceStore.pruneHintDismissals): the table has no foreign key, and
 *     a project can disappear by more than one path. Best-effort.
 *
 * Dependencies are injectable (`_runAllOrgs(deps)`) so the test runs without
 * a database.
 */

const log = require('../telemetry/log');

const SCHEDULER_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
// A fixed key of our own (distinct from the ISO collector's 0xBEEF10A).
const LOCK_KEY = 0xBEEF1C5;
let _timer = null;
let _running = false;

function _defaultDeps() {
    return {
        runner: require('./runner'),
        userStore: require('../stores/userStore'),
        pool: require('../db').pool,
        digest: require('./projectDigest'),
        complianceStore: require('../stores/complianceStore'),
    };
}

/** Take the cross-replica lock. Returns the client holding it, or null. */
async function _acquire(pool) {
    let client = null;
    try {
        client = await pool.connect();
        const r = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_KEY]);
        if (r?.rows?.[0]?.locked) return client;
        client.release();
        return null;
    } catch (e) {
        log.warn('[ComplianceScheduler] could not take the sweep lock:', e.message);
        if (client) { try { client.release(); } catch { /* already gone */ } }
        return null;
    }
}

async function _release(client) {
    try { await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]); } catch { /* best-effort: the session ends anyway */ }
    try { client.release(); } catch { /* already released */ }
}

async function _runAllOrgs(deps = null) {
    if (_running) {
        log.info('[ComplianceScheduler] previous sweep still running — skipping');
        return { ran: false, reason: 'running' };
    }
    _running = true;
    let lock = null;
    const started = Date.now();
    try {
        const d = deps || _defaultDeps();
        lock = await _acquire(d.pool);
        if (!lock) {
            log.info('[ComplianceScheduler] another replica holds the sweep — skipping this tick');
            return { ran: false, reason: 'locked' };
        }
        // Always include 'default' so single-tenant installs are covered.
        const orgIds = new Set(['default']);
        try {
            const orgs = await d.userStore.getAllOrganizations();
            for (const o of orgs || []) {
                if (o?.id) orgIds.add(o.id);
            }
        } catch (e) {
            log.warn('[ComplianceScheduler] could not list organizations:', e.message);
        }
        for (const orgId of orgIds) {
            try {
                await d.runner.runAll(orgId, { runType: 'scheduled' });
            } catch (e) {
                log.warn(`[ComplianceScheduler] org="${orgId}" run failed:`, e.message);
                continue;
            }
            if (d.digest && typeof d.digest.sendDigest === 'function') {
                await d.digest.sendDigest(orgId).catch(() => { /* sendDigest never rejects; belt and braces */ });
            }
        }
        if (d.complianceStore && typeof d.complianceStore.pruneHintDismissals === 'function') {
            try { await d.complianceStore.pruneHintDismissals(); }
            catch (e) { log.warn('[ComplianceScheduler] could not prune hint dismissals:', e.message); }
        }
        const ms = Date.now() - started;
        log.info(`[ComplianceScheduler] sweep complete — ${orgIds.size} org(s) in ${ms} ms`);
        return { ran: true, orgs: orgIds.size };
    } finally {
        if (lock) await _release(lock);
        _running = false;
    }
}

function start() {
    if (_timer) return;
    const initial = setTimeout(() => {
        _runAllOrgs().catch(e =>
            log.warn('[ComplianceScheduler] initial sweep failed:', e.message)
        );
    }, 90 * 1000);
    if (initial.unref) initial.unref();

    _timer = setInterval(() => {
        _runAllOrgs().catch(e =>
            log.warn('[ComplianceScheduler] scheduled sweep failed:', e.message)
        );
    }, SCHEDULER_INTERVAL_MS);
    if (_timer.unref) _timer.unref();
    log.info(`[ComplianceScheduler] Started — interval ${SCHEDULER_INTERVAL_MS / 60000} min, multi-tenant`);
}

function stop() {
    if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { start, stop, _runAllOrgs, LOCK_KEY };
