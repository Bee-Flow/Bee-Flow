/**
 * What the workflow execution routes accept, and what they say when they
 * refuse (routes/execute.js).
 *
 * Each top-level key changes what runs or what is recorded, and each was
 * dropped when misspelled:
 *
 *   - `workflowID` ran the graph with NO execution record (executionId: null);
 *   - `input` instead of `inputData` ran the subworkflow on `{}`, 200 success;
 *   - a test run's `inputs` given as text was spread into `{ 0: 'h', 1: 'i' }`
 *     and handed to the component as its input values;
 *   - a graph without `edges` died on a TypeError — a 500 — after its
 *     execution record had been written.
 *
 * What this file pins:
 *
 *   - the 400 NAMES the field, in a sentence;
 *   - a refused request runs nothing and records nothing;
 *   - the Component Studio's test body still runs.
 *
 * Run: cd server && node --test routes/execute.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every engine run and store write lands in `touched`. A refused request must leave it empty.
const touched = [];
const TRIGGERED = { id: 'wf-trig', name: 'Sub', nodes: [{ id: 'n1', type: 'trigger-subworkflow', data: {} }], edges: [] };

const MOCKS = {
    '../core/executionEngine': {
        executeWorkflow: async (workflow) => { touched.push({ what: 'executeWorkflow', args: [workflow] }); return { 'test-node': { output: 42 } }; },
    },
    '../core/cms/componentManager': { getComponents: () => [{ id: 'known-comp' }] },
    '../utils/routeHelpers': { getUserAuth: async () => ({}) },
    '../auth': { requireAuth: (req, res, next) => next() },
    '../stores/workflowStore': {
        createExecution: async (...a) => { touched.push({ what: 'createExecution', args: a }); return { id: 'exec-1' }; },
        completeExecution: async (...a) => { touched.push({ what: 'completeExecution', args: a }); },
        getWorkflow: async (id) => (id === TRIGGERED.id ? structuredClone(TRIGGERED) : null),
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:execute-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]execute\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./execute');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

function dispatch({ url, body }) {
    return new Promise((resolve, reject) => {
        const req = {
            method: 'POST', url, originalUrl: url, path: url, body, query: {}, headers: {},
            session: { user: { id: 'u1' } }, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: POST ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

const GRAPH = { nodes: [{ id: 'a', type: 'custom', data: {} }], edges: [] };

test.beforeEach(() => { touched.length = 0; });

test('a misspelled workflowId is refused, instead of running the graph with no record', async () => {
    const res = await dispatch({ url: '/execute', body: { workflow: GRAPH, workflowID: 'wf-1' } });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(touched, [], 'nothing ran, nothing was recorded');
});

test('a graph without its edges is refused in words, before a record is written', async () => {
    const res = await dispatch({ url: '/execute', body: { workflow: { nodes: [] }, workflowId: 'wf-1' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'workflow is the graph to run: { nodes: [...], edges: [...] }.');
    assert.ok(res.body.details.some((d) => d.path === 'body.workflow.edges'));
    assert.deepStrictEqual(touched, []);
});

test('a graph still carries whatever else its nodes need, and runs with its record', async () => {
    const res = await dispatch({ url: '/execute', body: { workflow: { ...GRAPH, viewport: { x: 0 } }, workflowId: 'wf-1', workflowName: 'Test' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.executionId, 'exec-1');
    assert.deepStrictEqual(touched.find((t) => t.what === 'executeWorkflow').args[0].viewport, { x: 0 });
});

test('test inputs given as text are refused, instead of being spread character by character', async () => {
    const res = await dispatch({ url: '/test-component', body: { componentId: 'known-comp', inputs: 'hi' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'inputs is an object of input values, like { "input": "hello" }.');
    assert.deepStrictEqual(touched, []);
});

test('the Component Studio\'s test body still runs the component', async () => {
    const res = await dispatch({ url: '/test-component', body: { componentId: 'known-comp', inputs: { input: 'hello' } } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { output: 42 });
    assert.deepStrictEqual(touched[0].args[0].nodes[0].data.inputValues, { input: 'hello' });
});

test('a missing component id is still refused with the message the studio shows', async () => {
    const res = await dispatch({ url: '/test-component', body: { inputs: {} } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'componentId is required');
});

test('a misspelled inputData is refused, instead of running the subworkflow on nothing', async () => {
    const res = await dispatch({ url: '/subworkflow/wf-trig', body: { input: { x: 1 } } });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(touched, []);
});

test('a subworkflow with no body at all still runs, on empty input', async () => {
    const res = await dispatch({ url: '/subworkflow/wf-trig', body: undefined });
    assert.strictEqual(res.statusCode, 200);
    const trigger = touched.find((t) => t.what === 'executeWorkflow').args[0].nodes[0];
    assert.deepStrictEqual(trigger.data.inputValues.inputData, {});
});
