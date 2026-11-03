// @typecheck
/**
 * RM-3: a dry run refuses a code step the way a live run does.
 *
 * The guard's refusal (a syntax error, a BLOCK finding, a missing required
 * parameter) is a static check with no side effect, so a rehearsal throws it:
 * the step's row is red, not a green "skipped" that the next live run turns
 * into a failure. Only an environmental cause (the sandbox is not installed
 * on this server) stays a skip, and then with skippedReason so runDagRecord
 * records it amber ('skipped'), never 'success'.
 *
 * Run: node --test core/automationRunner/execCode.dryRunRefusal.test.js
 */
'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
/** Results are read loosely here: each case asserts the fields it is about. */
const anyOf = (/** @type {any} */ v) => v;
const { registerRunnerPorts } = require('./featurePorts');
const shared = require('./shared');
const { execCode } = require('./execCode');

const sandboxState = { available: true, ran: 0 };
registerRunnerPorts({
    codeSandbox: {
        isAvailable: () => sandboxState.available,
        loadError: () => "Cannot find module 'isolated-vm'",
        secretsNotConfiguredMessage: () => 'secrets are not configured',
        defaultFetchHttp: async () => ({}),
        runCode: async () => { sandboxState.ran += 1; throw new Error('the sandbox must not be reached'); },
    },
});

beforeEach(() => { sandboxState.available = true; sandboxState.ran = 0; });

const ctx = () => ({ userId: 'u1', orgId: 'o1' });
const state = () => ({ steps: {}, trigger: { output: {} } });
const step = (code, inputs = {}) => ({ id: 'c1', type: 'code', code, inputs });

test('dry run: a syntax error throws, exactly as live', async () => {
    const s = step('return inputs.x +;');
    for (const mode of ['dry_run', 'live']) {
        await assert.rejects(() => execCode(s, ctx(), state(), mode), /syntax error at line 1/);
    }
    assert.equal(sandboxState.ran, 0);
});

test('dry run: a blocked pattern throws, exactly as live', async () => {
    const s = step('return eval("1");');
    for (const mode of ['dry_run', 'live']) {
        await assert.rejects(() => execCode(s, ctx(), state(), mode), /This code step was stopped/);
    }
});

test('dry run: a missing required parameter on REAL data throws', async () => {
    const code = `/**
 * @param {number} amount - Amount
 */
function main(inputs) { return inputs.amount; }`;
    await assert.rejects(() => execCode(step(code), ctx(), state(), 'dry_run'), /Amount/);
});

test('dry run: a missing required parameter on SYNTHESISED data is an amber skip, not red', async (t) => {
    t.mock.method(shared, 'stepInputsSynthetic', () => true);
    const code = `/**
 * @param {number} amount - Amount
 */
function main(inputs) { return inputs.amount; }`;
    const out = anyOf(await execCode(step(code), ctx(), state(), 'dry_run'));
    assert.equal(out.skippedReason, 'synthetic_input');
    assert.equal(out.output._dryRunSyntheticInputs, true);
    assert.match(out.output.skipped, /simulated data/);
    // A syntax error stays red whatever the data was.
    await assert.rejects(() => execCode(step('return {;'), ctx(), state(), 'dry_run'), /syntax error/);
});

test('dry run: a missing sandbox is a would_fail_live skip (amber row), live refuses', async () => {
    sandboxState.available = false;
    const s = step('function main() { return 1; }');
    const out = anyOf(await execCode(s, ctx(), state(), 'dry_run'));
    assert.equal(out.skippedReason, 'would_fail_live', 'runDagRecord records a skippedReason as skipped, never success');
    assert.match(out.output.skipped, /sandbox is not installed/);
    assert.match(out.output.skipped, /live run would fail/);
    await assert.rejects(() => execCode(s, ctx(), state(), 'live'), /Code step unavailable/);
});
