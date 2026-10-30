// @typecheck strict
/**
 * Driver wrapper for the Firebird integration (npm `node-firebird`, pure JS).
 *
 * One attachment per call: attach, open a READ ONLY transaction, stream the rows,
 * commit, detach (always, in a finally). Nothing is pooled or kept between calls,
 * so no credential or connection outlives the tool call.
 */
const { CONNECT_TIMEOUT_MS, getStatementTimeoutMs } = require('./firebirdToolDefs');
const { serialiseRow } = require('./firebirdQuery');
const { bestEffort } = require('../utils/bestEffort');

const GDS_LOGIN = 335544472;
const GDS_UNAVAILABLE = [335544375, 335544421];
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'EPIPE']);
const MAX_ERROR_CHARS = 300;

/**
 * @typedef {{ host: string, port: number, database: string, user: string, password: string, charset: string }} FirebirdCreds
 * @typedef {{ rows: Record<string, unknown>[], columns: string[], truncated: boolean }} QueryResult
 * @typedef {{ limit?: number, timeoutMs?: number }} QueryOptions
 * @typedef {{
 *   sequentiallyAsync: (sql: string, params: unknown[], onRow: (row: Record<string, unknown>) => void, opts: { timeout: number }) => Promise<void>,
 *   commitAsync: () => Promise<void>,
 *   rollbackAsync: () => Promise<void>,
 * }} FirebirdTx
 * @typedef {{
 *   transactionAsync: (opts: { isolation: unknown, readOnly: boolean }) => Promise<FirebirdTx>,
 *   detachAsync: () => Promise<void>,
 * }} FirebirdDb
 */

/**
 * The slice of the node-firebird API this module uses; a test injects a fake.
 * @typedef {{
 *   ISOLATION_READ_COMMITTED_READ_ONLY: unknown,
 *   attachAsync: (options: Record<string, unknown>) => Promise<FirebirdDb>,
 * }} FirebirdDriver
 */

/** @type {FirebirdDriver | null} */
let injectedDriver = null;

/** @returns {FirebirdDriver} */
function getDriver() {
    if (injectedDriver) return injectedDriver;
    return /** @type {FirebirdDriver} */ (/** @type {unknown} */ (require('node-firebird')));
}

/**
 * Test seam: replace the driver (null restores the real one).
 * @param {FirebirdDriver | null} driver
 */
function _setDriverForTests(driver) {
    injectedDriver = driver;
}

// Thrown from the row callback to end the stream once limit + 1 rows have arrived.
const STOP = new Error('stop streaming');

/**
 * @param {FirebirdCreds} creds
 * @returns {Record<string, unknown>}
 */
function attachOptions(creds) {
    return {
        host: creds.host,
        port: creds.port,
        database: creds.database,
        user: creds.user,
        password: creds.password,
        encoding: creds.charset,
        lowercase_keys: false,
        blobAsText: true,
        connectTimeout: CONNECT_TIMEOUT_MS,
    };
}

/**
 * Reject when `promise` takes longer than `ms`. The timer never keeps the process alive.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} message
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, message) {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
        timer.unref();
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ─── Errors ────────────────────────────────────────────────────

/**
 * A driver error as a short message that never contains the password.
 * @param {unknown} err
 * @param {FirebirdCreds} creds
 * @param {boolean} [connecting] true while attaching
 */
function mapFirebirdError(err, creds, connecting = false) {
    const e = /** @type {{ message?: unknown, gdscode?: unknown, code?: unknown }} */ (err && typeof err === 'object' ? err : {});
    const where = `${creds.host}:${creds.port}`;
    let message = String(e.message || 'unknown error').replace(/\s+/g, ' ').trim();
    if (creds.password) message = message.split(creds.password).join('***');
    if (message.length > MAX_ERROR_CHARS) message = `${message.slice(0, MAX_ERROR_CHARS)}…`;
    const gds = Number(e.gdscode);
    if (gds === GDS_LOGIN) return `Login to ${where} failed: wrong user name or password (GDS ${GDS_LOGIN}). ${message}`;
    if (GDS_UNAVAILABLE.includes(gds)) return `Database unavailable at ${where} (GDS ${gds}): ${message}`;
    if (typeof e.code === 'string' && NETWORK_CODES.has(e.code)) return `Could not connect to ${where} (${e.code}): ${message}`;
    const gdsPart = Number.isFinite(gds) && gds > 0 ? ` (GDS ${gds})` : '';
    return connecting ? `Could not connect to ${where}${gdsPart}: ${message}` : `Firebird error${gdsPart}: ${message}`;
}

// ─── Query ─────────────────────────────────────────────────────

/**
 * Attach, bounded by the connect timeout (the driver's own option does not cover a silent server).
 * @param {FirebirdDriver} driver
 * @param {FirebirdCreds} creds
 */
async function attach(driver, creds) {
    const pending = driver.attachAsync(attachOptions(creds));
    try {
        return await withTimeout(pending, CONNECT_TIMEOUT_MS, 'connection timed out');
    } catch (err) {
        // A late attach must not leave a connection behind.
        pending.then((late) => late.detachAsync()).catch((e) => bestEffort('firebirdClient:lateDetach', e));
        throw err;
    }
}

/**
 * Commit (read-only, so harmless even after an aborted stream), falling back to rollback; then detach.
 * Neither step may throw: the original outcome is what the caller needs.
 * @param {FirebirdDb | null} db
 * @param {FirebirdTx | null} tx
 */
async function finish(db, tx) {
    if (tx) {
        try {
            await tx.commitAsync();
        } catch (commitErr) {
            bestEffort('firebirdClient:commit', commitErr);
            try { await tx.rollbackAsync(); } catch (e) { bestEffort('firebirdClient:rollback', e); /* the detach below ends it */ }
        }
    }
    if (db) {
        try { await db.detachAsync(); } catch (e) { bestEffort('firebirdClient:detach', e); /* connection already gone */ }
    }
}

/**
 * Run one statement in a read-only transaction and stream the rows, stopping at limit + 1
 * (the extra row only proves there is more, it is dropped).
 * Resolves with serialised rows; rejects with an Error whose message is safe to show.
 * @param {FirebirdCreds} creds
 * @param {string} sql
 * @param {unknown[]} [params]
 * @param {QueryOptions} [options]
 * @returns {Promise<QueryResult>}
 */
async function runQuery(creds, sql, params = [], options = {}) {
    const driver = getDriver();
    const limit = options.limit ?? Infinity;
    const timeout = options.timeoutMs ?? getStatementTimeoutMs();
    /** @type {FirebirdDb | null} */ let db = null;
    /** @type {FirebirdTx | null} */ let tx = null;
    let connecting = true;
    /** @type {Record<string, unknown>[]} */
    const rows = [];
    let truncated = false;
    try {
        db = await attach(driver, creds);
        connecting = false;
        tx = await db.transactionAsync({ isolation: driver.ISOLATION_READ_COMMITTED_READ_ONLY, readOnly: true });
        await tx.sequentiallyAsync(sql, params, (/** @type {Record<string, unknown>} */ row) => {
            if (rows.length >= limit) {
                truncated = true;
                throw STOP;
            }
            rows.push(serialiseRow(row));
        }, { timeout }).catch((/** @type {unknown} */ err) => {
            if (err !== STOP) throw err;
        });
        return { rows, columns: rows.length ? Object.keys(rows[0]) : [], truncated };
    } catch (err) {
        throw new Error(mapFirebirdError(err, creds, connecting));
    } finally {
        await finish(db, tx);
    }
}

module.exports = { runQuery, mapFirebirdError, attachOptions, withTimeout, _setDriverForTests };
