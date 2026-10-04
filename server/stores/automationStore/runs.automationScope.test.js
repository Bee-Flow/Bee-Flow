/**
 * The per-automation run scope (handoff 5 sharing): buildRunFilterWhere's
 * `{ automation: { automationId } }` scope and the `startedByUserId` filter,
 * run for real against PGlite so the SQL is proven, not just its shape.
 *
 * Proven:
 *   - the automation scope matches that automation's runs whoever owned it then;
 *   - two scopes at once still match nothing;
 *   - startedByUserId keeps the runs that person started OR submitted the
 *     form for, and nothing else;
 *   - it only ever narrows the user scope too;
 *   - the user scope leaves out the runs of an automation in the trash (r6).
 *
 * Run: cd server && node --test stores/automationStore/runs.automationScope.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { PGlite } = require('@electric-sql/pglite');
const { buildRunFilterWhere } = require('./runs');

const pg = new PGlite();

before(async () => {
    await pg.exec(`
        CREATE TABLE automation_runs (
            id TEXT PRIMARY KEY,
            automation_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            root_run_id TEXT,
            started_by_user_id TEXT,
            submitted_by_user_id TEXT,
            started_at TIMESTAMPTZ DEFAULT NOW()
        );
        INSERT INTO automation_runs (id, automation_id, user_id, started_by_user_id, submitted_by_user_id) VALUES
            ('r1', 'a1', 'old-owner', 'ron', NULL),
            ('r2', 'a1', 'new-owner', 'owner', NULL),
            ('r3', 'a1', 'new-owner', NULL, 'ron'),
            ('r4', 'a1', 'new-owner', NULL, NULL),
            ('r5', 'a2', 'new-owner', 'ron', NULL),
            ('r6', 'a3', 'new-owner', 'ron', NULL);
        -- The automations the lists join for title/kind; a3 sits in the trash.
        CREATE TABLE automations (id TEXT PRIMARY KEY, deleted_at TIMESTAMPTZ);
        INSERT INTO automations (id, deleted_at) VALUES ('a1', NULL), ('a2', NULL), ('a3', NOW());
    `);
});

after(async () => { await pg.close(); });

async function ids(scope, filters = {}) {
    const w = buildRunFilterWhere(scope, filters, 1);
    const r = await pg.query(`SELECT r.id FROM automation_runs r JOIN automations a ON a.id = r.automation_id WHERE ${w.clause} ORDER BY r.id`, w.params);
    return r.rows.map(x => x.id);
}

test('the automation scope: every run of that automation, whoever owned it then', async () => {
    assert.deepStrictEqual(await ids({ automation: { automationId: 'a1' } }), ['r1', 'r2', 'r3', 'r4']);
    const w = buildRunFilterWhere({ automation: { automationId: 'a1' } }, {}, 1);
    assert.strictEqual(w.joinUsers, false);
});

test('two scopes at once match nothing', async () => {
    assert.deepStrictEqual(await ids({ automation: { automationId: 'a1' }, user: { userId: 'new-owner' } }), []);
    assert.deepStrictEqual(await ids({}), []);
});

test('startedByUserId: the runs they started or submitted the form for', async () => {
    assert.deepStrictEqual(await ids({ automation: { automationId: 'a1' } }, { startedByUserId: 'ron' }), ['r1', 'r3']);
    assert.deepStrictEqual(await ids({ automation: { automationId: 'a1' } }, { startedByUserId: 'nobody' }), []);
    assert.deepStrictEqual(await ids({ user: { userId: 'new-owner' } }, { startedByUserId: 'ron' }), ['r3', 'r5']);
});
