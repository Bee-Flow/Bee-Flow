// @typecheck
/**
 * Platform Module Install Store — durable, cross-replica install progress.
 *
 * One row per module currently (or last) being installed/updated/rolled back.
 * The row doubles as a LEASE: acquire() wins only when no live install holds
 * the module (finished, or heartbeat stale past LEASE_STALE_SECONDS — a
 * replica that died mid-install). Progress is dual-written by packageLoader
 * (in-memory for the fast poll path, here for other replicas + restarts).
 *
 * Terminal rows (finished_at set) are kept for TERMINAL_TTL_MS so the SPA's
 * progress poll can still see the outcome, then read as absent.
 */

const { run, getOne, exec } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const log = require('../telemetry/log');
const { parseJSONObject: parseJSON } = require('./lib/json');

const LEASE_STALE_SECONDS = 90;
const TERMINAL_TTL_MS = 10 * 60 * 1000;

const initDB = makeStoreInit('PlatformModuleInstallStore', _initDB);

async function _initDB() {
    await exec(`
        CREATE TABLE IF NOT EXISTS platform_module_installs (
            module_id TEXT PRIMARY KEY,
            version TEXT,
            phase TEXT NOT NULL,
            pct INTEGER,
            error TEXT,
            detail JSONB,
            actor TEXT,
            replica TEXT,
            started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            finished_at TIMESTAMPTZ
        );
    `);
    log.info('[PlatformModuleInstallStore] PostgreSQL initialized');
}


function mapRow(r) {
    if (!r) return null;
    return {
        moduleId: r.module_id,
        version: r.version || null,
        phase: r.phase,
        pct: r.pct == null ? null : Number(r.pct),
        error: r.error || null,
        detail: parseJSON(r.detail, null),
        actor: r.actor || null,
        replica: r.replica || null,
        startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
        heartbeatAt: r.heartbeat_at ? new Date(r.heartbeat_at).toISOString() : null,
        finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
    };
}

/**
 * Try to take the install lease for a module. Single statement: the INSERT
 * wins outright, the conditional UPDATE takes over only a FINISHED or
 * heartbeat-STALE row. Returns the lease row when acquired, null when another
 * live install holds it.
 */
async function acquire(moduleId, { version = null, actor = null, replica = null } = {}) {
    await initDB();
    const res = await run(
        `INSERT INTO platform_module_installs
            (module_id, version, phase, pct, error, detail, actor, replica, started_at, heartbeat_at, finished_at)
         VALUES ($1, $2, 'starting', 0, NULL, NULL, $3, $4, NOW(), NOW(), NULL)
         ON CONFLICT (module_id) DO UPDATE SET
            version = EXCLUDED.version,
            phase = 'starting', pct = 0, error = NULL, detail = NULL,
            actor = EXCLUDED.actor, replica = EXCLUDED.replica,
            started_at = NOW(), heartbeat_at = NOW(), finished_at = NULL
         WHERE platform_module_installs.finished_at IS NOT NULL
            OR platform_module_installs.heartbeat_at < NOW() - INTERVAL '${LEASE_STALE_SECONDS} seconds'
         RETURNING *`,
        [moduleId, version, actor, replica]
    );
    const row = res && res.rows && res.rows[0];
    return row ? mapRow(row) : null;
}

/** Progress write + heartbeat. Terminal phases ('done'/'error') stamp finished_at. */
async function setPhase(moduleId, phase, pct = null, { error = null, detail = null } = {}) {
    await initDB();
    const terminal = phase === 'done' || phase === 'error';
    await run(
        `UPDATE platform_module_installs SET
            phase = $2, pct = $3, error = $4,
            detail = COALESCE($5, detail),
            heartbeat_at = NOW(),
            finished_at = CASE WHEN $6::boolean THEN NOW() ELSE NULL END
          WHERE module_id = $1`,
        [moduleId, phase, pct, error ? String(error).slice(0, 2000) : null,
            detail ? JSON.stringify(detail) : null, terminal]
    );
}

/**
 * Read a module's install progress. Terminal rows older than the TTL read as
 * absent (null) so the poller stops seeing week-old outcomes.
 */
async function get(moduleId) {
    await initDB();
    const row = mapRow(await getOne(
        `SELECT * FROM platform_module_installs WHERE module_id = $1`, [moduleId]
    ));
    if (!row) return null;
    if (row.finishedAt && (Date.now() - Date.parse(row.finishedAt)) > TERMINAL_TTL_MS) return null;
    return row;
}

module.exports = { initDB, acquire, setPhase, get, LEASE_STALE_SECONDS, TERMINAL_TTL_MS };
