/**
 * A step's mappings that found nothing survive the database and come back on
 * the step row (automation_run_steps.binding_warnings → rowToRunStep's
 * `bindingWarnings`), which is what GET /runs/:id/steps hands the Runs tab and
 * the step's output panel.
 *
 * Runs recordRunStep's real SQL against a real Postgres (@electric-sql/pglite,
 * in-process) through recordRunStepWith's injected `run`: no module mocking.
 * The column comes from its own migration, so the test also proves the two
 * agree.
 *
 * Proven:
 *   - a success, an error and a pause row keep the list, with the server's
 *     sentence on each entry, and read back as `bindingWarnings`;
 *   - a step that missed nothing stores NULL and reads null;
 *   - a later upsert that does not know about it (runDag flipping a row to
 *     handled_error) does not erase it, like tools_withheld;
 *   - the stored copy is redacted like the step's error.
 *
 * Run: cd server && node --test stores/automationStore/runs.bindingWarnings.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgliteDb } = require('../../testUtils/pgliteDb');
const { recordRunStepWith } = require('./runs');
const { rowToRunStep } = require('./rowMappers');
const migration = require('../../migrations/automation-run-step-binding-warnings-2026-10');

const { pg, db } = pgliteDb();
const run = (sql, params) => db.query(sql, params);
const record = (args) => recordRunStepWith(run, {
    runId: 'r1', stepType: 'integration_action', attempts: 1, startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(), input: { to: null }, output: null, error: null, ...args,
});
const stepRow = async (stepId) => rowToRunStep((await pg.query(
    'SELECT * FROM automation_run_steps WHERE run_id = $1 AND step_id = $2', ['r1', stepId],
)).rows[0]);

const MISS = {
    field: 'to', kind: 'ref', path: 'steps.read.output.contact.e-mail', reason: 'missing',
    at: 'steps.read.output.contact', found: 'record', missing: 'e-mail', count: 1,
};

before(async () => {
    // The columns recordRunStep writes, as the earlier migrations leave them.
    await pg.exec(`CREATE TABLE automation_run_steps (
        run_id TEXT NOT NULL, step_id TEXT NOT NULL, parent_step_id TEXT, step_type TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 1, status TEXT, started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ,
        input_json JSON, output_json JSON, error TEXT, error_class TEXT, branch_index INTEGER,
        pii_summary JSONB, tools_withheld JSONB, error_info JSONB,
        PRIMARY KEY (run_id, step_id, attempts))`);
    await migration.up({ exec: (sql) => pg.exec(sql) });
});
after(async () => { await pg.close(); });

test('a success row keeps its misses and reads them back with the sentence', async () => {
    await record({ stepId: 'mail', status: 'success', output: { sent: true }, bindingWarnings: [MISS] });
    const step = await stepRow('mail');
    assert.deepEqual(step.bindingWarnings, [{
        ...MISS,
        description: 'input "to" read steps.read.output.contact.e-mail, but steps.read.output.contact has no "e-mail"',
    }]);
});

test('a step that missed nothing stores NULL and reads null', async () => {
    await record({ stepId: 'clean', status: 'success', output: { ok: 1 } });
    await record({ stepId: 'empty', status: 'success', output: { ok: 1 }, bindingWarnings: [] });
    assert.equal((await stepRow('clean')).bindingWarnings, null);
    assert.equal((await stepRow('empty')).bindingWarnings, null);
});

test('error and pause rows keep them too (often the reason it failed)', async () => {
    const notRun = { field: 'body', kind: 'template', path: 'steps.later.output.text', reason: 'not_run', step: 'later', count: 2 };
    await record({ stepId: 'fail', status: 'error', error: 'to is required', bindingWarnings: [MISS, notRun] });
    await record({ stepId: 'wait', status: 'awaiting_approval', output: { prompt: 'OK?' }, bindingWarnings: [notRun] });
    const fail = await stepRow('fail');
    assert.deepEqual(fail.bindingWarnings.map((w) => [w.field, w.reason, w.count]), [['to', 'missing', 1], ['body', 'not_run', 2]]);
    assert.match(fail.bindingWarnings[1].description, /step "later" has not run in this run \(2×\)/);
    assert.equal((await stepRow('wait')).bindingWarnings.length, 1);
});

test('a later upsert that does not carry them does not erase them', async () => {
    // runDag re-records a failed step as handled_error when an error branch
    // takes it; that write knows nothing about the binding log.
    await record({ stepId: 'fail', status: 'handled_error', error: 'to is required' });
    const step = await stepRow('fail');
    assert.equal(step.status, 'handled_error');
    assert.equal(step.bindingWarnings.length, 2);
});

test('the stored copy is redacted like the step error', async () => {
    const key = 'sk-abcdefghijklmnop1234';
    await record({
        stepId: 'auth', status: 'success', output: { ok: 1 }, secretValues: ['hunter2-secret'],
        bindingWarnings: [{ field: 'auth', kind: 'expr', path: 'concat("hunter2-secret", steps.a.output.x)', reason: 'error', message: `bad key ${key}` }],
    });
    const raw = (await pg.query(`SELECT binding_warnings::text AS t FROM automation_run_steps WHERE step_id = 'auth'`)).rows[0].t;
    assert.ok(!raw.includes(key));
    assert.ok(!raw.includes('hunter2-secret'));
});
