'use strict';

/**
 * The version-row writer against a REAL Postgres (PGlite, in-process), with the
 * store's own DDL: `skipIfSameAsNewest` compares with jsonb equality, which the
 * in-memory stand-in of studioAppStore.test.js cannot judge (key order).
 *
 * Run: cd server && node --test stores/studioApp/versions.pg.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const { pgliteDb, dbFacade } = require('../../testUtils/pgliteDb');

const { pg, db } = pgliteDb();
const facade = { ...dbFacade(db), exec: async (sql) => { await pg.exec(sql); } };
// Every require of server/db.js (the store's and the DDL runner's) gets the PGlite facade.
const realDb = require.resolve('../../db');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    const resolved = originalResolve.call(this, request, parent, ...rest);
    return resolved === realDb ? 'versions-pg-db' : resolved;
};
require.cache['versions-pg-db'] = { id: 'versions-pg-db', exports: facade };
const store = require('../studioAppStore');

after(async () => { await pg.close(); });

const rows = async (appId) => (await pg.query(
    'SELECT summary, definition FROM studio_app_versions WHERE app_id = $1 ORDER BY created_at, id', [appId],
)).rows;

test('skipIfSameAsNewest writes nothing when the newest row holds the same definition', async () => {
    const first = await store.createVersionSnapshot('app_1', 'owner', { a: 1, b: { c: 2 } }, 'AI checkpoint — before plan');
    assert.equal(typeof first, 'string');
    // Same content, other key order: jsonb equality calls it the same.
    const same = await store.createVersionSnapshot('app_1', 'owner', { b: { c: 2 }, a: 1 }, 'AI change', { skipIfSameAsNewest: true });
    assert.equal(same, null);
    assert.deepEqual((await rows('app_1')).map((r) => r.summary), ['AI checkpoint — before plan']);
});

test('skipIfSameAsNewest still writes a changed definition, and the first row of an app', async () => {
    const changed = await store.createVersionSnapshot('app_1', 'owner', { a: 2 }, 'AI change', { skipIfSameAsNewest: true });
    assert.equal(typeof changed, 'string');
    const fresh = await store.createVersionSnapshot('app_2', 'owner', '{"x":1}', 'AI build finished', { skipIfSameAsNewest: true });
    assert.equal(typeof fresh, 'string');
    assert.deepEqual((await rows('app_1')).map((r) => r.summary), ['AI checkpoint — before plan', 'AI change']);
    assert.deepEqual((await rows('app_2')).map((r) => r.definition), [{ x: 1 }]);
});

test('without the option an identical row is still written (publish and phase checkpoints unchanged)', async () => {
    await store.createVersionSnapshot('app_3', 'owner', { a: 1 }, 'Published');
    await store.createVersionSnapshot('app_3', 'owner', { a: 1 }, 'Published');
    assert.equal((await rows('app_3')).length, 2);
});
