// @typecheck strict
/**
 * A projectStore on a fresh pglite with the project schema applied, for store tests that need a
 * real Postgres. Close `pg` in an `after` hook.
 */
'use strict';

const { newPglite } = require('./pgliteTemplate');

const { makeProjectStore, applyProjectSchema } = require('../stores/projectStore');
const { pgliteDb } = require('./pgliteDb');
const { withTransactionVia } = require('./txFake');

async function openPgliteProjectStore() {
    const pg = newPglite();
    const { db } = pgliteDb(pg);
    /**
     * @param {string} _tag
     * @param {Array<string | { sql: string }>} statements
     */
    const runDdl = async (_tag, statements) => {
        for (const stmt of statements) await pg.exec(typeof stmt === 'string' ? stmt : stmt.sql);
    };
    await applyProjectSchema({ exec: (sql) => pg.exec(sql), runDdl });
    const getClient = async () => ({ query: db.query, release() {} });
    const store = makeProjectStore({
        run: db.query,
        getOne: async (sql, params) => (await db.query(sql, params)).rows[0] || null,
        getAll: async (sql, params) => (await db.query(sql, params)).rows,
        getClient,
        withTransaction: withTransactionVia(getClient),
    });
    return { pg, store };
}

module.exports = { openPgliteProjectStore };
