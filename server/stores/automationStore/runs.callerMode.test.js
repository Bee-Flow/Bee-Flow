// @typecheck
'use strict';

/**
 * The run row remembers the mode it started in, and the step row which
 * identity an integration step ran as, against a real Postgres (the boot
 * ladder's schema on PGlite, testUtils/pgliteTemplate.js ladderPglite).
 *
 * Run: cd server && node --test stores/automationStore/runs.callerMode.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { pgliteDb } = require('../../testUtils/pgliteDb');
const { ladderPglite } = require('../../testUtils/pgliteTemplate');
const { recordRunStepWith: recordRunStepTyped } = require('./runs');
/** @type {(run: Function, step: any) => Promise<void>} */
const recordRunStepWith = /** @type {any} */ (recordRunStepTyped);
const { rowToRun, rowToRunStep } = require('./rowMappers');

const { pg, db } = pgliteDb(ladderPglite());

before(async () => {
    await pg.exec('SET session_replication_role = replica');
});
after(() => pg.close());

const identityOf = async (stepId) => (await pg.query(
    'SELECT * FROM automation_run_steps WHERE run_id = $1 AND step_id = $2', ['r', stepId],
)).rows.map(rowToRunStep)[0].identityUserId;

test('rowToRun exposes connections_mode as connectionsMode (null by default)', () => {
    assert.strictEqual(rowToRun({ id: 'r', connections_mode: 'caller' }).connectionsMode, 'caller');
    assert.strictEqual(rowToRun({ id: 'r' }).connectionsMode, null);
});

test('recordRunStep stores the identity an integration step ran as, and keeps it across upserts', async () => {
    await recordRunStepWith(db.query, { runId: 'r', stepId: 's', stepType: 'integration_action', status: 'running', identityUserId: 'u-caller' });
    assert.strictEqual(await identityOf('s'), 'u-caller');
    await recordRunStepWith(db.query, { runId: 'r', stepId: 's', stepType: 'integration_action', status: 'success' });
    assert.strictEqual(await identityOf('s'), 'u-caller', 'a later upsert without an identity keeps it');
    await recordRunStepWith(db.query, { runId: 'r', stepId: 's2', stepType: 'set', status: 'success' });
    assert.strictEqual(await identityOf('s2'), null);
});
