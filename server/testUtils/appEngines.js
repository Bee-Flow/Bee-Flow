// @typecheck
/**
 * The two engines an App Studio table lives in, for a test that runs compiled
 * SQL for real: SQLite (better-sqlite3, the per-app engine) and Postgres
 * (PGlite, the per-app schema). Both take the compiler's `?` placeholders and
 * answer `{ rows }`, the way the app stores do.
 *
 *   const engine = sqliteEngine();   // or pgEngine()
 *   await engine.exec(ddl);
 *   const { rows } = await engine.query(sql, params);
 *   await engine.close();
 */

const Database = require('better-sqlite3');
const { toDollarParams, _normalizeRows } = require('../stores/lib/pgAppEngine');
const { newPglite } = require('./pgliteTemplate');

/** @typedef {{ dialect: 'sqlite' | 'pg', exec: (sql: string) => Promise<unknown>, query: (sql: string, params: unknown[]) => Promise<{ rows: any[] }>, close: () => Promise<void> }} AppEngine */

/** @returns {AppEngine} */
function sqliteEngine() {
    const db = new Database(':memory:');
    return {
        dialect: 'sqlite',
        exec: async (sql) => db.exec(sql),
        query: async (sql, params) => {
            const stmt = db.prepare(sql);
            if (!stmt.reader) { stmt.run(...params); return { rows: [] }; }
            return { rows: stmt.all(...params) };
        },
        close: async () => { db.close(); },
    };
}

/** @returns {AppEngine} */
function pgEngine() {
    const db = newPglite();
    return {
        dialect: 'pg',
        exec: async (sql) => db.exec(sql),
        query: async (sql, params) => ({ rows: _normalizeRows(await db.query(toDollarParams(sql, params.length), params)) }),
        close: async () => { await db.close(); },
    };
}

/** Both, as [name, make] pairs, for a test written once per engine. */
const APP_ENGINES = /** @type {const} */ ([['sqlite', sqliteEngine], ['pg', pgEngine]]);

module.exports = { sqliteEngine, pgEngine, APP_ENGINES };
