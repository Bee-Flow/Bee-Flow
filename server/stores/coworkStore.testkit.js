/**
 * The Cowork store on a real Postgres in-process, for its `.pg.test.js` files: PGlite behind db.js
 * (testUtils/pglitePool.js), the store's own schema and SQL, opened before the tests and closed after them.
 *
 *   const { pg, store } = coworkStoreOnPglite();
 */

'use strict';

const { before, after } = require('node:test');

function coworkStoreOnPglite() {
    process.env.NODE_ENV = 'test';
    // The pool is swapped before the store loads: the store reads `../db` when it is required.
    const { pg, close } = require('../testUtils/pglitePool').usePglitePool();
    const store = require('./coworkStore');
    before(async () => { await store.initDB(); });
    after(close);
    return { pg, store };
}

module.exports = { coworkStoreOnPglite };
