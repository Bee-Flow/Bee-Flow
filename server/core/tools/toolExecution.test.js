// @typecheck
/**
 * executeComponentTool's subworkflow branch (core/tools/toolExecution.js).
 *
 * workflowStore.getWorkflowById is async. Without the await the branch got a
 * Promise: never "not found", and JSON-cloning it gave `{}`, so `.nodes.find`
 * threw and the agent saw a TypeError instead of the workflow's result.
 *
 * Run: cd server && node --test core/tools/toolExecution.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { preloadStubs } = require('../../testUtils/stubRequire');

const executed = [];
const workflows = {
    wf1: { id: 'wf1', owner_id: 'alice', nodes: [{ id: 'n1', type: 'trigger-subworkflow', data: {} }] },
};
const USERS = { alice: { id: 'alice', organizationId: 'org-a' }, bob: { id: 'bob', organizationId: 'org-a' }, mallory: { id: 'mallory', organizationId: 'org-b' } };

const MOCKS = {
    '../cms/componentManager': { getComponents: () => [] },
    '../executionEngine': { executeWorkflow: async (wf) => { executed.push(wf); return { ok: true }; } },
    '../../stores/workflowStore': { getWorkflowById: async (id) => workflows[id] || null },
    '../../stores/userStore': { getUser: async (id) => USERS[id] || null },
};

preloadStubs(require, MOCKS);

const { executeComponentTool } = require('./toolExecution');

test('a subworkflow tool runs the stored workflow with the arguments on its trigger', async () => {
    const out = await executeComponentTool('subworkflow_wf1', { q: 'x' }, { userId: 'alice' });
    assert.deepStrictEqual(out, { success: true, result: { ok: true } });
    assert.strictEqual(executed.length, 1);
    assert.deepStrictEqual(executed[0].nodes[0].data.inputValues.inputData, { q: 'x' });
});

test('an unknown subworkflow answers "not found"', async () => {
    const out = await executeComponentTool('subworkflow_nope', {});
    assert.deepStrictEqual(out, { error: "Subworkflow 'nope' not found" });
});

test('a subworkflow runs for its owner and the owner\'s organisation only', async () => {
    executed.length = 0;
    assert.deepStrictEqual(await executeComponentTool('subworkflow_wf1', {}, { askerUserId: 'bob' }), { success: true, result: { ok: true } });
    assert.deepStrictEqual(await executeComponentTool('subworkflow_wf1', {}, { askerUserId: 'mallory' }), { error: "Subworkflow 'wf1' not found" });
    assert.deepStrictEqual(await executeComponentTool('subworkflow_wf1', {}), { error: "Subworkflow 'wf1' not found" }, 'no caller, no run');
    assert.strictEqual(executed.length, 1);
});
