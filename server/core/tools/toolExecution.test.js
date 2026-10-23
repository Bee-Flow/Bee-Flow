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
    wf1: { id: 'wf1', nodes: [{ id: 'n1', type: 'trigger-subworkflow', data: {} }] },
};

const MOCKS = {
    '../cms/componentManager': { getComponents: () => [] },
    '../executionEngine': { executeWorkflow: async (wf) => { executed.push(wf); return { ok: true }; } },
    '../../stores/workflowStore': { getWorkflowById: async (id) => workflows[id] || null },
};

preloadStubs(require, MOCKS);

const { executeComponentTool } = require('./toolExecution');

test('a subworkflow tool runs the stored workflow with the arguments on its trigger', async () => {
    const out = await executeComponentTool('subworkflow_wf1', { q: 'x' });
    assert.deepStrictEqual(out, { success: true, result: { ok: true } });
    assert.strictEqual(executed.length, 1);
    assert.deepStrictEqual(executed[0].nodes[0].data.inputValues.inputData, { q: 'x' });
});

test('an unknown subworkflow answers "not found"', async () => {
    const out = await executeComponentTool('subworkflow_nope', {});
    assert.deepStrictEqual(out, { error: "Subworkflow 'nope' not found" });
});
