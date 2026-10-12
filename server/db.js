/**
 * Shared Database Connections — PostgreSQL + Redis
 *
 *   - PostgreSQL via `pg` Pool for persistent data (beeflow_core)
 *   - Redis via `ioredis` for caching, rate limits, ephemeral state
 *     (session store uses a separate `node-redis` client in index.js)
 *
 * All stores should import { pool, getRedis, ... } from '../db';
 *
 * Pool sizing rationale for 50 active users:
 *   - max:40  — allows concurrent AI streaming (long-held connections) +
 *               regular CRUD queries without timeouts.
 *   - statement_timeout:30s — kills runaway queries before they occupy
 *               a connection slot indefinitely.
 *   - idle_in_transaction_session_timeout:60s — guards against hung
 *               transactions that block pool slots.
 *   - application_name — visible in pg_stat_activity for monitoring.
 */

const { Pool } = require('pg');
const Redis = require('ioredis');
const log = require('./telemetry/log');

// The store schema-init memo. It lives in stores/lib/storeInit.js — it is
// promise bookkeeping, not pool work, and the hermetic store doubles that
// replace this module must not be able to take it away. Re-exported here
// because `db.makeStoreInit` is the seam a test overrides to neutralise
// schema creation, and migrateDb reads it from this facade.
const { makeStoreInit } = require('./stores/lib/storeInit');

// ── PostgreSQL ──────────────────────────────────────────
// Core database for users, agents, configs, conversations, etc.
//
// Refuse to boot in production without an explicit connection string:
// silently falling back to the localhost dev default would start the
// server against the wrong database (or a database that does not exist,
// surfacing as confusing runtime connection errors). Same fail-fast
// policy as the MASTER_ENCRYPTION_KEY / SESSION_SECRET checks in
// index.js, but done here because db.js is imported before those run.
if (process.env.NODE_ENV === 'production' && !process.env.CORE_DATABASE_URL) {
    throw new Error('CORE_DATABASE_URL must be set in production; there is no development default to fall back to. The docker-compose files wire it from DB_USER/DB_PASSWORD/DB_NAME.');
}
const pool = new Pool({
    connectionString: process.env.CORE_DATABASE_URL
        || 'postgresql://beeflow:beeflow@localhost:5432/beeflow_core',
    // 40 connections: comfortably handles 50 concurrent users with AI
    // streaming (which holds connections open for 30–120 s each).
    max: 40,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    // Kill queries that run longer than 30 s — prevents stuck queries
    // from holding a pool slot and blocking other users.
    statement_timeout: 30000,
    // Kill transactions left open for > 60 s (e.g. a crashed request
    // that never committed/rolled back).
    idle_in_transaction_session_timeout: 60000,
    // Visible in pg_stat_activity so you can identify beeflow connections.
    application_name: 'beeflow-server',
});

pool.on('error', (err) => {
    log.error('[DB] Unexpected PG pool error:', err.message);
});

// ── Pool pressure monitoring ─────────────────────────────
// Log a warning when >10 queries are queued waiting for a free
// connection — an early signal that the pool is under pressure.
const POOL_WARN_THRESHOLD = 10;
let _poolWarnLogged = false;
setInterval(() => {
    const waiting = pool.waitingCount;
    if (waiting > POOL_WARN_THRESHOLD) {
        if (!_poolWarnLogged) {
            log.warn(`[DB] Pool pressure: ${waiting} queries waiting for a free connection (total=${pool.totalCount}, idle=${pool.idleCount}). Consider scaling.`);
            _poolWarnLogged = true;
        }
    } else {
        _poolWarnLogged = false; // reset so we warn again if it spikes again
    }
}, 5000).unref(); // unref so this timer doesn't keep the process alive

// ── Redis ───────────────────────────────────────────────
// Wrapped in an object so getRedis() always returns the current state,
// avoiding the export-by-value staleness bug with `let redis`.
const _redis = { client: null };

/**
 * The ioredis options of the shared client.
 * @param {string} url
 */
function _redisOptions(url) {
    return {
        maxRetriesPerRequest: 3,
        lazyConnect: true,
        // Keep reconnecting after an outage, backing off to 30 s. Giving
        // up (returning null) left a dead client for the rest of the
        // process: every cross-replica publish failed and the live feeds
        // silently fell back to polling until a restart.
        retryStrategy(times) {
            return Math.min(times * 200, 30_000);
        },
        // Scaleway managed Redis uses an internal CA — encryption stays on,
        // cert validation is scoped to this client only (not the whole
        // process). Set REDIS_TLS_STRICT=1 once a CA bundle is wired in.
        ...(String(url).startsWith('rediss://') ? {
            tls: { rejectUnauthorized: process.env.REDIS_TLS_STRICT === '1' }
        } : {})
    };
}

/**
 * Commands fail at once while Redis is down, instead of waiting in ioredis'
 * offline queue until four reconnect attempts have failed: with reconnects
 * that never give up, that wait grows with the outage (seconds, then
 * minutes), and requireAuth, the session tokens and OPAQUE login await Redis
 * on every request. Every caller falls back (Postgres, memory, the
 * in-process bus), so failing fast is what degrades; waiting hangs the app.
 *
 * The queue stays on until the first connection is up, so what boot sends
 * waits for it. A duplicated client (a pub/sub subscriber) keeps its own
 * queue: it subscribes before it has connected.
 * @param {any} client an ioredis client
 */
function _failFastWhenDisconnected(client) {
    client.once('ready', () => { client.options.enableOfflineQueue = false; });
    const duplicate = client.duplicate.bind(client);
    client.duplicate = (/** @type {object} */ override) => duplicate({ enableOfflineQueue: true, ...(override || {}) });
    return client;
}

if (process.env.REDIS_URL) {
    try {
        _redis.client = _failFastWhenDisconnected(new Redis(process.env.REDIS_URL, _redisOptions(process.env.REDIS_URL)));
        _redis.client.on('error', (err) => {
            log.warn('[DB] Redis error:', err.message);
        });
        const client = _redis.client;
        client.connect().catch(err => {
            log.warn('[DB] Redis connection failed:', err.message);
            // Not reachable at boot: run without it (as before), and stop the
            // background reconnects of a client nothing references any more.
            try { client.disconnect(); } catch (_) { /* already closed */ }
            if (_redis.client === client) _redis.client = null;
        });
    } catch (err) {
        log.warn('[DB] Redis unavailable:', err.message);
    }
} else {
    log.info('[DB] No REDIS_URL configured, Redis disabled');
}

/** Get the current Redis client (or null if unavailable). */
function getRedis() { return _redis.client; }

/** True when Redis is connected and ready for commands. */
function redisHealthy() { return _redis.client?.status === 'ready'; }

/** Gracefully disconnect Redis (call during shutdown). */
async function disconnectRedis() {
    if (_redis.client) {
        try { await _redis.client.quit(); } catch (_) { /* ignore */ }
        _redis.client = null;
    }
}

// ── Async Query Helpers ─────────────────────────────────

// Lightweight query instrumentation: records duration into httpMetrics and
// logs slow queries. We log ONLY a sanitized SQL prefix + the param COUNT —
// never param values, which can contain PII or secrets.
const metrics = require('./telemetry/httpMetrics');
const DB_SLOW_MS = metrics.DB_SLOW_MS;

function _sanitizeSql(sql) {
    return String(sql).replace(/\s+/g, ' ').trim().slice(0, 200);
}

async function _timedQuery(sql, params) {
    const start = process.hrtime.bigint();
    try {
        return await pool.query(sql, params);
    } finally {
        try {
            const ms = Number(process.hrtime.bigint() - start) / 1e6;
            metrics.recordQuery(ms);
            if (ms > DB_SLOW_MS) {
                log.warn(`[DB] Slow query ${ms.toFixed(0)}ms (params=${Array.isArray(params) ? params.length : 0}): ${_sanitizeSql(sql)}`);
            }
        } catch (_) { /* instrumentation must never break a query */ }
    }
}

/**
 * Execute a query (INSERT, UPDATE, DELETE, DDL).
 * @param {string} sql - SQL with $1, $2 placeholders
 * @param {any[]} params
 * @returns {Promise<{ rowCount: number, rows: any[] }>}
 */
async function run(sql, params = []) {
    return _timedQuery(sql, params);
}

/**
 * Get a single row.
 * @param {string} sql
 * @param {any[]} params
 * @returns {Promise<object|null>}
 */
async function getOne(sql, params = []) {
    const { rows } = await _timedQuery(sql, params);
    return rows[0] || null;
}

/**
 * Get all matching rows.
 * @param {string} sql
 * @param {any[]} params
 * @returns {Promise<object[]>}
 */
async function getAll(sql, params = []) {
    const { rows } = await _timedQuery(sql, params);
    return rows;
}

/**
 * Execute raw SQL (e.g., schema init).
 * Uses a PostgreSQL advisory lock for CREATE TABLE/ALTER TABLE statements
 * to prevent pg_type_typname_nsp_index race conditions on fresh databases.
 * @param {string} sql
 */
let _schemaQueue = Promise.resolve();
async function exec(sql) {
    // CREATE TABLE / ALTER TABLE statements must be serialized to prevent
    // PostgreSQL implicit row-type creation races on fresh DBs.
    // We use a JS-level queue + a dedicated client connection so we don't
    // exhaust the pool with concurrent DDL calls.
    if (sql.includes('CREATE TABLE') || sql.includes('ALTER TABLE') || sql.includes('CREATE INDEX')) {
        return new Promise((resolve, reject) => {
            _schemaQueue = _schemaQueue.then(async () => {
                const client = await pool.connect();
                try {
                    return await client.query(sql);
                } finally {
                    client.release();
                }
            }).then(resolve, reject);
        });
    }
    return pool.query(sql);
}

/**
 * Get a client from the pool for transactions.
 * Prefer withTransaction() below — it guarantees COMMIT/ROLLBACK/release.
 * Use getClient() directly only when you need manual control (e.g. a cursor
 * or advisory-lock lifetime that spans multiple logical steps).
 *   const client = await getClient();
 *   try {
 *     await client.query('BEGIN');
 *     ...
 *     await client.query('COMMIT');
 *   } catch (e) {
 *     await client.query('ROLLBACK');
 *     throw e;
 *   } finally {
 *     client.release();
 *   }
 */
async function getClient() {
    return pool.connect();
}

/** Marks a checkout as already wrapped, so re-entry cannot stack wrappers. */
const INSTRUMENTED = Symbol('beeflow.instrumented');

/**
 * Wrap a pooled client's `query` with the same slow-query instrumentation as
 * the top-level helpers, so queries issued inside a transaction also land in
 * metrics. Non-string calls (Cursor/QueryStream submittables, config objects)
 * pass through untouched so streaming/cursor usage keeps working.
 *
 * ── TWO RULES THIS WRAPPER MUST OBEY, AND WHY ───────────────────────
 * A pooled client is not ours. It is lent for the length of one transaction and
 * then handed back to `pg` for the next borrower — who may be `pg-pool` itself.
 * Both rules below exist because breaking either one hangs a request FOREVER
 * rather than failing it.
 *
 *   1. FORWARD EVERY ARGUMENT. `pg-pool`'s own `Pool.query(text, values, cb)`
 *      calls `client.query(text, values, callback)` — the CALLBACK form. A
 *      wrapper declared `(sql, params)` silently drops that third argument, so
 *      `pg` takes the promise path instead, settles a promise nobody is
 *      holding, and the pool's callback never fires. The statement completes in
 *      Postgres (the backend goes `idle`), the caller waits for ever, and
 *      nothing is logged anywhere. Not theoretical: this is what made every
 *      Datatables write appear to hang while its row was already committed.
 *
 *   2. HAND THE CLIENT BACK UNMODIFIED. `client.query` is replaced here as an
 *      OWN property, and `release()` returns the connection to the pool with
 *      that property still installed — so the mutation outlives the transaction
 *      and follows the connection to its next borrower. Restoring on release is
 *      what keeps rule 1 from being one `pool.query` away from mattering again,
 *      and it also stops a re-checkout from stacking a second wrapper on the
 *      first. Restore by DELETING the own property when there was none, so the
 *      prototype method comes back rather than a bound copy of it.
 *
 * @param {import('pg').PoolClient} client
 * @returns {import('pg').PoolClient} the same client, wrapped for this checkout only
 */
function _instrumentClient(client) {
    if (client[INSTRUMENTED]) return client;

    const hadOwnQuery = Object.prototype.hasOwnProperty.call(client, 'query');
    const prevQuery = client.query;
    const _origQuery = client.query.bind(client);
    const _origRelease = client.release;

    client[INSTRUMENTED] = true;
    client.query = (...args) => {
        const [sql, params] = args;
        if (typeof sql !== 'string') {
            return _origQuery(...args);   // submittable / config form — don't touch
        }
        const start = process.hrtime.bigint();
        const record = () => {
            try {
                const ms = Number(process.hrtime.bigint() - start) / 1e6;
                metrics.recordQuery(ms);
                if (ms > DB_SLOW_MS) {
                    log.warn(`[DB] Slow query ${ms.toFixed(0)}ms (params=${Array.isArray(params) ? params.length : 0}): ${_sanitizeSql(sql)}`);
                }
            } catch (_) { /* instrumentation must never break a query */ }
        };

        // Callback form: measure around the callback and pass it through
        // untouched. Never convert it into a promise — see rule 1.
        const last = args[args.length - 1];
        if (typeof last === 'function') {
            args[args.length - 1] = (...cbArgs) => { record(); return last(...cbArgs); };
            return _origQuery(...args);
        }

        const out = _origQuery(...args);
        // Only a thenable gets the promise treatment: a submittable passed as a
        // later argument must be returned exactly as `pg` returned it.
        return (out && typeof out.finally === 'function') ? out.finally(record) : out;
    };

    client.release = function instrumentedRelease(...args) {
        // Restore BEFORE releasing: the moment release() returns, this
        // connection can already be answering someone else's query.
        if (hadOwnQuery) client.query = prevQuery;
        else delete client.query;
        client.release = _origRelease;
        delete client[INSTRUMENTED];
        return typeof _origRelease === 'function' ? _origRelease.apply(client, args) : undefined;
    };

    return client;
}

/**
 * Core transaction runner (client-injectable for tests): BEGIN → fn → COMMIT,
 * ROLLBACK on any throw, release in finally. Never leaks the client.
 * @param {import('pg').PoolClient} client
 * @param {(client: import('pg').PoolClient) => Promise<any>} fn
 */
async function _runTransaction(client, fn) {
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) { /* connection may be dead */ }
        throw e;
    } finally {
        client.release();
    }
}

/**
 * Run `fn` inside a transaction with guaranteed COMMIT/ROLLBACK/release.
 * Replaces the 29 hand-rolled BEGIN/COMMIT/ROLLBACK/release blocks — a single
 * missed release() leaks a slot from the max-40 pool, so one hardened copy
 * removes that whole class of bug.
 * Usage:
 *   const version = await withTransaction(async (client) => {
 *     const { rows } = await client.query('SELECT ... FOR UPDATE', [id]);
 *     await client.query('UPDATE ...', [id]);
 *     return rows[0].version;
 *   });
 * @param {(client: import('pg').PoolClient) => Promise<any>} fn
 */
async function withTransaction(fn) {
    const client = _instrumentClient(await pool.connect());
    return _runTransaction(client, fn);
}

/**
 * Did the database actually answer, or did we never reach it?
 *
 * Postgres rejects a statement with a 5-character SQLSTATE (`42P01`, `58P01`,
 * `42501`, ...). A pool timeout, a refused socket or a dropped connection
 * carries no SQLSTATE — either no `code` at all ("Connection terminated due to
 * connection timeout") or a libuv name like `ECONNREFUSED`/`ETIMEDOUT`.
 *
 * The SQLSTATE shape alone is NOT enough to tell them apart: `EPIPE` is also
 * five uppercase characters. So we additionally require `severity`, which pg
 * parses off the wire ErrorResponse and therefore only ever sets on an error
 * the server itself sent.
 *
 * The distinction is load-bearing for capability probes. `CREATE EXTENSION IF
 * NOT EXISTS vector` failing because the extension is absent is a permanent
 * fact worth caching; the same call failing because boot saturated the pool is
 * transient, and caching THAT silently disables vector search for the whole
 * process lifetime.
 *
 * @param {any} err - the rejected error
 * @returns {boolean} true when Postgres answered with a SQL-level error
 */
function isSqlStateError(err) {
    return typeof err?.code === 'string'
        && /^[0-9A-Z]{5}$/.test(err.code)
        && typeof err.severity === 'string';
}

/**
 * Returns current pool statistics for health checks and monitoring.
 */
function getPoolStats() {
    return {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
    };
}

module.exports = {
    pool,
    getRedis,
    redisHealthy,
    disconnectRedis,
    run,
    getOne,
    getAll,
    exec,
    getClient,
    withTransaction,
    makeStoreInit,
    isSqlStateError,
    getPoolStats,
    // internal — exported for unit tests (DB-free)
    _runTransaction,
    _instrumentClient,
    _redisOptions,
    _failFastWhenDisconnected,
};
