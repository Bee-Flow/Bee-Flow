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
 *   const { installResolveStub } = require('../testUtils/stubRequire');
 *   const mock = createRecordingDb({ tables: { studio_apps: appRows } });
 *   installResolveStub({ '../db': mock.db });
 *   const store = require('./studioAppStore');
 *   ...
 *   mock.reset();
 *   assert.ok(mock.mutations().every(c => /user_id\s*=\s*\$/i.test(c.sql)));
 */

/**
 * @param {object} opts
 * @param {Record<string, object[]>} [opts.tables] table name → seed rows
 * @param {Record<string, (rows: object[], sql: string, params: any[]) => object[]>} [opts.matchers]
 *   per-table override for queries the default equality matcher can't model
 * @param {(sql: string, params: any[]) => ({rows: object[], rowCount: number}) | undefined} [opts.onQuery]
 *   optional escape hatch: return a result to fully override dispatch for a query
 */
function createRecordingDb({ tables = {}, matchers = {}, onQuery } = {}) {
    const calls = { run: [], getOne: [], getAll: [], client: [], exec: [] };

    // Route a statement to the first registered table it names.
    function tableFor(sql) {
        for (const name of Object.keys(tables)) {
            if (new RegExp(`\\b${name}\\b`, 'i').test(sql)) return name;
        }
        return null;
    }

    // Extract `col = $n` equalities from the WHERE clause only (SET clauses in
    // an UPDATE must not pollute the condition list).
    function whereConds(sql, params) {
        const m = sql.match(/\bWHERE\b([\s\S]*)/i);
        if (!m) return [];
        return [...m[1].matchAll(/([a-z_]+)\s*=\s*\$(\d+)/gi)]
            .map((x) => [x[1], params[Number(x[2]) - 1]]);
    }

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
        query: async (sql, params = []) => {
            calls.client.push({ sql, params });
            return dispatch(sql, params);
        },
        release() {},
    };

    const db = {
        run: async (sql, params = []) => {
            calls.run.push({ sql, params });
            return dispatch(sql, params);
        },
        getOne: async (sql, params = []) => {
            calls.getOne.push({ sql, params });
            return dispatch(sql, params).rows[0] || null;
        },
        getAll: async (sql, params = []) => {
            calls.getAll.push({ sql, params });
            return dispatch(sql, params).rows;
        },
        exec: async (sql) => {
            calls.exec.push({ sql });
            return undefined;
        },
        getClient: async () => client,
        // Faithful mirror of db.withTransaction: BEGIN/COMMIT/ROLLBACK flow
        // through the same recorded client, so mutation assertions see them.
        withTransaction: async (fn) => {
            await client.query('BEGIN');
            try {
                const result = await fn(client);
                await client.query('COMMIT');
                return result;
            } catch (e) {
                try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
                throw e;
            }
        },
        makeStoreInit: (_tag, schemaFn) => {
            let promise = null;
            return function ensureInit() {
                if (!promise) promise = Promise.resolve().then(schemaFn);
                return promise;
            };
        },
        pool: { connect: async () => client },
        getPoolStats: () => ({ total: 0, idle: 0, waiting: 0 }),
        getRedis: () => null,
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
        },
        /** Every recorded mutating statement (across helpers + transaction client). */
        mutations() {
            return [...calls.run, ...calls.client]
                .filter((c) => /^(UPDATE|DELETE|INSERT)/i.test(String(c.sql).trim()));
        },
        /** Every recorded statement, in the order run per channel. */
        all() {
            return { ...calls };
        },
    };
}

module.exports = { createRecordingDb };
