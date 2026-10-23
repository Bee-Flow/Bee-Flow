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
const Module = require('module');

const executed = [];
const workflows = {
    wf1: { id: 'wf1', nodes: [{ id: 'n1', type: 'trigger-subworkflow', data: {} }] },
};

const MOCKS = {
    '../cms/componentManager': { getComponents: () => [] },
    '../executionEngine': { executeWorkflow: async (wf) => { executed.push(wf); return { ok: true }; } },
    '../../stores/workflowStore': { getWorkflowById: async (id) => workflows[id] || null },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:toolExecution:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /core[\\/]tools[\\/]toolExecution\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const { executeComponentTool } = require('./toolExecution');
test.after(() => { Module._resolveFilename = originalResolve; });

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
