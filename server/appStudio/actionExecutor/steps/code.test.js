'use strict';

/**
 * The app `code` step's executor (./code.mts) against the REAL sandbox (isolated-vm), where it
 * is installed: inputs resolved before the isolate starts, under the row access of the person
 * running the action; no network, integrations or database; the sandbox's limits; every failure
 * a step result with a code.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sandbox = require('../../../automation/codeSandbox.js');
const { runCodeStep, runStep, limitsOf, inputByteCap, sandboxFailure, DEFAULT_INPUT_KB } = require('./code.mts');
const { BindingRefusal } = require('../../runBindings.mts');
const { executeDataStep } = require('../dispatch');

const APP = { id: 'app_1', userId: 'u_owner', organizationId: 'org_1' };
const MODEL = { tables: [{ id: 'tbl_lines', key: 'lines', fields: [] }] };
const viewerCtx = (over = {}) => ({ viewerId: 'u_view', role: 'agent', orgId: 'org_1', viewer: { id: 'u_view', role: 'agent', organizationId: 'org_1' }, ...over });
const ownerCtx = (over = {}) => ({ viewerId: 'u_owner', role: 'owner', orgId: 'org_1', viewer: { id: 'u_owner', role: 'owner', organizationId: 'org_1' }, ...over });
const live = { skip: sandbox.isAvailable() ? false : 'isolated-vm is not installed here' };

test('main(inputs) runs over the resolved inputs and its return value is the result', live, async () => {
    const step = {
        kind: 'code',
        code: 'function main(inputs) {\n  const total = inputs.lines.reduce((s, l) => s + l.qty * l.price, 0);\n  return { total, label: inputs.label + "!" };\n}',
        inputs: { lines: { kind: 'records', tableId: 'tbl_lines' }, label: { kind: 'formula', expr: 'form.title' } },
        resultVar: 'totals',
    };
    const reads = [];
    const readData = async (_app, _model, binding, opts) => {
        reads.push({ binding, viewer: opts.viewer, role: opts.role, maxRows: opts.maxRows });
        return [{ qty: 2, price: 5 }, { qty: 1, price: 3 }];
    };
    const res = await runCodeStep(APP, MODEL, step, viewerCtx({ formValues: { title: 'Order' } }), { readData });
    assert.deepEqual(res, { ok: true, result: { total: 13, label: 'Order!' } });
    // Read as the person who clicked, with their role: never as the owner.
    assert.equal(reads.length, 1);
    assert.deepEqual(reads[0].viewer, { id: 'u_view', role: 'agent', organizationId: 'org_1' });
    assert.equal(reads[0].role, 'agent');
    assert.equal(reads[0].maxRows, 200);
});

test('a refusal of a data input is the step failure, and the code never runs', async () => {
    let ran = false;
    const fake = () => ({ isAvailable: () => true, runCode: async () => { ran = true; return { result: 1, logs: [] }; } });
    const readData = async () => { const e = new Error('Your role may not read this table.'); e.safe = true; e.code = 'forbidden'; throw e; };
    const res = await runCodeStep(APP, MODEL, { kind: 'code', code: 'return 1', inputs: { rows: { kind: 'records', tableId: 'tbl_lines' } } }, viewerCtx(), { sandbox: fake, readData });
    assert.deepEqual(res, { ok: false, error: 'Your role may not read this table.', code: 'forbidden', retryable: false });
    assert.equal(ran, false);
    assert.ok(new BindingRefusal('x') instanceof Error);
});

test('the sandbox gets no outward bridge, the slot of the organisation and the step\'s time limit', async () => {
    let seen = null;
    const fake = () => ({ isAvailable: () => true, runCode: async (opts) => { seen = opts; return { result: 'ok', logs: [] }; } });
    const res = await runCodeStep(APP, MODEL, { kind: 'code', code: 'function main() { return 1; }', timeoutMs: 20000 }, viewerCtx(), { sandbox: fake });
    assert.equal(res.ok, true);
    assert.deepEqual(seen.bridges, {});
    assert.equal(seen.mode, 'live');
    assert.equal(seen.concurrencyKey, 'org_1');
    assert.deepEqual(seen.limits, { wallMs: 20000, cpuMs: 10000 });
});

test('code that names ctx.http, ctx.integrations or ctx.db is refused before it runs', async () => {
    const fake = () => ({ isAvailable: () => true, runCode: async () => assert.fail('must not run') });
    for (const code of [
        'async function main() { return ctx.http("https://example.com"); }',
        'async function main(inputs, ctx) { return ctx.integrations.gmail_send({}); }',
        'async function main(inputs, ctx) { return ctx.db.query("select 1"); }',
    ]) {
        const res = await runCodeStep(APP, MODEL, { kind: 'code', code }, viewerCtx(), { sandbox: fake });
        assert.equal(res.ok, false, code);
        assert.equal(res.code, 'code_refused', code);
        assert.match(res.error, /no network, integrations or database/);
    }
});

test('a bridge reached by a route the checker cannot see still has nothing behind it', live, async () => {
    // The checker folds this name and refuses it (first assertion). Behind the checker, the
    // sandbox with the bridges the executor passes ({}, asserted above) answers an error and has no db.
    const code = 'async function main(inputs, ctx) {\n  const name = ["ht", "tp"].join("");\n  const r = await ctx[name]("https://example.com");\n  const t = await ctx.integrations.gmail_send({});\n  return { r, t, db: typeof ctx.db };\n}';
    const refused = await runCodeStep(APP, MODEL, { kind: 'code', code }, viewerCtx());
    assert.equal(refused.code, 'code_refused');
    const { result } = await sandbox.runCode({ code, inputs: {}, bridges: {}, mode: 'live' });
    assert.deepEqual(result, { r: { error: 'no http bridge' }, t: { error: 'no executeTool bridge' }, db: 'undefined' });
});

test('a syntax error is refused with its line, and the sandbox is never started', async () => {
    const fake = () => ({ isAvailable: () => true, runCode: async () => assert.fail('must not run') });
    const res = await runCodeStep(APP, MODEL, { kind: 'code', code: 'function main( {' }, viewerCtx(), { sandbox: fake });
    assert.equal(res.code, 'code_refused');
    assert.match(res.error, /syntax error at line 1/);
});

test('no sandbox on this server: code_unavailable, not retried', async () => {
    const fake = () => ({ isAvailable: () => false, runCode: async () => assert.fail('must not run') });
    const res = await runCodeStep(APP, MODEL, { kind: 'code', code: 'return 1' }, viewerCtx(), { sandbox: fake });
    assert.deepEqual(res, { ok: false, error: 'This server has no code sandbox (isolated-vm is not installed), so a code step cannot run here.', code: 'code_unavailable', retryable: false });
});

test('a run past its time limit stops with code_timeout', live, async () => {
    const res = await runCodeStep(APP, MODEL, { kind: 'code', code: 'function main() { for (;;) {} }', timeoutMs: 200 }, viewerCtx());
    assert.equal(res.ok, false);
    assert.equal(res.code, 'code_timeout');
});

test('a thrown error in the code is code_failed with the author\'s message', live, async () => {
    const res = await runCodeStep(APP, MODEL, { kind: 'code', code: 'function main() { throw new Error("no lines"); }' }, viewerCtx());
    assert.equal(res.code, 'code_failed');
    assert.match(res.error, /no lines/);
});

test('ctx.log lines come back as notes on the owner\'s run only', live, async () => {
    const step = { kind: 'code', code: 'function main(inputs, ctx) { ctx.log("seen", inputs.n); return inputs.n * 2; }', inputs: { n: { kind: 'static', value: 4 } } };
    const owner = await runCodeStep(APP, MODEL, step, ownerCtx());
    assert.deepEqual(owner, { ok: true, result: 8, notes: ['log: seen 4'] });
    const viewer = await runCodeStep(APP, MODEL, step, viewerCtx());
    assert.deepEqual(viewer, { ok: true, result: 8 });
});

test('an input name the code cannot read, and inputs past the size cap, are refused', async () => {
    const fake = () => ({ isAvailable: () => true, runCode: async () => assert.fail('must not run') });
    const bad = await runCodeStep(APP, MODEL, { kind: 'code', code: 'return 1', inputs: { '1st': { kind: 'static', value: 1 } } }, viewerCtx(), { sandbox: fake });
    assert.equal(bad.code, 'bad_input');
    const big = await runCodeStep(APP, MODEL, { kind: 'code', code: 'return 1', inputs: { s: { kind: 'static', value: 'x'.repeat(3000) } } }, viewerCtx(), { sandbox: fake, env: { STUDIO_APP_CODE_INPUT_KB: '2' } });
    assert.equal(big.code, 'code_input_too_large');
    const long = await runCodeStep(APP, MODEL, { kind: 'code', code: `return 1;${' '.repeat(20000)}` }, ownerCtx(), { sandbox: fake });
    assert.equal(long.code, 'bad_input');
    assert.match(long.error, /at most|the most a code step holds is 20000/);
    const many = await runCodeStep(APP, MODEL, { kind: 'code', code: 'return 1', inputs: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`a${i}`, 1])) }, ownerCtx(), { sandbox: fake });
    assert.equal(many.code, 'bad_input');
});

test('limits, the input cap and the sandbox errors read the way the header says', () => {
    assert.deepEqual(limitsOf({}), {});
    assert.deepEqual(limitsOf({ timeoutMs: 800 }), { wallMs: 800, cpuMs: 800 });
    assert.equal(inputByteCap({}), DEFAULT_INPUT_KB * 1024);
    assert.equal(inputByteCap({ STUDIO_APP_CODE_INPUT_KB: '0' }), Infinity);
    assert.equal(inputByteCap({ STUDIO_APP_CODE_INPUT_KB: 'lots' }), DEFAULT_INPUT_KB * 1024);
    assert.equal(inputByteCap({ STUDIO_APP_CODE_INPUT_KB: '16' }), 16 * 1024);
    assert.deepEqual(sandboxFailure(new Error('Code steps are busy on this server right now. Try again in a moment.')).retryable, true);
    assert.equal(sandboxFailure(new Error('Code step disabled: x')).code, 'code_unavailable');
    assert.equal(sandboxFailure(new Error('Code step exceeded CPU limit (1000ms)')).code, 'code_timeout');
});

test('the dispatcher sends a code step to this executor', live, async () => {
    const res = await executeDataStep(APP, MODEL, { kind: 'code', code: 'function main(inputs) { return inputs.a + 1; }', inputs: { a: { kind: 'static', value: 41 } } }, viewerCtx());
    assert.deepEqual(res, { ok: true, result: 42 });
    assert.equal(typeof runStep, 'function');
});

test('every execution form runs it: a click and a public page post it, a job, the mailbox hook and app_run_action run it, a dry run for real', async () => {
    const { stepPolicy, STEP_POLICY_LISTS } = require('../../componentSpecs/stepRegistry');
    assert.equal(stepPolicy('code', 'click'), 'step');
    assert.equal(stepPolicy('code', 'public'), 'step');
    assert.ok(!STEP_POLICY_LISTS.backgroundRefusedKinds.includes('code'));
    assert.ok(STEP_POLICY_LISTS.hookStepKinds.includes('code'));
    assert.ok(STEP_POLICY_LISTS.mcpLiveKinds.includes('code'));
    assert.ok(STEP_POLICY_LISTS.mcpDryRunKinds.includes('code') && !STEP_POLICY_LISTS.mcpMockableKinds.includes('code'));
    assert.ok(STEP_POLICY_LISTS.heavyStepKinds.includes('code') && !STEP_POLICY_LISTS.aiStepKinds.includes('code'));
    const { decideStep } = await import('../../mcpRunActionPolicy.mts');
    const step = { kind: 'code', code: 'return 1' };
    assert.deepEqual(decideStep(step, true, false), { run: true, step });
});
