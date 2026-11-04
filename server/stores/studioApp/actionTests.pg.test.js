'use strict';

/**
 * The saved action tests store against a REAL Postgres (PGlite, in-process), with the DDL the
 * app ships, lifted out of ./schema.js rather than retyped: a column renamed there without
 * touching the store fails here.
 *
 * Run: cd server && node --test stores/studioApp/actionTests.pg.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { pgliteDb } = require('../../testUtils/pgliteDb');
const { makeActionTestStore } = require('./actionTests.mts');

const { pg, db } = pgliteDb();
let readyCalls = 0;
const store = makeActionTestStore(db, { ready: async () => { readyCalls += 1; } });

/** The shipped CREATE statements of studio_app_action_tests, read out of schema.js. */
function shippedDdl() {
    const text = fs.readFileSync(path.join(__dirname, 'schema.js'), 'utf8');
    const m = /`(\s*CREATE TABLE IF NOT EXISTS studio_app_action_tests[\s\S]*?)`/.exec(text);
    assert.ok(m, 'schema.js still creates studio_app_action_tests');
    return m[1];
}

before(async () => {
    await pg.exec('CREATE TABLE studio_apps (id TEXT PRIMARY KEY, user_id TEXT NOT NULL)');
    await pg.exec(shippedDdl());
    await pg.query("INSERT INTO studio_apps (id, user_id) VALUES ('app_a', 'owner'), ('app_b', 'owner')");
});
after(async () => { await pg.close(); });

const spec = (n) => ({ scope: { vars: { n } }, mock: {}, expect: [{ path: 'vars.n', op: 'is', value: n }] });

test('upsert inserts, then replaces the spec of the same action + name', async () => {
    const first = await store.upsertActionTest('app_a', { actionId: 'act_1', name: 'one', spec: spec(1), userId: 'editor' });
    assert.equal(first.created, true);
    assert.match(first.test.id, /^sat_[0-9a-f]{32}$/);
    assert.deepEqual(first.test.spec, spec(1));
    assert.equal(first.test.createdBy, 'editor');
    const again = await store.upsertActionTest('app_a', { actionId: 'act_1', name: 'one', spec: spec(2), userId: 'owner' });
    assert.equal(again.created, false);
    assert.equal(again.test.id, first.test.id, 'the same row');
    assert.deepEqual(again.test.spec, spec(2));
    assert.equal(again.test.createdBy, 'editor');
    assert.equal(again.test.updatedBy, 'owner');
    assert.equal(await store.countActionTests('app_a'), 1);
    assert.ok(readyCalls > 0, 'every query awaits the store init');
});

test('list filters by action and name; order is action then name', async () => {
    await store.upsertActionTest('app_a', { actionId: 'act_2', name: 'b', spec: spec(3), userId: 'owner' });
    await store.upsertActionTest('app_a', { actionId: 'act_2', name: 'a', spec: spec(4), userId: 'owner' });
    assert.deepEqual((await store.listActionTests('app_a')).map((t) => `${t.actionId}/${t.name}`), ['act_1/one', 'act_2/a', 'act_2/b']);
    assert.deepEqual((await store.listActionTests('app_a', { actionIds: ['act_2'] })).map((t) => t.name), ['a', 'b']);
    assert.deepEqual((await store.listActionTests('app_a', { names: ['one', 'b'] })).map((t) => t.name), ['one', 'b']);
    assert.deepEqual((await store.listActionTests('app_a', { actionIds: ['act_1'], names: ['b'] })), []);
});

test('another app\'s tests are unreachable: list, delete and statuses are keyed by the app id', async () => {
    const other = await store.upsertActionTest('app_b', { actionId: 'act_1', name: 'one', spec: spec(9), userId: 'owner' });
    assert.equal((await store.listActionTests('app_a')).some((t) => t.id === other.test.id), false);
    assert.equal(await store.recordTestStatuses('app_a', [{ id: other.test.id, status: 'pass' }]), 0);
    assert.equal((await store.listActionTests('app_b'))[0].lastStatus, null);
    assert.equal(await store.deleteActionTest('app_a', 'act_9', 'one'), false);
    assert.equal(await store.countActionTests('app_b'), 1);
});

test('statuses are written back with the run time', async () => {
    const [a, b] = await store.listActionTests('app_a', { actionIds: ['act_2'] });
    assert.equal(await store.recordTestStatuses('app_a', [{ id: a.id, status: 'pass' }, { id: b.id, status: 'fail' }]), 2);
    const after = await store.listActionTests('app_a', { actionIds: ['act_2'] });
    assert.deepEqual(after.map((t) => t.lastStatus), ['pass', 'fail']);
    assert.ok(after.every((t) => typeof t.lastRunAt === 'string'));
    assert.equal(await store.recordTestStatuses('app_a', []), 0);
});

test('delete by action + name', async () => {
    assert.equal(await store.deleteActionTest('app_a', 'act_2', 'b'), true);
    assert.equal(await store.deleteActionTest('app_a', 'act_2', 'b'), false);
    assert.deepEqual((await store.listActionTests('app_a', { actionIds: ['act_2'] })).map((t) => t.name), ['a']);
});

test('deleting the app takes its tests with it (ON DELETE CASCADE)', async () => {
    await pg.query("DELETE FROM studio_apps WHERE id = 'app_b'");
    assert.equal(await store.countActionTests('app_b'), 0);
    assert.ok(await store.countActionTests('app_a') > 0);
});
