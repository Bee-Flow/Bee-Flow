'use strict';

/**
 * Both App Studio engines (better-sqlite3 in memory with its foreign keys on, as stores/lib/sqliteOpen
 * opens an app database, and Postgres through PGlite) with the tables of a data model laid down by
 * the REAL migration planner, for the tests of lookup, rollup, many-relation, onDelete and index
 * behaviour (core/dataEngine/dataModel/linkedFields.js).
 *
 *   const engines = await bootLinkedEngines(MODEL, closers);   // { sqlite, pg }
 *   await engines.pg.run(sql, params); const rows = await engines.pg.all(sql, params);
 *   const restore = useEngineAsAppStore(engines.pg);             // studioAppDbStore + the dialect flag
 */

const { migrationPlan } = require('../core/dataEngine/dataModel/migrationPlan');
const { toDollarParams } = require('../stores/lib/pgAppEngine');
const engineFlag = require('../utils/engineFlag');
const { applyPlanTolerantly } = require('../core/dataEngine/dataModel/tolerantDdl');

const norm = (params) => (params || []).map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v));

function sqliteEngine(closers) {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    closers.push(() => db.close());
    const run = (sql, params) => db.prepare(sql).run(...norm(params)).changes;
    const all = (sql, params) => db.prepare(sql).all(...norm(params));
    return {
        dialect: 'sqlite',
        // As the app engine applies a plan: an ADD COLUMN that is already there is skipped.
        ddl: async (sql) => applyPlanTolerantly(db, [sql], { log: { warn: () => {}, info: () => {}, log: () => {} } }),
        run: async (sql, params) => run(sql, params),
        all: async (sql, params) => all(sql, params),
        batch: async (statements) => db.transaction(() => statements.map((s, i) => {
            if (db.prepare(s.sql).reader) return { rows: all(s.sql, s.params), changes: 0 }; // a read in a batch answers its rows, as the app store does
            const changes = run(s.sql, s.params);
            if (s.expectChanges && !changes) throw Object.assign(new Error('no rows'), { code: 'batch_no_rows', statementIndex: i });
            return { changes };
        }))(),
    };
}

async function pgEngine(closers) {
    const { newPglite } = require('./pgliteTemplate');
    const pg = newPglite();
    closers.push(() => pg.close());
    await pg.exec("SET TIME ZONE 'UTC'");
    const q = (runner, sql, params) => runner.query(toDollarParams(sql, (params || []).length), params || []);
    return {
        dialect: 'pg',
        ddl: async (sql) => pg.exec(sql),
        run: async (sql, params) => (await q(pg, sql, params)).affectedRows || 0,
        all: async (sql, params) => (await q(pg, sql, params)).rows,
        batch: async (statements) => pg.transaction(async (tx) => {
            const out = [];
            for (const [i, s] of statements.entries()) {
                const res = await q(tx, s.sql, s.params);
                const changes = res.affectedRows || 0;
                if (s.expectChanges && !changes) throw Object.assign(new Error('no rows'), { code: 'batch_no_rows', statementIndex: i });
                out.push({ changes, rows: res.rows });
            }
            return out;
        }),
    };
}

/** Both engines with every table of `model` created through migrationPlan({}, model). */
async function bootLinkedEngines(model, closers) {
    const engines = { sqlite: sqliteEngine(closers), pg: await pgEngine(closers) };
    for (const engine of Object.values(engines)) {
        for (const sql of migrationPlan({ tables: [] }, model, { dialect: engine.dialect })) await engine.ddl(sql);
    }
    return engines;
}

/**
 * Serve studioAppDbStore (and the data-store bookkeeping) from `engine` and compile in its
 * dialect, until the returned function restores both.
 */
function useEngineAsAppStore(engine) {
    const dbStore = require('../stores/studioAppDbStore');
    const dataStore = require('../stores/studioAppDataStore');
    const swaps = [
        [dbStore, {
            exec: async (_o, _a, sql, params) => ({ changes: await engine.run(sql, params) }),
            query: async (_o, _a, sql, params) => ({ rows: await engine.all(sql, params) }),
            batch: async (_o, _a, statements) => engine.batch(statements),
            sizeBytes: async () => 0,
        }],
        [dataStore, { bumpDataVersion: async () => 1, bumpRowCount: async () => ({}), getRowCounts: async () => ({}) }],
    ];
    const saved = swaps.map(([target, methods]) => [target, Object.fromEntries(Object.keys(methods).map((k) => [k, target[k]]))]);
    swaps.forEach(([target, methods]) => Object.assign(target, methods));
    engineFlag._setForTests(engine.dialect);
    return () => {
        saved.forEach(([target, methods]) => Object.assign(target, methods));
        engineFlag._setForTests(null);
    };
}

module.exports = { bootLinkedEngines, useEngineAsAppStore };
