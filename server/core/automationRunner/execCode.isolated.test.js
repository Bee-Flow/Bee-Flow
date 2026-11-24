// @typecheck
/**
 * A code step marked `isolated` (a Cowork plan's script: core/cowork/plan/planRunCopy.mts) runs through the sandbox's
 * out-of-process runner, never through the in-process one, and gets no bridges. The sandbox port is handed in.
 *
 * Run: node --test core/automationRunner/execCode.isolated.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { registerRunnerPorts } = require('./featurePorts');
const { execCode } = require('./execCode');

/** @type {any[]} */
const isolated = [];
let inProcess = 0;
registerRunnerPorts({
    codeSandbox: {
        isAvailable: () => true,
        loadError: () => null,
        secretsNotConfiguredMessage: () => 'secrets are not configured',
        defaultFetchHttp: async () => ({}),
        runCode: async () => { inProcess += 1; return { result: 'in process', logs: [], http: { calls: 0 }, calls: null }; },
        runCodeIsolated: async (/** @type {any} */ job) => { isolated.push(job); return { result: { total: 3 }, logs: ['ok'] }; },
    },
});

test('an isolated code step runs out of process with only its code, inputs and limits; a plain one stays in process', async () => {
    const ctx = { userId: 'u1', orgId: 'o1' };
    const state = { steps: {}, trigger: { output: {} } };
    const out = /** @type {any} */ (await execCode({ id: 'c1', type: 'code', code: 'return 1 + 2', inputs: {}, isolated: true }, ctx, state, 'live'));
    assert.deepStrictEqual(out.output.result, { total: 3 });
    assert.strictEqual(isolated.length, 1);
    assert.deepStrictEqual(Object.keys(isolated[0]).sort(), ['code', 'concurrencyKey', 'inputs', 'limits', 'mode'], 'no bridges go along, only the org its slot counts against');
    assert.strictEqual(inProcess, 0);
    await execCode({ id: 'c2', type: 'code', code: 'return 1', inputs: {} }, ctx, state, 'live');
    assert.strictEqual(inProcess, 1);
});
