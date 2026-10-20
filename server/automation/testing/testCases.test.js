'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const { findCodeStep, captureFixture, runTestCases } = require('./testCases');

const codeStep = (id, extra = {}) => ({ id, type: 'code', code: 'return 1;', inputs: { amount: { kind: 'literal', value: 1 } }, ...extra });

const definition = () => ({
    steps: [
        codeStep('root'),
        { id: 'note', type: 'note' },
        { id: 'loop', type: 'loop', body: [codeStep('in_loop')] },
        { id: 'par', type: 'parallel', branches: [[codeStep('in_branch')]] },
    ],
    layers: { sub: { steps: [codeStep('in_layer')] } },
});

test('findCodeStep finds root, loop body, parallel branch and layer steps, and only code steps', () => {
    const def = definition();
    for (const id of ['root', 'in_loop', 'in_branch', 'in_layer']) assert.strictEqual(findCodeStep(def, id)?.id, id, id);
    assert.strictEqual(findCodeStep(def, 'note'), null);
    assert.strictEqual(findCodeStep(def, 'loop'), null);
    assert.strictEqual(findCodeStep(def, 'missing'), null);
    assert.strictEqual(findCodeStep(null, 'root'), null);
});

// ── capture ───────────────────────────────────────────────────────────────────

function captureDeps(rows) {
    const created = [];
    return {
        created,
        store: { getRunStepsForChain: async () => rows },
        testingStore: { createFixture: async (f) => { created.push(f); return { id: 'tfx_1' }; } },
    };
}
const automation = { id: 'a1', definition: { steps: [codeStep('s1', { inputs: { amount: {}, name: {}, secretKeys: ['k'] } })] } };
const runA = { id: 'r1' };
const row = (extra = {}) => ({ runId: 'r1', stepId: 's1', attempts: 1, input: { amount: 5, name: 'x', secretKeys: ['k'], leftover: 'old' }, ...extra });

afterEach(() => { delete process.env.AUTOMATION_TEST_FIXTURE_MAX_BYTES; });

test('capture keeps only the declared inputs and drops secretKeys and leftovers', async () => {
    const deps = captureDeps([row()]);
    const out = await captureFixture({ automation, stepId: 's1', run: runA, legs: [runA] }, deps);
    assert.deepStrictEqual(out, { id: 'tfx_1' });
    assert.deepStrictEqual(deps.created[0], { automationId: 'a1', runId: 'r1', stepId: 's1', input: { amount: 5, name: 'x' } });
});

test('capture takes the given attempt, else the last, and ignores unreadable legs', async () => {
    const rows = [
        row({ attempts: 1, input: { amount: 1 } }),
        row({ attempts: 2, input: { amount: 2 } }),
        row({ runId: 'hidden', attempts: 3, input: { amount: 99 } }),
    ];
    let deps = captureDeps(rows);
    await captureFixture({ automation, stepId: 's1', run: runA, legs: [runA] }, deps);
    assert.strictEqual(deps.created[0].input.amount, 2, 'the last readable attempt');
    deps = captureDeps(rows);
    await captureFixture({ automation, stepId: 's1', run: runA, legs: [runA], attempts: 1 }, deps);
    assert.strictEqual(deps.created[0].input.amount, 1);
});

test('capture refuses: no row, a truncated input, a too large input, a step that is not code', async () => {
    const attempt = (rows, stepId = 's1') => captureFixture({ automation, stepId, run: runA, legs: [runA] }, captureDeps(rows));
    await assert.rejects(() => attempt([]), (e) => e.status === 422 && e.code === 'step_not_in_run');
    await assert.rejects(() => attempt([row({ input: null })]), (e) => e.code === 'step_not_in_run');
    await assert.rejects(() => captureFixture({ automation, stepId: 's1', run: runA, legs: [runA], attempts: 7 }, captureDeps([row()])), (e) => e.code === 'step_not_in_run');
    await assert.rejects(() => attempt([row({ input: { __truncated__: true } })]), (e) => e.status === 422 && e.code === 'fixture_truncated');
    process.env.AUTOMATION_TEST_FIXTURE_MAX_BYTES = '10';
    await assert.rejects(() => attempt([row({ input: { amount: 'x'.repeat(100) } })]), (e) => e.status === 413 && e.code === 'fixture_too_large');
    process.env.AUTOMATION_TEST_FIXTURE_MAX_BYTES = '0';
    await attempt([row({ input: { amount: 'x'.repeat(100) } })]);
    await assert.rejects(() => attempt([row()], 'nope'), (e) => e.status === 404 && e.code === 'step_not_found');
});

// ── run ───────────────────────────────────────────────────────────────────────

const outcomeSandbox = (fn) => ({
    isAvailable: () => true,
    async runCode(args) {
        const out = fn(args);
        if (out instanceof Error) throw out;
        return out;
    },
});

function runDeps({ inputs = {}, sandbox } = {}) {
    const recorded = [];
    return {
        recorded,
        testingStore: {
            getTestCaseInput: async (_a, id) => inputs[id] ?? null,
            recordTestCaseResult: async (_a, id, r) => { recorded.push([id, r.status]); },
        },
        sandbox,
    };
}

const step = { id: 's1', type: 'code', code: 'return { n: 2 };', allowedTools: ['gmail_send'], allowedHosts: [], limits: { wallMs: 500 } };
const caseOf = (id, extra = {}) => ({ id, name: `case ${id}`, stepId: 's1', expect: 'success', assertions: [], ...extra });

test('a run reports pass, fail, error and unusable, and keeps every verdict', async () => {
    const sandbox = outcomeSandbox((args) => {
        if (args.inputs.boom) return new Error('exploded');
        return { result: { n: 2 }, logs: ['l'], calls: [] };
    });
    const deps = runDeps({
        sandbox,
        inputs: {
            ok: { kind: 'typed', values: {} },
            bad: { kind: 'typed', values: {} },
            thrown: { kind: 'typed', values: { boom: true } },
            gone: { kind: 'run', available: false },
            fromRun: { kind: 'run', available: true, values: {}, runId: 'r1', fixtureId: 'tfx_1' },
        },
    });
    const out = await runTestCases({
        automation: { id: 'a1' },
        step,
        orgId: 'org1',
        cases: [
            caseOf('ok', { assertions: [{ id: 'x', op: 'equals', path: 'n', value: 2 }] }),
            caseOf('bad', { assertions: [{ id: 'x', op: 'equals', path: 'n', value: 3 }] }),
            caseOf('thrown'),
            caseOf('gone'),
            caseOf('fromRun'),
        ],
    }, deps);
    assert.deepStrictEqual(out.results.map((r) => [r.caseId, r.status]),
        [['ok', 'pass'], ['bad', 'fail'], ['thrown', 'fail'], ['gone', 'unusable'], ['fromRun', 'pass']]);
    assert.deepStrictEqual(out.summary, { passed: 2, failed: 2, errored: 0, unusable: 1 });
    assert.strictEqual(out.stepId, 's1');
    const ok = out.results[0];
    assert.deepStrictEqual(ok.expectation, { expected: 'success', got: 'success' });
    assert.strictEqual(ok.assertions[0].ok, true);
    assert.deepStrictEqual(ok.result, { n: 2 });
    assert.deepStrictEqual(ok.logs, ['l']);
    const bad = out.results[1];
    assert.strictEqual(bad.assertions[0].code, 'not_equal');
    const thrown = out.results[2];
    assert.deepStrictEqual(thrown.expectation, { expected: 'success', got: 'error' });
    assert.strictEqual(thrown.error, 'exploded');
    assert.deepStrictEqual(thrown.assertions, []);
    assert.strictEqual(out.results[3].reason, 'fixture_expired');
    assert.deepStrictEqual(deps.recorded, [['ok', 'pass'], ['bad', 'fail'], ['thrown', 'fail'], ['gone', 'unusable'], ['fromRun', 'pass']]);
});

test('expect error: passes when the code throws, assertions read {message}', async () => {
    const sandbox = outcomeSandbox((args) => (args.inputs.boom ? new Error('Amount is missing') : { result: 1 }));
    const deps = runDeps({ sandbox, inputs: { e1: { kind: 'typed', values: { boom: 1 } }, e2: { kind: 'typed', values: {} } } });
    const out = await runTestCases({
        automation: { id: 'a1' },
        step,
        cases: [
            caseOf('e1', { expect: 'error', assertions: [{ id: 'm', op: 'contains', path: 'message', value: 'missing' }] }),
            caseOf('e2', { expect: 'error' }),
        ],
    }, deps);
    assert.strictEqual(out.results[0].status, 'pass');
    assert.deepStrictEqual(out.results[0].expectation, { expected: 'error', got: 'error' });
    assert.strictEqual(out.results[0].error, 'Amount is missing');
    assert.strictEqual(out.results[1].status, 'fail');
    assert.deepStrictEqual(out.results[1].expectation, { expected: 'error', got: 'success' });
});

test('the body code replaces the saved code; tools, limits and the fairness key come from the step', async () => {
    const seen = [];
    const sandbox = outcomeSandbox((args) => { seen.push(args); return { result: 1 }; });
    const deps = runDeps({ sandbox, inputs: { c: { kind: 'typed', values: { q: 1 } } } });
    await runTestCases({ automation: { id: 'a1' }, step, cases: [caseOf('c')], code: 'return 42;', orgId: 'org9' }, deps);
    assert.strictEqual(seen[0].code, 'return 42;');
    assert.deepStrictEqual([...seen[0].bridges.allowedTools], ['gmail_send']);
    assert.deepStrictEqual(seen[0].limits, { wallMs: 500 });
    assert.strictEqual(seen[0].concurrencyKey, 'org9');
    assert.strictEqual(seen[0].mode, 'test');
});

test('refusals become an error verdict with a reason; no sandbox is sandbox_missing', async () => {
    const inputs = { c: { kind: 'typed', values: {} } };
    const cases = [caseOf('c')];
    const syntax = await runTestCases({ automation: { id: 'a1' }, step, cases, code: 'return {;' }, runDeps({ sandbox: outcomeSandbox(() => ({})), inputs }));
    assert.deepStrictEqual([syntax.results[0].status, syntax.results[0].reason], ['error', 'code_syntax_error']);
    assert.deepStrictEqual(syntax.results[0].expectation, { expected: 'success', got: null });
    const blocked = await runTestCases({ automation: { id: 'a1' }, step, cases, code: 'return eval("1");' }, runDeps({ sandbox: outcomeSandbox(() => ({})), inputs }));
    assert.strictEqual(blocked.results[0].reason, 'code_blocked');
    const param = await runTestCases({
        automation: { id: 'a1' }, step, cases, code: '/**\n * @param {number} a - A\n */\nasync function main(i){return i.a;}',
    }, runDeps({ sandbox: outcomeSandbox(() => ({})), inputs }));
    assert.strictEqual(param.results[0].reason, 'code_param_invalid');
    const none = await runTestCases({ automation: { id: 'a1' }, step, cases }, runDeps({ sandbox: { isAvailable: () => false }, inputs }));
    assert.deepStrictEqual([none.results[0].status, none.results[0].reason], ['error', 'sandbox_missing']);
    assert.deepStrictEqual(none.summary, { passed: 0, failed: 0, errored: 1, unusable: 0 });
});

test('a case whose input vanished mid-run is unusable', async () => {
    const out = await runTestCases({ automation: { id: 'a1' }, step, cases: [caseOf('x')] }, runDeps({ sandbox: outcomeSandbox(() => ({})) }));
    assert.strictEqual(out.results[0].status, 'unusable');
});
