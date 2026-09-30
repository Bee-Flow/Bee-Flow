/**
 * A real Postgres behind the REAL db.js, for a test of a store that requires
 * `../db` directly: @electric-sql/pglite, in-process, answering the shared
 * pool's `query` and `connect`. The store runs its own schema init and its own
 * SQL, `withTransaction` and `runDdl` included, with no module mocking
 * (`count-ratchet.mjs module-mock`): the pool object is the seam, exactly the
 * one core/http/routeHarness.js `recordDb()` uses to RECORD queries; this one
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

/** PGlite's answer in node-postgres's shape; a multi-statement exec answers with its last result. */
function asPgResult(res) {
    const r = Array.isArray(res) ? (res[res.length - 1] || {}) : (res || {});
    const rows = r.rows || [];
    const fields = r.fields || [];
    const rowCount = fields.length > 0
        ? rows.length
        : (typeof r.affectedRows === 'number' ? r.affectedRows : 0);
    return { rows, rowCount };
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

    async function query(sql, params) {
        const text = typeof sql === 'string' ? sql : String(sql?.text || '');
        const values = Array.isArray(params) ? params : sql?.values;
        if (Array.isArray(values) && values.length > 0) return asPgResult(await pg.query(text, values));
        // Several statements in one string (schema init) need the simple
        // protocol, which PGlite serves through exec().
        if (/;\s*\S/.test(text.trim())) return asPgResult(await pg.exec(text));
        return asPgResult(await pg.query(text));
    }

    db.pool.query = query;
    db.pool.connect = async () => ({ query, release() {} });

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

module.exports = { usePglitePool };
