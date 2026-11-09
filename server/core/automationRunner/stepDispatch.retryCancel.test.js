/**
 * Step retries stop when the run stops, and a stored retry is bounded.
 *
 * retryStep re-ran a failed step `retry.max` times with `retry.backoffMs`
 * between tries and looked at nothing else. Two consequences:
 *
 *   - A run that was cancelled (or hit its time budget, which aborts the same
 *     signal) while a step was failing kept re-sending that step: the POST, the
 *     mail, the model call went out again after the user pressed Stop, and the
 *     run could not be finalised until the last backoff had been slept out —
 *     raceRunDag waits for the DAG to unwind.
 *   - `step.retry` was taken as stored. The editor offers at most 5 tries and
 *     a minute between them, but nothing validated the field, so an imported or
 *     generated definition with `{ max: 100000, backoffMs: 3600000 }` pinned a
 *     runner slot (and the automation's marker) for as long as it liked.
 *
 * Run: cd server && node --test core/automationRunner/stepDispatch.retryCancel.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeStepDispatcher } = require('./stepDispatch');
const { execForEachStep } = require('./execFlow');
const { stepRetryFor, resolveRunPolicy, RETRY_MAX, RETRY_BACKOFF_MAX_MS } = require('./runPolicy');

function harness({ onAttempt, dbCancelled = () => false } = {}) {
    const rows = [];
    const attempts = [];
    const controller = new AbortController();
    const engine = {
        execForEachStep,
        ApprovalRequiredError: class A extends Error {},
        FormInputRequiredError: class F extends Error {},
        secretValuesFor: () => [],
        execHttpRequest: async (step) => {
            attempts.push(Date.now());
            if (onAttempt) await onAttempt(attempts.length, controller);
            throw new Error(`upstream 503 for ${step.id}`);
        },
    };
    const deps = {
        isCancelRequested: async () => dbCancelled(),
        automationStore: { recordRunStep: async (row) => { rows.push(row); } },
        engine,
        execFlatten: async () => ({}),
    };
    const dispatch = makeStepDispatcher(deps, { run: { id: 'r1' }, cancelSignal: controller.signal, runPolicy: resolveRunPolicy({}) });
    const ctx = { runId: 'r1', _bindingMisses: [], cancelSignal: controller.signal };
    const state = () => ({ steps: {}, trigger: { output: {} }, _templateWarnings: [] });
    return { rows, attempts, controller, dispatch, ctx, state };
}

const httpStep = (retry) => ({ type: 'http_request', id: 'post', method: 'POST', url: 'https://example.test/hook', retry });

test('a step is not sent again once the run has been cancelled', async () => {
    const h = harness({ onAttempt: (n, controller) => { if (n === 1) controller.abort(); } });
    await assert.rejects(() => h.dispatch(httpStep({ max: 3 }), h.ctx, h.state(), 'live'));
    assert.equal(h.attempts.length, 1, `the step went out ${h.attempts.length} times; every one after the first was after the cancel`);
});

test('a cancel issued on another instance (the DB flag) stops the retries too', async () => {
    let cancelled = false;
    const h = harness({ onAttempt: (n) => { if (n === 1) cancelled = true; }, dbCancelled: () => cancelled });
    await assert.rejects(() => h.dispatch(httpStep({ max: 3 }), h.ctx, h.state(), 'live'), /Run cancelled/);
    assert.equal(h.attempts.length, 1);
});

test('a cancel during the wait between tries ends the wait', async () => {
    const h = harness();
    const started = Date.now();
    const pending = h.dispatch(httpStep({ max: 2, backoffMs: 30_000 }), h.ctx, h.state(), 'live');
    setTimeout(() => h.controller.abort(), 50);
    await assert.rejects(() => pending, /Run cancelled/);
    assert.ok(Date.now() - started < 5_000, 'the retry slept out its full backoff after the run was cancelled');
    assert.equal(h.attempts.length, 1);
});

test('without a cancel the step is still retried, and every failed try is recorded', async () => {
    const h = harness();
    await assert.rejects(() => h.dispatch(httpStep({ max: 2 }), h.ctx, h.state(), 'live'), /upstream 503/);
    assert.equal(h.attempts.length, 3);
    assert.deepEqual(h.rows.map(r => [r.status, r.attempts]), [['error', 1], ['error', 2], ['error', 3]]);
});

test('a stored step retry is bounded to what the editor can express', () => {
    const policy = resolveRunPolicy({});
    assert.deepEqual(stepRetryFor({ id: 's', retry: { max: 100_000, backoffMs: 3_600_000 } }, policy), { max: RETRY_MAX, backoffMs: RETRY_BACKOFF_MAX_MS });
    assert.deepEqual(stepRetryFor({ id: 's', retry: { max: '3', backoffMs: '2000' } }, policy), { max: 3, backoffMs: 2000 });
    assert.deepEqual(stepRetryFor({ id: 's', retry: { max: -4, backoffMs: -1 } }, policy), { max: 0, backoffMs: 0 });
    assert.deepEqual(stepRetryFor({ id: 's', retry: { max: 'lots', backoffMs: Infinity } }, policy), { max: 0, backoffMs: 0 });
    // What the editor writes passes through unchanged.
    assert.deepEqual(stepRetryFor({ id: 's', retry: { max: 5, backoffMs: 60_000 } }, policy), { max: 5, backoffMs: 60_000 });
    assert.deepEqual(stepRetryFor({ id: 's', retry: { max: 1, backoffMs: 10 } }, policy), { max: 1, backoffMs: 10 });
});

test('the per-item retry of a fan-out is bounded the same way', async () => {
    const h = harness();
    const step = { ...httpStep({ max: 100_000 }), forEach: { overRef: 'steps.src.output.items', itemVar: 'item' } };
    const st = h.state();
    st.steps.src = { output: { items: [{ n: 1 }] } };
    await assert.rejects(() => h.dispatch(step, h.ctx, st, 'live'));
    assert.equal(h.attempts.length, RETRY_MAX + 1, 'one first try plus the bounded retries, for the one item');
});
