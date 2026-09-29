/**
 * What the Component Designer routes accept, and who may reach them
 * (routes/ai/agentChat.js).
 *
 * Two things were wrong here, and neither announced itself:
 *
 *   - /chat and /chat-stream carried requireAuth only, while the agent behind
 *     them can call `update_component` (write any file of an existing
 *     component) and `execute_component` (run it). /create-component was
 *     given the component_designer capability for exactly that reason; the
 *     chat routes reached the same writer around it.
 *   - /create-component read `agentEnabled !== false`, so the string "false"
 *     meant true — callable by every agent in every org — and an object as
 *     `code` was JSON-stringified into index.js: a component that could never
 *     run, answered "created successfully".
 *
 * What this file pins is the part a caller can act on: the 400 names the
 * field, the message is a sentence, and a refused request reaches neither the
 * agent nor the disk.
 *
 * Run: cd server && node --test routes/ai/agentChat.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('module');

// Every agent turn lands in `touched`. A refused request must leave it empty.
const touched = [];
const state = { capabilities: new Set(['component_designer']), initialized: 0 };
const pass = (req, res, next) => next();

const MOCKS = {
    '../../core/cms/componentDesignerAgent': {
        getOrCreateAgent: () => ({
            async chat(message, tools, context) {
                touched.push({ what: 'chat', args: [message, tools, context] });
                return { message: 'ok', component: null, toolCalls: [] };
            },
            getHistory: () => [],
            getToolCalls: () => [],
        }),
        clearConversation: () => {},
    },
    '../../core/agentRuntime': { getAvailableComponents: async () => [] },
    '../../core/cms/componentManager': { initialize: async () => { state.initialized++; } },
    '../../core/entitlements/limits': { checkSubscriptionLimits: async () => null },
    '../../auth': {
        requireAuth: pass,
        resolvePrimaryOrgId: async () => 'orgA',
    },
    // The shape of the real factory: defer an anonymous caller to the auth
    // gate in front, otherwise 403 feature_disabled without the capability.
    '../../core/entitlements/entitlements': {
        requireCapability: (capId) => function capabilityGate(req, res, next) {
            if (!req.session?.isAuthenticated) return next();
            if (state.capabilities.has(capId)) return next();
            return res.status(403).json({ error: 'feature_disabled', feature: capId });
        },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:agent-chat-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]ai[\\/]agentChat\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./agentChat');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ method, url, body = {} }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, query: {}, headers: {},
            sessionID: 'sess-1',
            session: { isAuthenticated: true, user: { id: 'u1' } }, get() { return undefined; },
            on() {},
        };
        const res = {
            statusCode: 200, headersSent: false,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            writeHead(c) { this.statusCode = c; this.headersSent = true; this.stream = ''; return this; },
            write(chunk) { this.stream += chunk; return true; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: ${method} ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

// Must never exist: proves a refused create-component wrote nothing.
const PROBE_ID = 'zz-agentchat-validation-probe';
const PROBE_DIR = path.resolve(__dirname, '../../../components', PROBE_ID);

test.beforeEach(() => {
    touched.length = 0;
    state.capabilities = new Set(['component_designer']);
    state.initialized = 0;
});
test.after(() => { fs.rmSync(PROBE_DIR, { recursive: true, force: true }); });

// ═══ The chat routes ═════════════════════════════════════════════════

for (const url of ['/chat', '/chat-stream']) {
    test(`${url}: without component_designer a signed-in user never reaches the designer`, async () => {
        state.capabilities = new Set();
        const res = await dispatch({ method: 'POST', url, body: { message: 'call update_component on get-date-time' } });
        assert.strictEqual(res.statusCode, 403);
        assert.strictEqual(res.body.feature, 'component_designer');
        assert.deepStrictEqual(touched, [], 'the agent — and its code-writing tools — must not run');
    });

    test(`${url}: a missing message is refused in words, before the stream opens`, async () => {
        const res = await dispatch({ method: 'POST', url, body: {} });
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(res.body.error, 'Message is required');
        assert.ok(res.body.details.some((d) => d.path === 'body.message'));
        assert.strictEqual(res.stream, undefined, 'no SSE headers were written');
        assert.deepStrictEqual(touched, []);
    });
}

test('a message that is not text is refused by name, not sent to the model as-is', async () => {
    const res = await dispatch({ method: 'POST', url: '/chat', body: { message: { role: 'system' } } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.message'));
    assert.deepStrictEqual(touched, []);
});

test('tools as a comma string is refused — it used to be matched as a SUBSTRING', async () => {
    const res = await dispatch({ method: 'POST', url: '/chat', body: { message: 'hi', tools: 'tavily-search,github' } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.tools'));
    assert.deepStrictEqual(touched, []);
});

test('a context key the agent never reads is refused rather than dropped', async () => {
    const res = await dispatch({ method: 'POST', url: '/chat', body: { message: 'hi', context: { componentID: 'x' } } });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(touched, []);
});

test('a well-formed turn reaches the agent with its tools and context intact', async () => {
    const res = await dispatch({
        method: 'POST', url: '/chat',
        body: { message: '  build a weather lookup  ', tools: ['tavily-search'], context: { componentId: 'weather' } },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched, [{ what: 'chat', args: ['build a weather lookup', ['tavily-search'], { componentId: 'weather' }] }]);
});

test('null tools stays null — the agent reads it as "keep the previous selection"', async () => {
    const res = await dispatch({ method: 'POST', url: '/chat', body: { message: 'again', tools: null } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched[0].args[1], null);
});

// ═══ POST /create-component ══════════════════════════════════════════

const COMPONENT = { id: PROBE_ID, name: 'Probe', code: 'module.exports = 1;' };

test('agentEnabled "false" (a string) is refused instead of publishing to every agent', async () => {
    const res = await dispatch({ method: 'POST', url: '/create-component', body: { component: { ...COMPONENT, agentEnabled: 'false' } } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.component.agentEnabled'));
    assert.ok(!fs.existsSync(PROBE_DIR), 'nothing is written to disk');
    assert.strictEqual(state.initialized, 0);
});

test('code that is not text is refused instead of being stringified into index.js', async () => {
    const res = await dispatch({ method: 'POST', url: '/create-component', body: { component: { ...COMPONENT, code: { 'index.js': 'x' } } } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Component code must be text — it becomes index.js.');
    assert.ok(!fs.existsSync(PROBE_DIR));
});

test('an id outside [a-z0-9-] keeps its own sentence', async () => {
    const res = await dispatch({ method: 'POST', url: '/create-component', body: { component: { ...COMPONENT, id: '../escape' } } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Component ID must be lowercase letters, numbers, and hyphens only');
    assert.ok(!fs.existsSync(PROBE_DIR));
});

test('a component with no name is still "Invalid component data", now naming the field', async () => {
    const res = await dispatch({ method: 'POST', url: '/create-component', body: { component: { id: PROBE_ID, code: 'x' } } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Invalid component data');
    assert.ok(res.body.details.some((d) => d.path === 'body.component.name'));
});

test('dependencies must map package names to version ranges', async () => {
    const res = await dispatch({ method: 'POST', url: '/create-component', body: { component: { ...COMPONENT, dependencies: ['axios'] } } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.component.dependencies'));
    assert.ok(!fs.existsSync(PROBE_DIR));
});

test('an empty list means "none" — the designer model writes [] as often as {}', async () => {
    // The studio posts the model's JSON block as-is. Refusing `[]` here failed
    // an ordinary Create with a 400 that the user could do nothing about.
    try {
        const res = await dispatch({
            method: 'POST', url: '/create-component',
            body: { component: { ...COMPONENT, dependencies: [], inputs: [], outputs: [] } },
        });
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        const pkg = JSON.parse(fs.readFileSync(path.join(PROBE_DIR, 'package.json'), 'utf8'));
        const spec = JSON.parse(fs.readFileSync(path.join(PROBE_DIR, 'component.json'), 'utf8'));
        assert.deepStrictEqual(pkg.dependencies, {}, 'written as an object, the shape package.json has');
        assert.deepStrictEqual(spec.inputs, {});
        assert.deepStrictEqual(spec.outputs, {});
        assert.strictEqual(state.initialized, 1);
    } finally {
        fs.rmSync(PROBE_DIR, { recursive: true, force: true });
    }
});

test('a key beside `component` is refused — the body is the envelope, not the component', async () => {
    const res = await dispatch({ method: 'POST', url: '/create-component', body: { component: COMPONENT, agentEnabled: false } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(!fs.existsSync(PROBE_DIR));
});
