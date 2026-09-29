/**
 * Route tests for the `startNow` flag on POST /api/ai-tasks — the Work
 * composer's "Run now".
 *
 * The behaviour that needs pinning down is the double-run hazard: a fresh row
 * is inserted active with next_run_at = now, so if we fire it manually AND
 * leave it on the scheduler, getDueTasks() picks the same row up on the next
 * 60s tick and the user gets the same result twice. A one-off is therefore
 * deactivated before it fires; a repeating one keeps its (already advanced)
 * schedule.
 *
 * Stores, auth and the runner are mocked via the Module._resolveFilename
 * harness (same pattern as routes/notebooks.list.test.js) so no DB is touched.
 *
 * Run: node --test routes/aiTasks.startNow.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const Module = require('module');

// ── Fixtures ────────────────────────────────────────────────────────

const state = {
    created: [],       // createTask() args
    updates: [],       // updateTask(id, patch) calls
    executed: [],      // executeTask(task, opts) calls
    count: 0,
};

function reset() {
    state.created = [];
    state.updates = [];
    state.executed = [];
    state.count = 0;
}

const mockAiTaskStore = {
    async getTasks() { return []; },
    async getTaskCount() { return state.count; },
    async createTask(args) {
        state.created.push(args);
        return {
            id: 'task-1',
            userId: args.userId,
            title: args.title,
            prompt: args.prompt,
            repeatInterval: args.repeatInterval,
            nextRunAt: args.nextRunAt,
            modelTier: args.modelTier,
            isActive: true,
        };
    },
    async updateTask(id, patch) { state.updates.push({ id, patch }); return true; },
    async getTask(id) { return { id, userId: 'u1', isActive: true, lastStatus: 'success' }; },
    async deleteTask() { return true; },
};

// ── Peripheral mocks (module-level requires of routes/aiTasks.js) ───

const MOCKS = {
    '../stores/aiTaskStore': mockAiTaskStore,
    '../stores/agentStore': { async getAgent(id) { return { id, owner_id: 'u1', name: 'A' }; } },
    '../stores/configStore': { async getConfig() { return null; } },
    '../core/aiTaskRunner': {
        async executeTask(task, opts) { state.executed.push({ id: task.id, isActive: task.isActive, opts }); },
    },
    '../core/entitlements/betaFeatures': { async userHasBetaFeature() { return true; } },
    '../auth/permissions': {
        requireAuth: (req, res, next) => {
            if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
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
const router = require('./aiTasks');

// ── HTTP harness ────────────────────────────────────────────────────

let server;
let baseUrl;

test.before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        const uid = req.headers['x-test-user'];
        if (uid) req.session = { isAuthenticated: true, user: { id: uid } };
        next();
    });
    app.use('/api/ai-tasks', router);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/api/ai-tasks`;
});

test.after(async () => {
    await new Promise((resolve) => server.close(resolve));
});

async function post(body, { user = 'u1' } = {}) {
    const res = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'x-test-user': user, 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
}

// setImmediate work is scheduled after the response is sent.
const flush = () => new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

const BASE = { title: 'Weekly digest', prompt: 'Summarise the week', nextRunAt: new Date().toISOString() };

// ── Tests ───────────────────────────────────────────────────────────

test('without startNow the task is only scheduled — nothing runs', async () => {
    reset();
    const r = await post(BASE);
    assert.strictEqual(r.status, 200);
    await flush();
    assert.deepStrictEqual(state.executed, []);
    assert.deepStrictEqual(state.updates, []);
});

test('startNow on a one-off deactivates the row before firing it', async () => {
    reset();
    const r = await post({ ...BASE, startNow: true });
    assert.strictEqual(r.status, 200);
    await flush();
    // Taken off the scheduler first, so processDueTasks() can't run it again.
    assert.deepStrictEqual(state.updates, [{ id: 'task-1', patch: { isActive: false } }]);
    assert.strictEqual(state.executed.length, 1);
    assert.strictEqual(state.executed[0].id, 'task-1');
    assert.strictEqual(state.executed[0].isActive, false);
    // manual:true leaves next_run_at alone.
    assert.strictEqual(state.executed[0].opts.manual, true);
});

test('startNow on a repeating task keeps it active and keeps its schedule', async () => {
    reset();
    const r = await post({ ...BASE, repeatInterval: 'weekly', startNow: true });
    assert.strictEqual(r.status, 200);
    await flush();
    assert.deepStrictEqual(state.updates, []);
    assert.strictEqual(state.executed.length, 1);
    assert.strictEqual(state.executed[0].opts.manual, true);
});

test('startNow only fires for a literal true — not a truthy string', async () => {
    reset();
    await post({ ...BASE, startNow: 'yes' });
    await flush();
    assert.deepStrictEqual(state.executed, []);
});

test('a failing first run does not fail the create', async () => {
    reset();
    const runner = require.cache['mock:../core/aiTaskRunner'].exports;
    const original = runner.executeTask;
    runner.executeTask = async () => { throw new Error('provider down'); };
    try {
        const r = await post({ ...BASE, startNow: true });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.json.id, 'task-1');
        await flush();
    } finally {
        runner.executeTask = original;
    }
});

test('validation still runs before anything is started', async () => {
    reset();
    const r = await post({ prompt: 'no title', nextRunAt: new Date().toISOString(), startNow: true });
    assert.strictEqual(r.status, 400);
    await flush();
    assert.deepStrictEqual(state.created, []);
    assert.deepStrictEqual(state.executed, []);
});

test('the task limit is enforced before a startNow run', async () => {
    reset();
    state.count = 10;
    const r = await post({ ...BASE, startNow: true });
    assert.strictEqual(r.status, 400);
    await flush();
    assert.deepStrictEqual(state.executed, []);
});
