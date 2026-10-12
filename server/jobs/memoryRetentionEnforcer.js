/**
 * Memory Retention Enforcer — GDPR Art. 5(1)(e) "storage limitation" for the
 * user_memories table.
 *
 * Runs every 24 hours:
 *   1. DEADLINE sweep — active memories whose `expires_at` has passed →
 *      status='expired'. Only rows that carry a TTL (the schedule_coverage
 *      bookkeeping rows) ever match; it runs on every install, always.
 *   2. AGE sweep — per organization, ONLY when that org has switched it on:
 *      active memories not confirmed within the org's declared retention
 *      window → status='expired'. Never instructions, never a DELETE, bounded
 *      per pass so one tenant cannot hold the pool.
 *   3. HARD DELETE — two different things, two different rules:
 *      a. HISTORY, on every install: rows with status `superseded` for longer
 *         than HARD_DELETE_DAYS (90) are deleted for real, with their
 *         memory_sources rows. They are not live memories; they are kept that
 *         long only so the "Remembered" chip's Undo can restore a replaced
 *         fact. Aged from valid_to. On the first run after an upgrade, legacy
 *         superseded rows have the valid_to the store backfilled from their
 *         updated_at, so they age from the day they were really replaced.
 *      b. RESTORABLE memories (`archived`, `expired`), ONLY for an org that
 *         switched retention on (`memory_retention_enabled === true`), and
 *         only after THAT org's `default_retention_days` (min 60, as the age
 *         sweep), measured from archived_at / valid_to / updated_at. An
 *         archived row is a memory the person can restore; deleting it on an
 *         install that never opted in would be silent data loss.
 *      Both batched and capped per run; idempotent (a second run finds nothing).
 *   4. Heartbeat on `compliance_settings.last_retention_run_at` so the
 *      Art-5(1)(e) compliance check can verify the job is alive.
 *
 * ── The policy, and why it fails towards leaving data alone ────────────────
 * Both halves live in `compliance_settings`: `memory_retention_enabled` and
 * the existing `default_retention_days`. The number the ROPA publishes IS the
 * number this job sweeps on, so the published record of processing and the
 * schedule that is actually followed cannot drift into contradicting each
 * other.
 *
 * `memory_retention_enabled` is read as `=== true` — not 'true', not 1, not
 * 'yes'. Orgs have carried `default_retention_days` for a long time as
 * documentation while the sweep expired nothing; honouring that number by
 * itself the day the sweep learned to work would have expired a year of
 * memories across every tenant, silently, because expiry is a status flip
 * with no user-visible event. This is the deliberate mirror image of the
 * per-user memory master switch (core/memory/memoryPolicy.js reads
 * `!== false` because memory defaults ON): each switch fails towards leaving
 * data alone. A settings read failure resolves to OFF for the same reason.
 *
 * Age is measured from the LAST CONFIRMATION, not from creation: a preference
 * the user restates every week must never age out, however old the row is.
 * Standing instructions are excluded entirely — dropping one changes the
 * assistant's behaviour with no event to connect it to.
 *
 * Iterates every organization so multi-tenant installs aren't silently
 * broken. Sequential execution to avoid pool contention.
 */

const { run, getOne } = require('../db');
const complianceStore = require('../stores/complianceStore');
const userStore = require('../stores/userStore');
const { recordJobRun } = require('../telemetry/metrics');
const log = require('../telemetry/log');

const INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The window used when an org enables retention without declaring one. */
const DEFAULT_RETENTION_DAYS = 365;

/**
 * Shortest window that is honoured. Below this the declared number is treated
 * as a typo (30 where 300 was meant is the plausible one) and the default is
 * used instead — a too-short window would expire almost everything on the
 * next tick, and there is no undo for a tenant-wide status flip.
 */
const MIN_RETENTION_DAYS = 60;

/** Rows one org's age sweep may expire per pass. */
const AGE_SWEEP_LIMIT = 5000;

/** Days a superseded row (history) is kept before it is deleted, on every install. */
const HARD_DELETE_DAYS = 90;
/** Rows per DELETE statement, and per run in total (the rest waits for tomorrow). */
const HARD_DELETE_BATCH = 1000;
const HARD_DELETE_RUN_CAP = 10000;

let _timer = null;
let _running = false;

/**
 * Resolve one org's retention policy from compliance_settings.
 *
 * @param {string} orgId
 * @returns {Promise<{enabled: boolean, days: number, reason: string}>}
 *   `enabled` is true only for an explicit boolean true; `days` is the
 *   declared window when it is a plausible integer, else the default.
 */
async function getRetentionPolicy(orgId) {
    let settings;
    try {
        settings = await complianceStore.getSettings(orgId);
    } catch (e) {
        // Unknown must narrow to "do nothing", never to "sweep on the default".
        log.warn(`[MemoryRetentionEnforcer] settings for "${orgId}" unreadable — retention OFF:`, e.message);
        return { enabled: false, days: DEFAULT_RETENTION_DAYS, reason: 'settings_unreachable' };
    }
    const enabled = settings?.memory_retention_enabled === true;
    const declared = settings?.default_retention_days;
    const days = Number.isInteger(declared) && declared >= MIN_RETENTION_DAYS
        ? declared
        : DEFAULT_RETENTION_DAYS;
    return { enabled, days, reason: enabled ? 'enabled' : 'disabled' };
}

/** 1. Deadline sweep: rows that carry their own TTL. */
async function _expireMemories() {
    try {
        const { rowCount } = await run(`
            UPDATE user_memories
            SET status = 'expired', updated_at = NOW()
            WHERE status = 'active'
              AND expires_at IS NOT NULL
              AND expires_at < NOW()
        `);
        return rowCount || 0;
    } catch (e) {
        log.warn('[MemoryRetentionEnforcer] expire query failed:', e.message);
        return 0;
    }
}

// Status flip, not DELETE: the row survives a subject-access export and stays
// restorable. Scoped to ONE org through the owning user's organization; the
// window arrives as a bound parameter, never interpolated.
const AGE_SWEEP_SQL = `
    UPDATE user_memories
    SET status = 'expired', updated_at = NOW()
    WHERE id IN (
        SELECT m.id
        FROM user_memories m
        JOIN users u ON u.id = m.user_id
        WHERE u."organizationId" = $1
          AND m.status = 'active'
          AND m.type <> 'instruction'
          AND COALESCE(m.last_confirmed_at, m.updated_at, m.created_at) < NOW() - ($2::int * INTERVAL '1 day')
        ORDER BY COALESCE(m.last_confirmed_at, m.updated_at, m.created_at) ASC
        LIMIT ${AGE_SWEEP_LIMIT}
    )
`;

/** 2. Age sweep, per org, only where enabled. Returns the total expired. */
async function _sweepByAge(orgIds) {
    let total = 0;
    for (const orgId of orgIds) {
        const policy = await getRetentionPolicy(orgId);
        if (!policy.enabled) continue;
        try {
            const { rowCount } = await run(AGE_SWEEP_SQL, [orgId, String(policy.days)]);
            const n = rowCount || 0;
            total += n;
            if (n > 0) {
                log.info(`[MemoryRetentionEnforcer] org "${orgId}": expired ${n} memories older than ${policy.days} days`);
            }
        } catch (e) {
            log.warn(`[MemoryRetentionEnforcer] age sweep for "${orgId}" failed:`, e.message);
        }
    }
    return total;
}

// Superseded rows are history: one statement removes them and their
// memory_sources, which have no foreign key to cascade. Aged from valid_to
// (backfilled from updated_at for legacy rows).
const HARD_DELETE_SQL = `
    WITH doomed AS (
        SELECT id FROM user_memories
        WHERE status = 'superseded'
          AND COALESCE(valid_to, updated_at, created_at) < NOW() - ($1::int * INTERVAL '1 day')
        ORDER BY id
        LIMIT $2
    ),
    gone AS (DELETE FROM user_memories WHERE id IN (SELECT id FROM doomed) RETURNING id),
    src AS (DELETE FROM memory_sources WHERE memory_id IN (SELECT id FROM gone))
    SELECT COUNT(*)::int AS n FROM gone
`;

// Archived and expired rows are restorable memories: only for one org (through
// the owning user), with that org's window. $1 org, $2 days, $3 batch.
const RESTORABLE_DELETE_SQL = `
    WITH doomed AS (
        SELECT m.id FROM user_memories m
        JOIN users u ON u.id = m.user_id
        WHERE u."organizationId" = $1
          AND m.status IN ('archived', 'expired')
          AND COALESCE(m.archived_at, m.valid_to, m.updated_at, m.created_at) < NOW() - ($2::int * INTERVAL '1 day')
        ORDER BY m.id
        LIMIT $3
    ),
    gone AS (DELETE FROM user_memories WHERE id IN (SELECT id FROM doomed) RETURNING id),
    src AS (DELETE FROM memory_sources WHERE memory_id IN (SELECT id FROM gone))
    SELECT COUNT(*)::int AS n FROM gone
`;

/** Batches of one statement until a short batch or the per-run cap. */
async function _deleteInBatches(sql, leadingParams, budget) {
    let total = 0;
    while (total < budget) {
        const res = await getOne(sql, [...leadingParams, HARD_DELETE_BATCH]);
        const n = res?.n || 0;
        total += n;
        if (n < HARD_DELETE_BATCH) break;
    }
    return total;
}

/** 3a. Hard delete of old history (superseded). Returns the number deleted. */
async function _hardDeleteHistory() {
    try {
        return await _deleteInBatches(HARD_DELETE_SQL, [String(HARD_DELETE_DAYS)], HARD_DELETE_RUN_CAP);
    } catch (e) {
        log.warn('[MemoryRetentionEnforcer] hard delete failed:', e.message);
        return 0;
    }
}

/** 3b. Hard delete of archived/expired rows, per org, only where retention is on. */
async function _hardDeleteRestorable(orgIds) {
    let total = 0;
    for (const orgId of orgIds) {
        const policy = await getRetentionPolicy(orgId);
        if (!policy.enabled) continue;
        try {
            const n = await _deleteInBatches(RESTORABLE_DELETE_SQL, [orgId, String(policy.days)], HARD_DELETE_RUN_CAP);
            total += n;
            if (n > 0) log.info(`[MemoryRetentionEnforcer] org "${orgId}": deleted ${n} archived/expired memories older than ${policy.days} days`);
        } catch (e) {
            log.warn(`[MemoryRetentionEnforcer] restorable delete for "${orgId}" failed:`, e.message);
        }
    }
    return total;
}

async function _listOrgIds() {
    const orgIds = new Set(['default']);
    try {
        const orgs = await userStore.getAllOrganizations();
        for (const o of orgs || []) {
            if (o?.id) orgIds.add(o.id);
        }
    } catch (e) {
        log.warn('[MemoryRetentionEnforcer] could not list orgs:', e.message);
    }
    return orgIds;
}

/** 3. Heartbeat, so the compliance check can see the job is alive. */
async function _stampHeartbeats(orgIds) {
    for (const orgId of orgIds) {
        try { await complianceStore.markRetentionRun(orgId); }
        catch (e) { log.warn(`[MemoryRetentionEnforcer] heartbeat for "${orgId}" failed:`, e.message); }
    }
}

async function runOnce() {
    if (_running) return;
    _running = true;
    const started = Date.now();
    let ok = true;
    try {
        const expired = await _expireMemories();
        const orgIds = await _listOrgIds();
        const aged = await _sweepByAge(orgIds);
        const deleted = await _hardDeleteHistory() + await _hardDeleteRestorable(orgIds);
        await _stampHeartbeats(orgIds);
        log.info(`[MemoryRetentionEnforcer] swept in ${Date.now() - started} ms — expired ${expired} by deadline, ${aged} by age, deleted ${deleted} old history rows`);
    } catch (e) {
        ok = false;
        throw e;
    } finally {
        _running = false;
        recordJobRun({ job: 'memory_retention', status: ok ? 'ok' : 'error', durationMs: Date.now() - started });
    }
}

function start() {
    if (_timer) return;
    // First sweep 2 minutes after boot so the DB is fully initialised.
    const initial = setTimeout(() => runOnce().catch(e =>
        log.warn('[MemoryRetentionEnforcer] initial sweep failed:', e.message)
    ), 120 * 1000);
    if (initial.unref) initial.unref();

    _timer = setInterval(() => {
        runOnce().catch(e =>
            log.warn('[MemoryRetentionEnforcer] scheduled sweep failed:', e.message)
        );
    }, INTERVAL_MS);
    if (_timer.unref) _timer.unref();
    log.info(`[MemoryRetentionEnforcer] Started — interval ${INTERVAL_MS / 3600000} h`);
}

function stop() {
    if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = {
    start, stop, runOnce,
    getRetentionPolicy,
    DEFAULT_RETENTION_DAYS, MIN_RETENTION_DAYS, AGE_SWEEP_LIMIT,
    HARD_DELETE_DAYS, HARD_DELETE_BATCH, HARD_DELETE_RUN_CAP, HARD_DELETE_SQL, RESTORABLE_DELETE_SQL,
};
