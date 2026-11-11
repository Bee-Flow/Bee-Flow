'use strict';

/**
 * The version-row writer against a REAL Postgres (PGlite, in-process):
 * `skipIfSameAsNewest` compares with jsonb equality, which the in-memory
 * stand-in of studioAppStore.test.js cannot judge (key order). The store's
 * collaborators come in through its own seam (./deps.js install), and the
 * writer runs on the caller's client, as the publish path runs it.
 *
 * Run: cd server && node --test stores/studioApp/versions.pg.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { pgliteDb, dbFacade } = require('../../testUtils/pgliteDb');

const { pg, db } = pgliteDb();
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
require('./deps').install({ db: { ...dbFacade(db), exec: async (sql) => { await pg.exec(sql); } }, log: quiet });
const { createVersionSnapshot } = require('./versions');

const client = { query: db.query };
const write = (appId, definition, summary, opts = {}) => createVersionSnapshot(appId, 'owner', definition, summary, { client, ...opts });

before(async () => {
    await pg.exec(`CREATE TABLE studio_app_versions (
        id TEXT PRIMARY KEY, app_id TEXT NOT NULL, user_id TEXT NOT NULL,
        definition JSONB NOT NULL, summary TEXT, created_at TIMESTAMPTZ DEFAULT clock_timestamp()
    )`);
});
after(async () => { await pg.close(); });

const rows = async (appId) => (await pg.query(
    'SELECT summary, definition FROM studio_app_versions WHERE app_id = $1 ORDER BY created_at, id', [appId],
)).rows;

test('skipIfSameAsNewest writes nothing when the newest row holds the same definition', async () => {
    const first = await write('app_1', { a: 1, b: { c: 2 } }, 'AI checkpoint — before plan');
    assert.equal(typeof first, 'string');
    // Same content, other key order: jsonb equality calls it the same.
    assert.equal(await write('app_1', { b: { c: 2 }, a: 1 }, 'AI change', { skipIfSameAsNewest: true }), null);
    assert.deepEqual((await rows('app_1')).map((r) => r.summary), ['AI checkpoint — before plan']);
});

test('skipIfSameAsNewest still writes a changed definition, and the first row of an app', async () => {
    assert.equal(typeof await write('app_1', { a: 2 }, 'AI change', { skipIfSameAsNewest: true }), 'string');
    assert.equal(typeof await write('app_2', '{"x":1}', 'AI build finished', { skipIfSameAsNewest: true }), 'string');
    assert.deepEqual((await rows('app_1')).map((r) => r.summary), ['AI checkpoint — before plan', 'AI change']);
    assert.deepEqual((await rows('app_2')).map((r) => r.definition), [{ x: 1 }]);
});

test('without the option an identical row is still written (publish and phase checkpoints unchanged)', async () => {
    await write('app_3', { a: 1 }, 'Published');
    await write('app_3', { a: 1 }, 'Published');
    assert.equal((await rows('app_3')).length, 2);
});
