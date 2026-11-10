'use strict';

/**
 * A `parallel` step in a background action (backgroundRun.mts), with a fake clock and an
 * injected executor against the REAL run store on PGlite: the branches run side by side in
 * the job, their variables are joined into the job's result, and a failing branch fails the job.
 *
 * Run: cd server && node --test appStudio/backgroundRun.parallel.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const BG = require('./backgroundRun.mts');
const { backgroundRunHarness } = require('../testUtils/backgroundRunHarness.testkit');

const { s, deps, input, startAndSettle, status } = backgroundRunHarness({ before, after, beforeEach });

const ai = (prompt, resultVar) => ({ kind: 'ai_generate', prompt, resultVar });
const parallel = (branches, extra = {}) => ({ kind: 'parallel', branches: branches.map((steps) => ({ steps })), ...extra });

test('a background action runs the branches side by side and ends in success', async () => {
    let live = 0;
    let peak = 0;
    s.execute = async (_a, _m, step) => {
        live += 1;
        peak = Math.max(peak, live);
        await new Promise((resolve) => { setImmediate(resolve); });
        live -= 1;
        return { ok: true, result: { text: `answer to ${step.prompt}` } };
    };
    const action = { kind: 'sequence', background: true, progressVar: 'status', steps: [
        status('Working'),
        parallel([[ai('one', 'first')], [ai('two', 'second')], [status('Third branch')]]),
        status('Finished'),
    ] };
    const run = await startAndSettle(action);
    assert.equal(run.status, 'success', JSON.stringify(run).slice(0, 400));
    assert.equal(peak, 2, 'both AI steps were running at the same moment');
    assert.deepEqual(s.executed.map((e) => e.step.prompt).sort(), ['one', 'two']);
});

test('a failing branch fails the background job with that step\'s message', async () => {
    s.execute = async (_a, _m, step) => (step.prompt === 'bad' ? { ok: false, error: 'The model did not answer', retryable: false } : { ok: true, result: { text: 'fine' } });
    const action = { kind: 'sequence', background: true, steps: [parallel([[ai('bad', 'first')], [ai('good', 'second')]]), ai('never', 'x')] };
    const run = await startAndSettle(action);
    assert.equal(run.status, 'error');
    assert.match(JSON.stringify(run), /The model did not answer/);
    assert.deepEqual(s.executed.map((e) => e.step.prompt).sort(), ['bad', 'good'], 'the other branch ran, the step after the parallel did not');
});

test('a toast in a branch is kept for the end of the job; a transaction is refused by the branch', async () => {
    const toasts = { kind: 'sequence', background: true, steps: [parallel([[{ kind: 'toast', message: 'Half way', tone: 'info' }], [ai('one', 'first')]])] };
    assert.equal((await startAndSettle(toasts)).status, 'success');
    // A navigate in a branch never gets this far: the start refuses it like anywhere else in a background action.
    const nav = { kind: 'sequence', background: true, steps: [parallel([[{ kind: 'navigate', screenId: 'scr_1' }], [ai('one', 'first')]])] };
    const refused = await BG.startBackgroundRun(input(nav), deps());
    assert.equal(refused.code, 'background_not_runnable');
    const tx = { kind: 'sequence', background: true, steps: [parallel([[{ kind: 'transaction', steps: [{ kind: 'create_record', tableId: 't', values: {} }] }], [ai('two', 'second')]])] };
    const run = await startAndSettle(tx);
    assert.equal(run.status, 'error');
    assert.match(JSON.stringify(run), /cannot run inside a branch of a parallel step/);
    assert.deepEqual(s.executed.map((e) => e.step.kind), ['ai_generate', 'ai_generate'], 'the transaction never reached the executor');
});
