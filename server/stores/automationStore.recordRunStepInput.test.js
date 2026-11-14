// @typecheck
/**
 * A step's recorded INPUT survives the second write, against a real Postgres
 * (the boot ladder's schema on PGlite, testUtils/pgliteTemplate.js
 * ladderPglite, behind db.js's pool).
 *
 * recordRunStep upserts on (run_id, step_id, attempts). The engine writes the
 * row TWICE: at dispatch, `status:'running'` with no input yet, so a public
 * form's progress trail has something to read, and on completion with the real
 * input and output. Whichever lands second must not erase an input the row
 * already holds, in either order (a retried attempt re-records).
 *
 * Run: cd server && node --test stores/automationStore.recordRunStepInput.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../testUtils/pglitePool');
const { ladderPglite } = require('../testUtils/pgliteTemplate');

const { pg, close } = usePglitePool(ladderPglite());
const store = require('./automationStore');

test.before(async () => {
    await pg.exec('SET session_replication_role = replica');
});
test.after(close);

const step = (stepId, extra) => store.recordRunStep({
    runId: 'r1', stepId, stepType: 'ai_step', attempts: 1, startedAt: new Date().toISOString(), output: null, error: null, ...extra,
});
async function stored(stepId) {
    const { rows } = await pg.query('SELECT status, input_json, output_json FROM automation_run_steps WHERE run_id = $1 AND step_id = $2', ['r1', stepId]);
    const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
    return { status: rows[0].status, input: parse(rows[0].input_json), output: parse(rows[0].output_json), count: rows.length };
}

test('a completing write after the dispatch row carries its own input', async () => {
    await step('s1', { status: 'running', input: null });
    await step('s1', { status: 'success', finishedAt: new Date().toISOString(), input: { prompt: 'hello' }, output: { text: 'hi' } });
    assert.deepStrictEqual(await stored('s1'), { status: 'success', input: { prompt: 'hello' }, output: { text: 'hi' }, count: 1 });
});

test('a write without an input never erases the one the row already has', async () => {
    await step('s2', { status: 'success', finishedAt: new Date().toISOString(), input: { prompt: 'hello' }, output: { text: 'hi' } });
    await step('s2', { status: 'handled_error', input: null });
    const s = await stored('s2');
    assert.strictEqual(s.status, 'handled_error');
    assert.deepStrictEqual(s.input, { prompt: 'hello' }, 'a null input must never overwrite a recorded one');
});
