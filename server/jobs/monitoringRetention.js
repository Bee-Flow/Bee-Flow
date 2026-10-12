/**
 * Monitoring-ledger retention.
 *
 * integration_activity_log and guardrail_events grew without bound: one row
 * per tool call / guard decision, no reaper anywhere. This pass deletes rows
 * older than the window in bounded batches, mirroring jobs/runRetention.js.
 *
 * Window: MONITORING_LOG_RETENTION_DAYS (default 400). 0 disables retention.
 * ── Art 26(6) interaction ────────────────────────────────────────────────
 * compliance/checks/aia/art26-6-log-retention.js PASSES only when the
 * observed log span (floored to whole days) is ≥ 180, so values 1–180 are
 * raised to 181 with a loud warning. 181, not 180: right after a purge with
 * an exactly-180-day window the oldest surviving row is strictly YOUNGER
 * than 180 days, the floored span reads 179, and the check would flap to
 * 'warn' after every hourly pass. One day of margin keeps it green. Once
 * retention has run for a while the observed span converges to the window;
 * the 400-day default keeps the check green with months of margin.
 *
 * ── The access & authentication trail is separate, and OFF by default ────
 * access_audit_log carries the ISO A.8.15 sign-in trail and every
 * access-control change. It grows without bound too, and it holds IP addresses,
 * so GDPR minimisation argues for a window. But it is EVIDENCE, and deleting it
 * cannot be undone: an upgrade that silently starts purging a customer's
 * access-control history would be the worst kind of helpful. So it has its own
 * window, ACCESS_AUDIT_RETENTION_DAYS, and it DEFAULTS TO OFF — an installation
 * keeps exactly the behaviour it had until somebody decides otherwise. Setting
 * it is the documented way to meet a retention policy; leaving it unset keeps
 * everything, which is the safe direction for evidence and the wrong one for
 * minimisation. That trade is the operator's.
 *
 * ── Chat signals counts: always, on the org's own retention ──────────────
 * chat_signal_counts (stores/chatSignalStore.js) holds weekly and daily
 * counters of how the Privacy Shield handled chat messages. Each org chose
 * 30-90 days for them (90 when unset), so that purge runs on every pass, also
 * when both windows above are off: an operator switch must not be able to
 * keep counts longer than the organisation promised its people.
 *
 * MULTI-POD SAFE: Postgres advisory lock 0xBEEF10B (pattern from
 * jobs/usageOpenObservePush.js) — one pod per pass.
 */

const { pool, run } = require('../db');
const { recordJobRun } = require('../telemetry/metrics');
const log = require('../telemetry/log');

const LOCK_KEY = 0xBEEF10B;
const BATCH_SIZE = 5000;
const MAX_BATCHES = 20; // ≤100k rows per table per pass — drain, don't stall

// 181 = the check's 180-day floor + 1 day purge margin (see header).
const MIN_RETENTION_DAYS = 181;
const RETENTION_DAYS = (() => {
    const env = parseInt(process.env.MONITORING_LOG_RETENTION_DAYS, 10);
    if (!Number.isFinite(env)) return 400;
    if (env <= 0) return 0; // explicit opt-out
    if (env < MIN_RETENTION_DAYS) {
        log.warn(`[monitoringRetention] MONITORING_LOG_RETENTION_DAYS=${env} raised to ${MIN_RETENTION_DAYS}: `
            + `the AI-Act Art 26(6) check requires a ≥180-day observed log span, and a shorter window `
            + `(including exactly 180 — the span floors to 179 right after a purge) would fail or flap it.`);
        return MIN_RETENTION_DAYS;
    }
    return env;
})();

const TABLES = ['integration_activity_log', 'guardrail_events'];

/**
 * The access & authentication trail, with its own window and its own floor.
 *
 * Default 0 — off. Not a shrug: purging evidence is irreversible and nobody
 * asked for it, so an upgrade must not start doing it. The floor when a window
 * IS set is a year rather than the 181 days above: a certification body samples
 * roughly three months before Stage 2, but the access-control evidence an
 * auditor asks for typically spans the full cycle, and a window that quietly
 * destroys the second half of that is worse than no window.
 *
 * Its time column is created_at, not timestamp — hence the separate pass.
 */
const ACCESS_AUDIT_TABLE = 'access_audit_log';
const MIN_ACCESS_AUDIT_DAYS = 365;
const ACCESS_AUDIT_RETENTION_DAYS = (() => {
    const raw = process.env.ACCESS_AUDIT_RETENTION_DAYS;
    if (raw === undefined || String(raw).trim() === '') return 0;
    // Number(), not parseInt(): parseInt('90 days') is 90, which reads a
    // malformed setting as a valid one. Here that happens to fail safe (it
    // keeps more), but a setting nobody typed correctly should not be honoured
    // silently — and the same leniency on a smaller unit would not fail safe.
    // RETENTION_DAYS above keeps parseInt deliberately: changing how an
    // existing installation's value is read is a behaviour change, and this is
    // not the commit for it.
    const env = Number(String(raw).trim());
    if (!Number.isInteger(env)) {
        log.warn(`[monitoringRetention] ACCESS_AUDIT_RETENTION_DAYS=${JSON.stringify(raw)} is not a number — `
            + 'leaving the access-audit trail untouched. An unreadable retention setting must never be read as '
            + '"delete everything".');
        return 0;
    }
    if (env <= 0) return 0;
    if (env < MIN_ACCESS_AUDIT_DAYS) {
        log.warn(`[monitoringRetention] ACCESS_AUDIT_RETENTION_DAYS=${env} raised to ${MIN_ACCESS_AUDIT_DAYS}: `
            + 'the access trail is ISO A.8.15 evidence, and an auditor asks for the certification cycle rather '
            + 'than the last few months.');
        return MIN_ACCESS_AUDIT_DAYS;
    }
    return env;
})();

async function _deleteBatches(table, cutoff, timeCol = 'timestamp', runSql = run) {
    let deleted = 0;
    for (let i = 0; i < MAX_BATCHES; i++) {
        const res = await runSql(`
            DELETE FROM ${table}
            WHERE id IN (SELECT id FROM ${table} WHERE ${timeCol} < $1 ORDER BY id LIMIT ${BATCH_SIZE})
        `, [cutoff]);
        const n = res?.rowCount || 0;
        deleted += n;
        if (n < BATCH_SIZE) break;
    }
    return deleted;
}

/** The chat signals purge, required lazily so this job loads without the store. */
function _purgeChatSignals() {
    return require('../stores/chatSignalStore').purgeExpired();
}

/**
 * One retention pass over injectable dependencies; the job below runs the
 * real ones. Tests pass their own pool, SQL runner, purge and windows instead
 * of reaching into the module system.
 * @param {{ pool: { connect: () => Promise<any> }, run: (sql: string, params?: any[]) => Promise<any>,
 *   purgeChatSignals: () => Promise<number>, recordJobRun: (row: object) => void,
 *   retentionDays: number, accessAuditRetentionDays: number }} deps
 */
function makeMonitoringRetentionPass(deps) {
    const retentionDays = deps.retentionDays;
    const accessAuditRetentionDays = deps.accessAuditRetentionDays;
    return async function monitoringRetentionPass() {
        // Two independent windows (either may be off while the other runs) and
        // the chat signals purge, which always runs — so the lock is always taken.
        const cutoff = retentionDays ? new Date(Date.now() - retentionDays * 24 * 60 * 60_000).toISOString() : null;
        const t0 = Date.now();
        let acquired = false;
        let client;
        let ok = true;
        const deleted = {};
        try {
            client = await deps.pool.connect();
            const lockRes = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_KEY]);
            acquired = !!lockRes.rows[0]?.locked;
            if (!acquired) return { skipped: 'lock', ts: new Date().toISOString() }; // another pod owns this pass
            if (retentionDays) {
                for (const table of TABLES) {
                    deleted[table] = await _deleteBatches(table, cutoff, 'timestamp', deps.run);
                }
            }
            if (accessAuditRetentionDays) {
                const auditCutoff = new Date(Date.now() - accessAuditRetentionDays * 24 * 60 * 60_000).toISOString();
                deleted[ACCESS_AUDIT_TABLE] = await _deleteBatches(ACCESS_AUDIT_TABLE, auditCutoff, 'created_at', deps.run);
            }
            // Outside the retentionDays gate on purpose: see the header.
            try {
                deleted.chat_signal_counts = await deps.purgeChatSignals();
            } catch (e) {
                ok = false;
                log.error('[monitoringRetention] chat signals purge error:', e && e.code ? e.code : 'error');
            }
        } catch (e) {
            ok = false;
            log.error('[monitoringRetention] pass error:', e.message);
        } finally {
            if (client) {
                try { if (acquired) await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]); } catch (_) { /* best-effort */ }
                client.release();
            }
            if (acquired) deps.recordJobRun({ job: 'monitoring_retention', status: ok ? 'ok' : 'error', durationMs: Date.now() - t0 });
        }
        const total = Object.values(deleted).reduce((a, b) => a + b, 0);
        if (total) log.info(`[monitoringRetention] deleted ${JSON.stringify(deleted)}${cutoff ? ` (monitoring ledgers older than ${retentionDays}d, cutoff ${cutoff})` : ''}`);
        return { deleted, cutoff, ts: new Date().toISOString() };
    };
}

const monitoringRetentionPass = makeMonitoringRetentionPass({
    pool,
    run,
    purgeChatSignals: _purgeChatSignals,
    recordJobRun,
    retentionDays: RETENTION_DAYS,
    accessAuditRetentionDays: ACCESS_AUDIT_RETENTION_DAYS,
});

module.exports = {
    monitoringRetentionPass,
    makeMonitoringRetentionPass,
    RETENTION_DAYS,
    ACCESS_AUDIT_RETENTION_DAYS,
    MIN_ACCESS_AUDIT_DAYS,
};
