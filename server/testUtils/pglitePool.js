// @typecheck
/**
 * A real Postgres behind the REAL db.js, for a test of a store that requires
 * `../db` directly: @electric-sql/pglite, in-process, answering the shared
 * pool's `query` and `connect`. The store runs its own schema init and its own
 * SQL, `withTransaction` and `runDdl` included, with no module mocking
 * (`count-ratchet.mjs module-mock`): the pool object is the seam, exactly the
 * one testUtils/routeHarness.js `recordDb()` uses to RECORD queries; this one
 * ANSWERS them.
 *
 *   const { pg, close } = usePglitePool();
 *   const store = require('../stores/documentStore');
 *   before(async () => { await pg.exec(FIXTURE_DDL); await store.initDB(); });
 *   after(close);
 *
 * PGlite is ONE session. A transaction a store opens through `connect()` is
 * that session's transaction, so run store inits one after another (await each
 * `initDB()`), never two stores' DDL at once. For a factory store that takes a
 * `db`, testUtils/pgliteDb.js is the lighter fit.
 */

'use strict';

const { PGlite } = require('@electric-sql/pglite');

/**
 * PGlite's answer in node-postgres's shape; a multi-statement exec answers
 * with its last result. `fields` and `command` are there because
 * stores/lib/pgAppEngine reads them (column names, SELECT vs. a write), the
 * way node-postgres fills them: a statement with result columns is a SELECT,
 * anything else is named by its first keyword.
 */
function asPgResult(res, sql = '') {
    const r = Array.isArray(res) ? (res[res.length - 1] || {}) : (res || {});
    const rows = r.rows || [];
    const fields = r.fields || [];
    const command = fields.length > 0 ? 'SELECT' : String(sql).trim().split(/\s+/)[0].toUpperCase();
    const rowCount = fields.length > 0
        ? rows.length
        : (typeof r.affectedRows === 'number' ? r.affectedRows : 0);
    return { rows, fields, rowCount, command };
}

/**
 * node-postgres's `query(sql, params)` over one PGlite, without touching
 * db.js: for a store that takes its `db` injected (`{ query }`). A string of
 * several statements runs through exec(), as a schema init sends it.
 *
 * @param {PGlite} pg
 */
function pgliteQuery(pg) {
    return async function query(sql, params) {
        const text = typeof sql === 'string' ? sql : String(sql?.text || '');
        const values = Array.isArray(params) ? params : sql?.values;
        if (Array.isArray(values) && values.length > 0) return asPgResult(await pg.query(text, values), text);
        // Several statements in one string (schema init) need the simple
        // protocol, which PGlite serves through exec().
        if (/;\s*\S/.test(text.trim())) return asPgResult(await pg.exec(text), text);
        return asPgResult(await pg.query(text), text);
    };
}

/**
 * Point db.js's pool at a fresh PGlite until `restore()`/`close()`.
 *
 * @param {PGlite} [pg]
 * @returns {{ pg: PGlite, query: Function, restore: () => void, close: () => Promise<void> }}
 */
function usePglitePool(pg = new PGlite()) {
    const db = require('../db');
    const saved = { query: db.pool.query, connect: db.pool.connect };

    const query = pgliteQuery(pg);

    // A PGlite-backed stand-in, not a full pg client.
    db.pool.query = /** @type {any} */ (query);
    db.pool.connect = /** @type {any} */ (async () => ({ query, release() {} }));

    let restored = false;
    function restore() {
        if (restored) return;
        restored = true;
        db.pool.query = saved.query;
        db.pool.connect = saved.connect;
    }
    async function close() {
        restore();
        await pg.close();
    }
    return { pg, query, restore, close };
}

module.exports = { usePglitePool, pgliteQuery };
