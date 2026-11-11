'use strict';

/**
 * The App Studio write paths against a REAL in-memory SQLite: the Postgres-backed stores
 * (studioAppDbStore, studioAppDataStore) are swapped, for the length of the test file, for
 * stand-ins that run the compiled SQL on the database. Everything above them (the query
 * compiler, the RLS gateway, the dispatcher) is the real code.
 *
 *   const db = useSqliteAppStores(test, { onSql: (sql) => executed.push(sql) });
 *
 * Call it before requiring the modules under test, as the files did by hand. `dataStore`
 * replaces the data-store stand-ins (to record version and row count bumps).
 */

const Database = require('better-sqlite3');

const norm = (params) => params.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v));

function useSqliteAppStores(test, { onSql = () => {}, dataStore: dataStandIns = {} } = {}) {
    const db = new Database(':memory:');
    const dbStore = require('../stores/studioAppDbStore');
    const dataStore = require('../stores/studioAppDataStore');
    const swaps = [
        [dbStore, {
            exec: async (_o, _a, sql, params) => { onSql(sql); return { changes: db.prepare(sql).run(...norm(params)).changes }; },
            query: async (_o, _a, sql, params) => ({ rows: db.prepare(sql).all(...norm(params)) }),
            batch: async (_o, _a, statements) => db.transaction(() => statements.map((s, i) => {
                onSql(s.sql);
                if (s.sql.trim().toLowerCase().startsWith('select')) return { rows: db.prepare(s.sql).all(...norm(s.params)) };
                const changes = db.prepare(s.sql).run(...norm(s.params)).changes;
                if (s.expectChanges && !changes) throw Object.assign(new Error('no rows'), { code: 'batch_no_rows', statementIndex: i });
                return { changes };
            }))(),
            sizeBytes: async () => 0,
        }],
        [dataStore, {
            bumpDataVersion: async () => 1,
            bumpRowCount: async () => ({}),
            getRowCounts: async () => ({}),
            ...dataStandIns,
        }],
    ];
    const originals = swaps.map(([target, methods]) => [target, Object.fromEntries(Object.keys(methods).map((k) => [k, target[k]]))]);
    swaps.forEach(([target, methods]) => Object.assign(target, methods));
    test.after(() => originals.forEach(([target, saved]) => Object.assign(target, saved)));
    return db;
}

module.exports = { useSqliteAppStores };
