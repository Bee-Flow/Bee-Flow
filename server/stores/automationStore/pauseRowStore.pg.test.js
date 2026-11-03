// @typecheck
'use strict';
/**
 * Ending a pause outside the runner, against a real Postgres (PGlite): the
 * paused step row moves only from its paused status, a journey's visitor
 * session is found from ANY of its legs (with is_test), and ending it expires
 * it and drops queued work without touching another journey's session.
 * Run: cd server && node --test stores/automationStore/pauseRowStore.pg.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { pgliteDb } = require('../../testUtils/pgliteDb');
const { makePauseRowStore } = require('./pauseRowStore.mts');

const { pg, db } = pgliteDb();
const store = makePauseRowStore(db);

before(async () => {
    // The columns these queries read; is_test arrives with the run-profile migration.
    await pg.exec(`
        CREATE TABLE automation_runs (id TEXT PRIMARY KEY, root_run_id TEXT);
        CREATE TABLE automation_form_sessions (
            id TEXT PRIMARY KEY, run_id TEXT, is_test BOOLEAN, expires_at TIMESTAMPTZ, updated_at TIMESTAMPTZ,
            pending_work JSONB, pending_lease_until TIMESTAMPTZ, pending_attempts INT DEFAULT 0
        );
        CREATE TABLE automation_run_steps (run_id TEXT, step_id TEXT, attempts INT, status TEXT, finished_at TIMESTAMPTZ);
    `);
});
after(async () => { await pg.close(); });
beforeEach(async () => {
    await pg.exec(`
        TRUNCATE automation_runs; TRUNCATE automation_form_sessions; TRUNCATE automation_run_steps;
        INSERT INTO automation_runs VALUES ('head', NULL), ('leg2', 'head'), ('leg3', 'head'), ('other', NULL);
        INSERT INTO automation_form_sessions VALUES
            ('visitor', 'leg2', NULL, NOW() + INTERVAL '1 hour', NOW(), '{"kind":"resume"}', NOW(), 2),
            ('tester', 'other', TRUE, NOW() + INTERVAL '1 hour', NOW(), NULL, NULL, 0);
        INSERT INTO automation_run_steps VALUES ('leg3', 'fp_2', 1, 'awaiting_form', NULL), ('leg3', 's1', 1, 'success', NOW());
    `);
});

test('the paused step row moves once, and only from its paused status', async () => {
    assert.strictEqual(await store.closeAwaitingStepRow('leg3', 'fp_2', 'awaiting_form', 'cancelled'), 1);
    assert.strictEqual(await store.closeAwaitingStepRow('leg3', 'fp_2', 'awaiting_form', 'cancelled'), 0);
    assert.strictEqual(await store.closeAwaitingStepRow('leg3', 's1', 'awaiting_form', 'cancelled'), 0, 'a settled row is left alone');
    const { rows } = await pg.query(`SELECT step_id, status, finished_at IS NOT NULL AS done FROM automation_run_steps ORDER BY step_id`);
    assert.deepStrictEqual(rows.map((r) => [r.step_id, r.status, r.done]), [['fp_2', 'cancelled', true], ['s1', 'success', true]]);
});

test('a journey\'s session is found from any of its legs, with is_test', async () => {
    for (const leg of ['head', 'leg2', 'leg3']) {
        assert.deepStrictEqual(await store.getFormSessionsForJourney(leg), [{ id: 'visitor', isTest: false }], leg);
    }
    assert.deepStrictEqual(await store.getFormSessionsForJourney('other'), [{ id: 'tester', isTest: true }]);
    assert.deepStrictEqual(await store.getFormSessionsForJourney(''), []);
});

test('ending the journey\'s session expires it and drops its queued work, nobody else\'s', async () => {
    assert.strictEqual(await store.endFormSessionForRun('leg3'), 1);
    const { rows } = await pg.query(`SELECT id, expires_at <= NOW() AS ended, pending_work, pending_lease_until, pending_attempts FROM automation_form_sessions ORDER BY id`);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.strictEqual(byId.visitor.ended, true);
    assert.strictEqual(byId.visitor.pending_work, null);
    assert.strictEqual(byId.visitor.pending_lease_until, null);
    assert.strictEqual(byId.visitor.pending_attempts, 0);
    assert.strictEqual(byId.tester.ended, false);
});
