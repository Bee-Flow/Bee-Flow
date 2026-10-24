// @typecheck
'use strict';

/**
 * automation_caller_notices against a real Postgres (pglite): the one-time
 * "this runs with your own connections" notice is remembered per person and
 * automation, idempotently.
 *
 * Run: node --test stores/automationStore/callerNotices.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { PGlite } = require('@electric-sql/pglite');
const { installResolveStub } = require('../../testUtils/stubRequire');

const pg = new PGlite();
const restore = installResolveStub({
    './core': {
        initDB: async () => {},
        run: async (sql, params) => pg.query(sql, params),
        getOne: async (sql, params) => (await pg.query(sql, params)).rows[0] || null,
    },
});
const { up } = require('../../migrations/automation-caller-connections-2026-10');
const { getCallerNoticeAck, markCallerNoticeSeen } = require('./callerNotices');

before(async () => {
    await pg.exec(`
        CREATE TABLE automations (id TEXT PRIMARY KEY);
        CREATE TABLE automation_runs (id TEXT PRIMARY KEY);
        CREATE TABLE automation_run_steps (run_id TEXT NOT NULL, step_id TEXT NOT NULL);
        INSERT INTO automations VALUES ('a1'), ('a2');
    `);
    await up({ exec: (sql) => pg.exec(sql) });
});
after(async () => { restore(); await pg.close(); });

test('no acknowledgement until given; it is per person and automation, remembers WHAT was acknowledged, and grows', async () => {
    assert.strictEqual(await getCallerNoticeAck('u1', 'a1'), null);
    await markCallerNoticeSeen('u1', 'a1', ['dest:tables', 'app:google']);
    await markCallerNoticeSeen('u1', 'a1', ['dest:tables', 'app:google']);
    assert.deepStrictEqual(await getCallerNoticeAck('u1', 'a1'), ['app:google', 'dest:tables']);
    assert.strictEqual(await getCallerNoticeAck('u2', 'a1'), null);
    assert.strictEqual(await getCallerNoticeAck('u1', 'a2'), null);
    await markCallerNoticeSeen('u1', 'a1', ['app:google', 'app:microsoft', 'dest:tables']);
    assert.deepStrictEqual(await getCallerNoticeAck('u1', 'a1'), ['app:google', 'app:microsoft', 'dest:tables']);
    await markCallerNoticeSeen('u3', 'a2');
    assert.deepStrictEqual(await getCallerNoticeAck('u3', 'a2'), [], 'an empty set is still an acknowledgement');
});

test('missing ids are never acknowledged and never written', async () => {
    assert.strictEqual(await getCallerNoticeAck(null, 'a1'), null);
    await markCallerNoticeSeen('u1', null, ['app:google']);
    const { rows } = await pg.query('SELECT * FROM automation_caller_notices');
    assert.strictEqual(rows.length, 2);
});
