/**
 * routes/agents/published.js under the concept/live split:
 *   - GET /agents/published stays a BARE ARRAY (mobile api.ts iterates it) and
 *     serves whatever the store's runtime projection hands out, plus can_edit;
 *   - PATCH /agents/:id/publish stays the AUDIENCE toggle: it never touches
 *     published_* and still re-validates references when flipping on.
 * Dependencies stubbed via the Module resolve hook.
 *
 * Run: cd server && node --test routes/agents/published.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const fx = {
    userId: 'u1',
    published: [],
    agents: {},
    setPublishedCalls: [],
    validateCalls: 0,
};
const noop = () => {};
const mw = () => (req, res, next) => next();

const MOCKS = {
    '../../stores/agentStore': {
        getPublishedAgents: async () => fx.published.map(a => ({ ...a })),
        getPublishedAgentsForUser: async () => fx.published.map(a => ({ ...a })),
        getAllAgents: async () => [],
        getAgent: async (id) => fx.agents[id] || null,
        setAgentPublished: async (...a) => { fx.setPublishedCalls.push(a); return true; },
    },
    '../../core/agentRuntime': {},
    '../../core/aiAgent': { getAIConfig: noop, getProviderForModel: noop },
    '../../stores/configStore': {},
    '../../auth': {
        requirePermission: mw,
        resolveUserOrgIds: async () => null,
        validateSharedGroupsForOrg: async (org, groups) => groups,
    },
    '../../stores/memoryStore': {},
    '../../utils/routeHelpers': { getEffectiveUserId: () => fx.userId, getUserAuth: () => ({}) },
    '../../stores/userStore': { getUser: async () => ({ groups: [], organizationId: null }), getAllGroups: async () => [] },
    '../../stores/usageStore': {},
    '../../core/entitlements/limits': { checkSubscriptionLimits: async () => ({}), checkResourceLimits: async () => ({}) },
    '../../core/http/sseHelpers': { setupSSE: noop, sendSSEError: noop, persistAndTitle: async () => {}, getOrCreateAgentConversation: async () => {} },
    './crud': {
        canModifyAgent: async (a) => a.owner_id === fx.userId,
        buildCanModifyContext: async () => ({}),
        validateAgentConfigReferences: async () => { fx.validateCalls++; return { warnings: [], droppedSkillIds: [] }; },
    },
    '../../compliance/events': { EVENTS: { AGENT_PUBLISHED: 'agent_published' }, emit: noop },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:published:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /agents[\\/]published\.js$/.test(parent.filename) && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./published');
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');
test.after(() => { Module._resolveFilename = originalResolve; });

function dispatch({ method, url, body = {}, session }) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search)) query[k] = v;
        const request = { method, url, originalUrl: url, path: pathname, body, headers: {}, query, session: session === undefined ? { user: { id: fx.userId } } : session, get() { return undefined; } };
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(request, res, (err) => {
            // A schema refusal travels as an error to the terminal handler,
            // so the harness has to answer one the way index.js does.
            if (!err) return reject(new Error(`fell through router: ${method} ${url}`));
            terminalErrorHandler(err, request, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => {
    fx.userId = 'u1';
    fx.published = [
        { id: 'a1', owner_id: 'u1', name: 'Mine', system_prompt: 'pub', config: { k: 1 }, runtimeSource: 'published', published_version: 2 },
        { id: 'a2', owner_id: 'u2', name: 'Theirs', system_prompt: 'live', config: {}, runtimeSource: 'live', published_version: 0 },
    ];
    fx.agents = { a1: { id: 'a1', owner_id: 'u1', organization_id: null, config: {}, is_published: false } };
    fx.setPublishedCalls.length = 0;
    fx.validateCalls = 0;
});

test('GET /published is a bare array carrying the runtime projection + can_edit', async () => {
    const res = await dispatch({ method: 'GET', url: '/published' });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(Array.isArray(res.body), 'bare array — mobile iterates over it');
    assert.strictEqual(res.body.length, 2);
    const a1 = res.body.find(a => a.id === 'a1');
    assert.strictEqual(a1.system_prompt, 'pub');
    assert.strictEqual(a1.runtimeSource, 'published');
    assert.strictEqual(a1.published_version, 2, 'additive scalar field passes through');
    assert.strictEqual(a1.can_edit, true);
    assert.strictEqual(res.body.find(a => a.id === 'a2').can_edit, false);
});

test('GET /published without a session still answers a bare array (can_edit false)', async () => {
    const res = await dispatch({ method: 'GET', url: '/published', session: null });
    assert.ok(Array.isArray(res.body));
    assert.ok(res.body.every(a => a.can_edit === false));
});

test('PATCH /:id/publish is the audience toggle: setAgentPublished only, references re-validated when flipping on', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/a1/publish', body: { isPublished: true, sharedGroups: ['g1'] } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { success: true, isPublished: true, sharedGroups: ['g1'] });
    assert.strictEqual(fx.validateCalls, 1);
    assert.deepStrictEqual(fx.setPublishedCalls, [['a1', true, 'u1', ['g1']]]);
});

test('PATCH /:id/publish off: no reference validation, still audience-only', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/a1/publish', body: { isPublished: false } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(fx.validateCalls, 0);
    assert.deepStrictEqual(fx.setPublishedCalls, [['a1', false, 'u1', undefined]]);
});

test('PATCH /:id/publish by a non-editor → 403 agent_not_editable', async () => {
    fx.userId = 'stranger';
    const res = await dispatch({ method: 'PATCH', url: '/a1/publish', body: { isPublished: true } });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.code, 'agent_not_editable');
    assert.strictEqual(fx.setPublishedCalls.length, 0);
});

// ── What a caller may send ───────────────────────────────────────────

test('a truthy word on ?usage is refused, not answered with a list without counters', async () => {
    // `usage=yes` was neither '1' nor 'true', so the tab rendered every row
    // at zero conversations — which reads as an empty product, not as a
    // dropped parameter.
    const res = await dispatch({ method: 'GET', url: '/published?usage=yes' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.strictEqual(res.body.error, 'usage is "1" or "0".');
});

test('the Agent Hub cache-buster ?t= is accepted, not answered with a 400', async () => {
    // useAgentHubData.js asks for `/agents/published?t=${Date.now()}`. A strict
    // query without `t` refused every Hub load, and the Hub read the 400 as
    // "no published agents": users saw only their own.
    const res = await dispatch({ method: 'GET', url: `/published?t=${Date.now()}` });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(Array.isArray(res.body));
    assert.strictEqual(res.body.length, 2);
});

test('an unknown query key next to the cache-buster is still refused', async () => {
    const res = await dispatch({ method: 'GET', url: '/published?t=1&usgae=1' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'invalid_request');
});

test('a misspelled sharing key is refused, not read as "leave the sharing as it is"', async () => {
    // `undefined` means "do not touch the audience" on purpose, so a typo
    // published an agent to a new group and left it shared with the old one.
    const res = await dispatch({
        method: 'PATCH', url: '/a1/publish',
        body: { isPublished: true, sharedGroup: ['sales'] },
    });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some(d => d.path === 'body'), JSON.stringify(res.body.details));
    assert.deepStrictEqual(fx.setPublishedCalls, [], 'and nothing is published');
});

test('a group list sent as one group is refused by name', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/a1/publish', body: { sharedGroups: 'sales' } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some(d => d.path === 'body.sharedGroups'), JSON.stringify(res.body.details));
    assert.deepStrictEqual(fx.setPublishedCalls, []);
});
