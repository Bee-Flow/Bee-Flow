// @typecheck
'use strict';
/**
 * Small helpers the pattern sources share: time parsing, abort checks, the
 * error a source throws, a tool-result check, opaque grouping keys and the
 * stored sources' database access.
 *
 * No I/O of its own: the database is required lazily, and only by
 * defaultDb().
 */

const crypto = require('crypto');

const DAY = 86_400_000;

/**
 * A source failure with a reason code the scan can show ('auth', 'error',
 * 'timeout', 'budget', 'aborted', 'not_connected', 'shield'). The message is for the
 * server log only; the code is what reaches the client.
 * @param {string} code
 * @param {string} [message]
 * @returns {Error & { code: string }}
 */
function sourceError(code, message) {
    const err = /** @type {Error & { code: string }} */ (new Error(message || code));
    err.code = code;
    return err;
}

/** @param {AbortSignal|undefined|null} signal */
function throwIfAborted(signal) {
    if (signal?.aborted) throw sourceError('aborted', 'scan aborted');
}

const AUTH_RE = /\b(?:401|403|unauthori[sz]ed|forbidden|not connected|log ?in|re-?auth|expired token|invalid_grant)\b/i;

/**
 * Connectors report trouble two ways: they throw, or they return
 * `{ error: '…' }`. Either way the source stops with a code.
 * @param {any} result
 * @param {string} tool
 * @returns {any} the result, when it is usable
 */
function checkToolResult(result, tool) {
    if (!result || typeof result !== 'object') throw sourceError('error', `${tool}: empty result`);
    if (result.error) {
        const msg = String(result.error);
        throw sourceError(AUTH_RE.test(msg) ? 'auth' : 'error', `${tool}: ${msg.slice(0, 200)}`);
    }
    return result;
}

/**
 * Epoch ms from a Date, an ISO/RFC 2822 string, or unix seconds/ms.
 * @param {any} v
 * @returns {number} NaN when unparseable
 */
function toMs(v) {
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
    if (typeof v === 'string' && /^\d+$/.test(v.trim())) return toMs(Number(v));
    if (typeof v === 'string' && v.trim()) return Date.parse(v);
    return NaN;
}

/**
 * Within the scan window, with a little slack for clock skew at the top.
 * @param {number} ts
 * @param {{ since: number, now: number }} win
 */
function inWindow(ts, win) {
    return Number.isFinite(ts) && ts >= win.since && ts <= win.now + 5 * 60_000;
}

/**
 * An opaque key for an identifier that only groups events (a meeting series,
 * a folder). The real id never leaves the source: equal ids give equal keys,
 * nothing more.
 * @param {string} kind
 * @param {string} value
 */
function opaqueKey(kind, value) {
    const h = crypto.createHash('sha256').update(`${kind}|${value}`).digest('hex').slice(0, 16);
    return `${kind}:${h}`;
}

/** @typedef {{ query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> }} Db */

/**
 * What a live collector gets from collectAll: the window, the scan's stop
 * signal, the guarded tool executor and the per-scan domain pseudonymiser.
 * @typedef {{
 *   since: number, now: number, windowDays: number, signal?: AbortSignal,
 *   executeTool: (name: string, args: object) => Promise<any>,
 *   pseudoDomain: (domain: string) => string,
 * }} LiveCtx
 */

/** The real pool, behind the small `db` shape tests replace with pglite. @returns {Db} */
function defaultDb() {
    return { query: (sql, params) => require('../../../db').run(sql, params) };
}

// undefined_table, undefined_column: an older install that lacks a table or a
// column has no rows of that kind, which is not a failed scan.
const MISSING_SCHEMA = new Set(['42P01', '42703']);

/**
 * @param {Db} db
 * @param {string} sql
 * @param {any[]} params
 * @returns {Promise<any[]>}
 */
async function queryRows(db, sql, params) {
    try {
        const { rows } = await db.query(sql, params);
        return rows || [];
    } catch (err) {
        if (MISSING_SCHEMA.has(/** @type {any} */ (err)?.code)) return [];
        throw err;
    }
}

module.exports = {
    DAY, sourceError, throwIfAborted, checkToolResult, toMs, inWindow, opaqueKey, defaultDb, queryRows,
};
