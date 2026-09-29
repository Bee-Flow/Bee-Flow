/**
 * Auth gates on the agent-chat playground routes (routes/ai/agentChat.js).
 *
 * These four routes were pinned in the U4 sweep as reachable without auth
 * while their /chat and /chat-stream siblings carried inline requireAuth.
 * They back the signed-in Component Studio only (the guest chat surface has
 * its own deliberately open catalog under /agents — routes/agents/meta.js),
 * so every route in this file now requires a session user. This test pins:
 * anonymous → 401 before any side effect, signed-in → not 401.
 *
 * Auth, the agent runtime and the component manager are mocked via the
 * Module._resolveFilename harness (same pattern as routes/aiTasks.startNow.test.js)
 * so no agent is created and nothing touches disk.
 *
 * Run: node --test --test-force-exit routes/ai/agentChat.auth.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('module');

// ── Fixtures ────────────────────────────────────────────────────────

const state = {
    agentsCreated: [],   // getOrCreateAgent(sessionId) calls
    cleared: [],         // clearConversation(sessionId) calls
    initialized: 0,      // componentManager.initialize() calls
    capabilities: new Set(),  // what requireCapability's mock grants this call
};

// Must not exist before or after any test — proves create-component never
// reaches the fs.writeFile calls for an anonymous caller.
const TEST_COMPONENT_ID = 'zz-agentchat-auth-test';
const TEST_COMPONENT_DIR = path.resolve(__dirname, '../../../components', TEST_COMPONENT_ID);

// ── Mocks (module-level requires of routes/ai/agentChat.js) ─────────

const MOCKS = {
    '../../core/cms/componentDesignerAgent': {
        getOrCreateAgent(sessionId) {
            state.agentsCreated.push(sessionId);
            return {
                async chat() { return { text: 'ok' }; },
                getHistory() { return [{ role: 'user', content: 'hi' }]; },
                getToolCalls() { return []; },
            };
        },
        clearConversation(sessionId) { state.cleared.push(sessionId); },
    },
    '../../core/agentRuntime': {
        async getAvailableComponents() {
            return [{ name: 'Tavily Search', description: 'Web search', category: 'API' }];
        },
    },
    '../../core/cms/componentManager': {
        async initialize() { state.initialized++; },
    },
    '../../core/entitlements/limits': {
        async checkSubscriptionLimits() { return null; },
    },
    '../../auth': {
        // Mirrors the 401 contract of the real gate (auth/permissions.js:383)
        // minus the cached deleted-user DB round-trip.
        requireAuth: (req, res, next) => {
            if (!req.session || !req.session.isAuthenticated || !req.session.user) {
                return res.status(401).json({ error: 'Not authenticated' });
            }
            next();
        },
        async resolvePrimaryOrgId() { return null; },
    },
    '../../core/entitlements/entitlements': {
        // Mirrors the shape of the real factory: a middleware that defers an
        // anonymous caller to the auth gate in front of it, and otherwise
        // answers 403 feature_disabled when the capability is absent
        // (entitlements.js:634). `state.capabilities` is what the test drives.
        requireCapability: (capId) => function capabilityGate(req, res, next) {
            if (!req.session?.isAuthenticated) return next(); // auth middleware rejects
            if (state.capabilities.has(capId)) return next();
            return res.status(403).json({ error: 'feature_disabled', feature: capId });
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
const router = require('./agentChat');
// A schema refusal travels as an error to the terminal handler, so the app
// here has to end the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

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
    app.use('/ai', router); // same mount as index.js
    app.use(terminalErrorHandler);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    // Safety net: if a gate ever regresses, don't leave the fixture component
    // behind in the real components/ tree.
    fs.rmSync(TEST_COMPONENT_DIR, { recursive: true, force: true });
});

async function call(method, url, { user = null, body = null } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (user) headers['x-test-user'] = user;
    const res = await fetch(`${baseUrl}${url}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => null) };
}

const VALID_COMPONENT = {
    component: {
        id: TEST_COMPONENT_ID,
        name: 'Auth test component',
        code: 'module.exports = async () => ({});',
    },
};

// ── POST /ai/create-component ───────────────────────────────────────

test('create-component: anonymous → 401, and nothing is written to disk', async () => {
    const r = await call('POST', '/ai/create-component', { body: VALID_COMPONENT });
    assert.strictEqual(r.status, 401);
    assert.ok(!fs.existsSync(TEST_COMPONENT_DIR), 'anonymous call must not create the component directory');
    assert.strictEqual(state.initialized, 0, 'anonymous call must not re-initialize the component manager');
});

// Authentication was never the whole gate on this route. /components is
// wrapped in requireCapability('component_designer') at index.js, but this
// route is mounted under /ai and carried only requireAuth — so any signed-in
// user could write executable component code through it, and componentManager
// then runs `npm install` in that directory while executionEngine spawns
// index.js with the server's env. The capability is the boundary, not a
// paywall, so it is pinned in both directions here.
test('create-component: signed-in WITHOUT component_designer → 403, and nothing is written to disk', async () => {
    state.capabilities = new Set();
    state.initialized = 0;
    const r = await call('POST', '/ai/create-component', { user: 'u1', body: VALID_COMPONENT });
    assert.strictEqual(r.status, 403, 'a signed-in user with no capability must not reach the writer');
    assert.strictEqual(r.json.feature, 'component_designer');
    assert.ok(!fs.existsSync(TEST_COMPONENT_DIR), 'ungated caller must not create the component directory');
    assert.strictEqual(state.initialized, 0, 'ungated caller must not re-initialize the component manager');
});

test('create-component: signed-in WITH component_designer passes both gates (invalid body → 400)', async () => {
    state.capabilities = new Set(['component_designer']);
    const r = await call('POST', '/ai/create-component', { user: 'u1', body: { component: { id: 'x' } } });
    assert.strictEqual(r.status, 400, 'an entitled caller must still reach the route');
    assert.match(r.json.error, /Invalid component data/);
});

test('create-component: the capability gate runs AFTER requireAuth, so anonymous is still 401', async () => {
    // requireCapability opens with `if (!req.session?.isAuthenticated) return next()`
    // — it defers anonymous callers to "the auth middleware". Put it in front of
    // requireAuth and the route silently opens to the world, which is the exact
    // pair routes/components.js had to be given.
    state.capabilities = new Set(['component_designer']);
    const r = await call('POST', '/ai/create-component', { body: VALID_COMPONENT });
    assert.strictEqual(r.status, 401);
    assert.ok(!fs.existsSync(TEST_COMPONENT_DIR));
});

// ── GET /ai/tools ───────────────────────────────────────────────────

test('tools: anonymous → 401 (catalog is not public here — the guest catalog lives under /agents)', async () => {
    const r = await call('GET', '/ai/tools');
    assert.strictEqual(r.status, 401);
});

test('tools: signed-in → 200 with the component catalog', async () => {
    const r = await call('GET', '/ai/tools', { user: 'u1' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.tools.length, 1);
    assert.strictEqual(r.json.researchTools.length, 1);
});

// ── GET /ai/history ─────────────────────────────────────────────────

test('history: anonymous → 401 and no agent instance is allocated', async () => {
    state.agentsCreated = [];
    const r = await call('GET', '/ai/history');
    assert.strictEqual(r.status, 401);
    assert.deepStrictEqual(state.agentsCreated, [], 'anonymous probe must not allocate an agent via getOrCreateAgent');
});

test('history: signed-in → 200 with own session history', async () => {
    const r = await call('GET', '/ai/history', { user: 'u1' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.history.length, 1);
    assert.deepStrictEqual(r.json.toolCalls, []);
});

// ── POST /ai/clear ──────────────────────────────────────────────────

test('clear: anonymous → 401 and nothing is cleared', async () => {
    state.cleared = [];
    const r = await call('POST', '/ai/clear');
    assert.strictEqual(r.status, 401);
    assert.deepStrictEqual(state.cleared, []);
});

test('clear: signed-in → 200 and clears the own session conversation', async () => {
    state.cleared = [];
    const r = await call('POST', '/ai/clear', { user: 'u1' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.success, true);
    assert.strictEqual(state.cleared.length, 1);
});
