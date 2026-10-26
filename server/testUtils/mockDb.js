// @typecheck strict
/**
 * Recording mock for `../db` — shared test harness (H2).
 *
 * 16+ store/route tests each re-implemented the same in-memory Postgres double:
 * a dispatcher that records every SQL+params pair and answers SELECT/mutation
 * queries by matching `col = $n` equalities from the WHERE clause. That double
 * is what makes the cross-tenant IDOR regression tests real (a foreign id must
 * not satisfy the owner-scoped WHERE), so it must stay auditable and identical
 * across suites — one shared copy instead of N drifting ones.
 *
 * The helper provides the plumbing (recording, dispatch, reset, mutation
 * filter) and the common WHERE-equality matcher. Each suite supplies its own
 * row fixtures and, for the rare query the equality matcher can't model
 * (an OR disjunction, a join), a per-table `matchers` override.
 *
 * Exposes the full db surface used by stores: run/getOne/getAll/exec/getClient
 * AND withTransaction/makeStoreInit/pool — so a store using either the helper
 * functions or a transaction runs against the same recorded dispatcher,
 * including the statements issued inside BEGIN…COMMIT.
 *
 * Usage:
 *   const { createRecordingDb } = require('../testUtils/mockDb');
 *   const mock = createRecordingDb({ tables: { studio_apps: appRows } });
 *   const restore = mock.attachPool();   // the real ../db, its pool answered by the double
 *   const store = require('./studioAppStore');
 * (`mock.db` is the same double as a stand-in for the whole `../db` module, for
 * code that takes its db injected: `makeStore({ db: mock.db })`.)
 *   ...
 *   mock.reset();
 *   assert.ok(mock.mutations().every(c => /user_id\s*=\s*\$/i.test(c.sql)));
 */

const log = require('../telemetry/log');
const { TransactionRollback } = require('../utils/txRollback');

/**
 * @param {object} [opts]
 * @param {Record<string, Record<string, any>[]>} [opts.tables] table name → seed rows
 * @param {Record<string, (rows: Record<string, any>[], sql: string, params: any[]) => Record<string, any>[]>} [opts.matchers]
 *   per-table override for queries the default equality matcher can't model
 * @param {(sql: string, params: any[]) => ({rows: Record<string, any>[], rowCount: number}) | undefined} [opts.onQuery]
 *   optional escape hatch: return a result to fully override dispatch for a query
 */
function createRecordingDb({ tables = {}, matchers = {}, onQuery } = {}) {
    /** @typedef {{ sql: string, params: unknown[] }} RecordedCall */
    /** @type {{ run: RecordedCall[], getOne: RecordedCall[], getAll: RecordedCall[], client: RecordedCall[], exec: Array<{ sql: string }>, pool: RecordedCall[] }} */
    const calls = { run: [], getOne: [], getAll: [], client: [], exec: [], pool: [] };

    // Route a statement to the first registered table it names.
    /**
     * @param {string} sql
     */
    function tableFor(sql) {
        for (const name of Object.keys(tables)) {
            if (new RegExp(`\\b${name}\\b`, 'i').test(sql)) return name;
        }
        return null;
    }

    // Extract `col = $n` equalities from the WHERE clause only (SET clauses in
    // an UPDATE must not pollute the condition list).
    /**
     * @param {string} sql
     * @param {unknown[]} params
     */
    function whereConds(sql, params) {
        const m = sql.match(/\bWHERE\b([\s\S]*)/i);
        if (!m) return [];
        return [...m[1].matchAll(/([a-z_]+)\s*=\s*\$(\d+)/gi)]
            .map((x) => /** @type {[string, unknown]} */ ([x[1], params[Number(x[2]) - 1]]));
    }

    /**
     * @param {string} sql
     * @param {unknown[]} params
     */
    function matchRows(sql, params) {
        const name = tableFor(sql);
        const rows = name ? tables[name] : [];
        if (name && matchers[name]) {
            // A matcher handles the queries the equality matcher can't (OR, join)
            // and may return `undefined` to fall back to default equality for the
            // ordinary owner-scoped statements against the same table.
            const custom = matchers[name](rows, sql, params);
            if (custom !== undefined) return custom;
        }
        const conds = whereConds(sql, params);
        return rows.filter((r) => conds.every(([col, val]) => r[col] === val));
    }

    /**
     * @param {string} sql
     * @param {unknown[]} [params]
     * @returns {{ rows: Record<string, unknown>[], rowCount: number }}
     */
    function dispatch(sql, params = []) {
        const s = String(sql).trim();
        if (onQuery) {
            const override = onQuery(s, params);
            if (override !== undefined) return override;
        }
        // Transaction/DDL/session verbs are recorded but return nothing.
        if (/^(BEGIN|COMMIT|ROLLBACK|CREATE|ALTER|DROP|DO|SET|TRUNCATE)\b/i.test(s)) {
            return { rows: [], rowCount: 0 };
        }
        const rows = matchRows(s, params).map((r) => ({ ...r }));
        return { rows, rowCount: rows.length };
    }

    const client = {
        query: async (/** @type {string} */ sql, /** @type {unknown[]} */ params = []) => {
            calls.client.push({ sql, params });
            return dispatch(sql, params);
        },
        release() {},
    };

    const db = {
        run: async (/** @type {string} */ sql, /** @type {unknown[]} */ params = []) => {
            calls.run.push({ sql, params });
            return dispatch(sql, params);
        },
        getOne: async (/** @type {string} */ sql, /** @type {unknown[]} */ params = []) => {
            calls.getOne.push({ sql, params });
            return dispatch(sql, params).rows[0] || null;
        },
        getAll: async (/** @type {string} */ sql, /** @type {unknown[]} */ params = []) => {
            calls.getAll.push({ sql, params });
            return dispatch(sql, params).rows;
        },
        exec: async (/** @type {string} */ sql) => {
            calls.exec.push({ sql });
            return /** @type {void} */ (undefined);
        },
        getClient: async () => client,
        // Faithful mirror of db.withTransaction: BEGIN/COMMIT/ROLLBACK flow
        // through the same recorded client, so mutation assertions see them.
        withTransaction: async (/** @type {(c: typeof client) => Promise<unknown>} */ fn) => {
            await client.query('BEGIN');
            try {
                const result = await fn(client);
                if (result instanceof TransactionRollback) {
                    await client.query('ROLLBACK');
                    return result.value;
                }
                await client.query('COMMIT');
                return result;
            } catch (e) {
                try { await client.query('ROLLBACK'); } catch (err) { log.debug('rollback after a failed callback, the original error is rethrown', err); }
                throw e;
            }
        },
        makeStoreInit: (/** @type {string} */ _tag, /** @type {() => void | Promise<void>} */ schemaFn) => {
            /** @type {Promise<void> | null} */
            let promise = null;
            return function ensureInit() {
                if (!promise) promise = Promise.resolve().then(schemaFn);
                return promise;
            };
        },
        pool: { connect: async () => client },
        getPoolStats: () => ({ total: 0, idle: 0, waiting: 0 }),
        getRedis: () => /** @type {unknown} */ (null),
        redisHealthy: () => false,
    };

    return {
        db,
        client,
        calls,
        dispatch,
        reset() {
            calls.run = [];
            calls.getOne = [];
            calls.getAll = [];
            calls.client = [];
            calls.exec = [];
            calls.pool = [];
        },
        /**
         * Point the REAL db.js at this dispatcher through the shared pool, the
         * seam testUtils/routeHarness.js recordDb() and pglitePool.js use, instead
         * of replacing the `../db` module: the store keeps requiring the real
         * `../db`, and `run`/`getOne`/`getAll`/`exec`/`withTransaction` all end in
         * `pool.query` / `pool.connect`. Every statement then lands in
         * `calls.pool` (one channel: the pool cannot tell run from getOne) and,
         * inside a transaction or a DDL batch, in `calls.client`. Call it BEFORE
         * the store is required. Returns the restore function.
         */
        attachPool() {
            const real = require('../db');
            const saved = { query: real.pool.query, connect: real.pool.connect };
            const query = async (/** @type {unknown} */ sql, /** @type {unknown[]} */ params = []) => {
                const text = typeof sql === 'string' ? sql : String(/** @type {any} */ (sql)?.text || '');
                calls.pool.push({ sql: text, params });
                return dispatch(text, params);
            };
            real.pool.query = /** @type {any} */ (query);
            real.pool.connect = /** @type {any} */ (async () => client);
            return function restore() {
                real.pool.query = saved.query;
                real.pool.connect = saved.connect;
            };
        },
        /** Statements that read, in order, whatever helper sent them (pool mode). */
        reads() {
            return calls.pool.filter((c) => /^\s*(SELECT|WITH)\b/i.test(c.sql));
        },
        /** Every recorded mutating statement (across helpers + transaction client). */
        mutations() {
            return [...calls.run, ...calls.pool, ...calls.client]
                .filter((c) => /^(UPDATE|DELETE|INSERT)/i.test(String(c.sql).trim()));
        },
        /** Every recorded statement, in the order run per channel. */
        all() {
            return { ...calls };
        },
    };
}

module.exports = { createRecordingDb };
