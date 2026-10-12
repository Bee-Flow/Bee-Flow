/**
 * A projectStore on a fresh pglite with the project schema applied, for store tests that need a
 * real Postgres. Close `pg` in an `after` hook.
 */
'use strict';

const { PGlite } = require('@electric-sql/pglite');

const { makeProjectStore, applyProjectSchema } = require('../stores/projectStore');
const { pgliteDb } = require('./pgliteDb');

async function openPgliteProjectStore() {
    const pg = new PGlite();
    const { db } = pgliteDb(pg);
    const runDdl = async (_tag, statements) => {
        for (const stmt of statements) await pg.exec(typeof stmt === 'string' ? stmt : stmt.sql);
    };
    await applyProjectSchema({ exec: (sql) => pg.exec(sql), runDdl });
    const store = makeProjectStore({
        run: db.query,
        getOne: async (sql, params) => (await db.query(sql, params)).rows[0] || null,
        getAll: async (sql, params) => (await db.query(sql, params)).rows,
        getClient: async () => ({ query: db.query, release() {} }),
    });
    return { pg, store };
}

module.exports = { openPgliteProjectStore };
