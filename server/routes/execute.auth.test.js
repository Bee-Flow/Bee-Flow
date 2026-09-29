/**
 * Auth gates on the workflow execution routes (routes/execute.js).
 *
 * POST /execute, /test-component and /subworkflow/:workflowId were pinned in
 * the U4 sweep as HIGH: anonymous execution of caller-supplied workflow JSON
 * (userId falling back to 'anonymous'). Their only real caller is the
 * signed-in Component Studio; workflow-to-workflow calls run in-process
 * through the execution engine, never over HTTP. All three now carry inline
 * requireAuth and the 'anonymous' fallback is gone. This test pins:
 * anonymous → 401 before anything executes, signed-in → not 401, and the
 * session user (not 'anonymous') reaching the store calls.
 *
 * Engine, stores and auth are mocked via the Module._resolveFilename harness
 * (same pattern as routes/aiTasks.startNow.test.js) so nothing executes for
 * real and no DB is touched.
 *
 * Run: node --test --test-force-exit routes/execute.auth.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const Module = require('module');

// ── Fixtures ────────────────────────────────────────────────────────

const state = {
    executed: [],        // executionEngine.executeWorkflow(workflow, userAuth) calls
    executionsCreated: [], // createExecution args
    completed: [],       // completeExecution args
    getWorkflowCalls: [], // [id, userId]
};

function reset() {
    state.executed = [];
    state.executionsCreated = [];
    state.completed = [];
    state.getWorkflowCalls = [];
}

// One workflow that carries a subworkflow trigger, owned by u1.
const TRIGGERED_WORKFLOW = {
    id: 'wf-trig',
    name: 'Sub',
    nodes: [{ id: 'n1', type: 'trigger-subworkflow', data: {} }],
    edges: [],
};

// ── Mocks (requires of routes/execute.js, incl. the lazy in-handler ones) ──

const MOCKS = {
    '../core/executionEngine': {
        async executeWorkflow(workflow, userAuth) {
            state.executed.push({ workflow, userAuth });
            return { 'test-node': { output: 42 } };
        },
    },
    '../core/cms/componentManager': {
        getComponents() { return [{ id: 'known-comp', name: 'Known' }]; },
    },
    '../utils/routeHelpers': {
        async getUserAuth(req) { return { userId: req.session?.user?.id || null }; },
    },
    '../stores/workflowStore': {
        async createExecution(workflowId, workflowName, userId, triggerType, workflow) {
            state.executionsCreated.push({ workflowId, workflowName, userId, triggerType, hasWorkflow: Boolean(workflow) });
            return { id: 'exec-1', startedAt: new Date().toISOString() };
        },
        async completeExecution(id, status, nodesExecuted) {
            state.completed.push({ id, status, nodesExecuted });
        },
        async getWorkflow(id, userId) {
            state.getWorkflowCalls.push([id, userId]);
            return id === TRIGGERED_WORKFLOW.id ? structuredClone(TRIGGERED_WORKFLOW) : null;
        },
    },
    '../auth': {
        // Mirrors the 401 contract of the real gate (auth/permissions.js:383)
        // minus the cached deleted-user DB round-trip.
        requireAuth: (req, res, next) => {
            if (!req.session || !req.session.isAuthenticated || !req.session.user) {
                return res.status(401).json({ error: 'Not authenticated' });
            }
            next();
        },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) return MOCK_IDS[request];
    return originalResolve.call(this, request, parent, ...rest);
};

const express = require('express');
const router = require('./execute');

// ── HTTP harness ────────────────────────────────────────────────────

let server;
let baseUrl;

test.before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        const uid = req.headers['x-test-user'];
        if (uid) req.session = { isAuthenticated: true, user: { id: uid } };
        next();
    });
    app.use('/', router); // same mount as index.js
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    await new Promise((resolve) => server.close(resolve));
});

async function post(url, { user = null, body = {} } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (user) headers['x-test-user'] = user;
    const res = await fetch(`${baseUrl}${url}`, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => null) };
}

const WORKFLOW_BODY = { workflow: { nodes: [], edges: [] }, workflowId: 'wf-1', workflowName: 'Test' };

// ── POST /execute ───────────────────────────────────────────────────

test('execute: anonymous → 401 and the engine never runs', async () => {
    reset();
    const r = await post('/execute', { body: WORKFLOW_BODY });
    assert.strictEqual(r.status, 401);
    assert.deepStrictEqual(state.executed, [], 'anonymous request must not reach the execution engine');
    assert.deepStrictEqual(state.executionsCreated, []);
});

test('execute: signed-in → 200, records the run under the session user (no anonymous fallback)', async () => {
    reset();
    const r = await post('/execute', { user: 'u1', body: WORKFLOW_BODY });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.success, true);
    assert.strictEqual(r.json.executionId, 'exec-1');
    assert.strictEqual(state.executed.length, 1);
    assert.strictEqual(state.executionsCreated[0].userId, 'u1');
    assert.deepStrictEqual(state.completed, [{ id: 'exec-1', status: 'success', nodesExecuted: 1 }]);
});

// ── POST /test-component ────────────────────────────────────────────

test('test-component: anonymous → 401 and the engine never runs', async () => {
    reset();
    const r = await post('/test-component', { body: { componentId: 'known-comp' } });
    assert.strictEqual(r.status, 401);
    assert.deepStrictEqual(state.executed, []);
});

test('test-component: signed-in → 200 with the component result', async () => {
    reset();
    const r = await post('/test-component', { user: 'u1', body: { componentId: 'known-comp' } });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json, { output: 42 });
    assert.strictEqual(state.executed.length, 1);
});

// ── POST /subworkflow/:workflowId ───────────────────────────────────

test('subworkflow: anonymous → 401 and the store is never consulted', async () => {
    reset();
    const r = await post('/subworkflow/wf-trig', { body: { inputData: {} } });
    assert.strictEqual(r.status, 401);
    assert.deepStrictEqual(state.getWorkflowCalls, []);
    assert.deepStrictEqual(state.executed, []);
});

test('subworkflow: signed-in → workflow resolved as the session user; unknown id → 404, not 401', async () => {
    reset();
    const r = await post('/subworkflow/wf-unknown', { user: 'u1', body: { inputData: {} } });
    assert.strictEqual(r.status, 404);
    assert.deepStrictEqual(state.getWorkflowCalls, [['wf-unknown', 'u1']],
        'getWorkflow must be scoped by the session user, never by an anonymous fallback');
});

test('subworkflow: signed-in on a triggered workflow → 200, executed and recorded under the session user', async () => {
    reset();
    const r = await post('/subworkflow/wf-trig', { user: 'u1', body: { inputData: { x: 1 } } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.success, true);
    assert.strictEqual(r.json.executionId, 'exec-1');
    assert.deepStrictEqual(state.getWorkflowCalls, [['wf-trig', 'u1']]);
    assert.strictEqual(state.executionsCreated[0].userId, 'u1');
    assert.strictEqual(state.executionsCreated[0].triggerType, 'subworkflow');
    // The trigger node got the input data injected before execution.
    const executedTrigger = state.executed[0].workflow.nodes[0];
    assert.deepStrictEqual(executedTrigger.data.inputValues.inputData, { x: 1 });
    assert.deepStrictEqual(state.completed, [{ id: 'exec-1', status: 'success', nodesExecuted: 1 }]);
});
