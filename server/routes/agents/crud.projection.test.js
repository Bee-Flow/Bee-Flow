/**
 * GET /agents/:id under the concept/live split (A1): the default answer is the
 * runtime projection (what mobile chats with), `?draft=1` hands an EDITOR the
 * concept, a non-editor asking for the draft still gets the projection, and
 * `unpublishedChanges` is only attached for editors. Shape otherwise unchanged
 * (can_edit stays). Same stub harness as crud.authz.test.js.
 *
 * Run: cd server && node --test --test-force-exit routes/agents/crud.projection.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const fx = { userId: 'owner', draft: null, runtime: null, loads: 0 };
const noop = () => {};
const mw = () => (req, res, next) => next();

const MOCKS = {
    '../../stores/agentStore': {
        // The handler must use the ONE-load view pair; the two single-view
        // loaders are here only so a regression to either shows up as a
        // failed load count rather than a passing test.
        getAgent: async () => { fx.loads++; return fx.draft; },
        getForRuntime: async () => { fx.loads++; return fx.runtime; },
        getAgentViews: async () => { fx.loads++; return fx.draft ? { draft: fx.draft, runtime: fx.runtime } : null; },
    },
    '../../core/agentRuntime': {},
    '../../core/aiAgent': { getAIConfig: noop, getProviderForModel: noop },
    '../../core/llm/modelResolver': { normalizeTierModel: (m) => m },
    '../../stores/configStore': {},
    '../../auth': {
        requirePermission: mw,
        requireActiveOrgForMutations: mw,
        OrgRoles: { AGENT_EDITOR: 'agent_editor', ORG_ADMIN: 'org_admin' },
        SystemRoles: { SUPER_ADMIN: 'admin' },
        hasPermission: async () => false,
        resolveUserOrgIds: async () => new Set(),
        canSeePublished: () => true,
        resolveUserGroups: async () => [],
        assertUserCanUseOrg: async () => {},
        validateSharedGroupsForOrg: async () => [],
        isOrgAdminRole: () => false,
    },
    '../../stores/memoryStore': {},
    '../../utils/routeHelpers': { getEffectiveUserId: () => fx.userId, getUserAuth: () => ({}) },
    '../../stores/userStore': { getUser: async () => ({ orgRole: 'member' }) },
    '../../stores/usageStore': {},
    '../../core/entitlements/limits': { checkSubscriptionLimits: async () => ({}), checkResourceLimits: async () => ({}) },
    '../../core/http/sseHelpers': { setupSSE: noop, sendSSEError: noop, persistAndTitle: async () => {}, getOrCreateAgentConversation: async () => {} },
    '../../stores/skillStore': { getSkillScope: async () => null },
    '../../stores/knowledgeBases': { getKB: async () => null, isSystemKB: () => false },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:crud-projection:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /agents[\\/]crud\.js$/.test(parent.filename) && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./crud');
test.after(() => { Module._resolveFilename = originalResolve; });

function get(url, query = {}) {
    return new Promise((resolve, reject) => {
        const request = { method: 'GET', url, body: {}, query, headers: {}, session: { user: { id: fx.userId } }, get() { return undefined; } };
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(request, res, (err) => reject(err || new Error(`fell through router: GET ${url}`)));
    });
}

test.beforeEach(() => {
    fx.userId = 'owner';
    fx.loads = 0;
    fx.draft = {
        id: 'a1', owner_id: 'owner', is_published: true, organization_id: null, shared_groups: [],
        rev: 9, published_version: 2, published_rev: 6,
        system_prompt: 'DRAFT', config: { knowledge_base_ids: ['kb-draft'] }, tools: [], tool_params: {},
    };
    fx.runtime = { ...fx.draft, system_prompt: 'PUBLISHED', config: { knowledge_base_ids: ['kb-pub'] }, runtimeSource: 'published' };
});

test('default: the runtime projection, with can_edit and (for the owner) unpublishedChanges', async () => {
    const res = await get('/a1');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.system_prompt, 'PUBLISHED');
    assert.deepStrictEqual(res.body.config, { knowledge_base_ids: ['kb-pub'] });
    assert.strictEqual(res.body.runtimeSource, 'published');
    assert.strictEqual(res.body.can_edit, true);
    assert.strictEqual(res.body.unpublishedChanges, 3, 'rev 9 - published_rev 6');
    assert.strictEqual(res.body.rev, 9, 'rev stays the CAS token');
    assert.strictEqual(fx.loads, 1, 'one agent load per request — both views come from the same snapshot');
});

test('?draft=1 for an editor → the concept, runtimeSource draft', async () => {
    const res = await get('/a1', { draft: '1' });
    assert.strictEqual(res.body.system_prompt, 'DRAFT');
    assert.deepStrictEqual(res.body.config, { knowledge_base_ids: ['kb-draft'] });
    assert.strictEqual(res.body.runtimeSource, 'draft');
    assert.strictEqual(res.body.can_edit, true);
    assert.strictEqual(res.body.unpublishedChanges, 3);
});

test('?draft=1 for a non-editor → still the runtime projection, no unpublishedChanges, no 403', async () => {
    fx.userId = 'viewer';
    const res = await get('/a1', { draft: '1' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.system_prompt, 'PUBLISHED');
    assert.strictEqual(res.body.can_edit, false);
    assert.ok(!('unpublishedChanges' in res.body));
});

test('never-published agent: projection = live, unpublishedChanges 0 for the editor', async () => {
    fx.draft = { ...fx.draft, published_version: 0, published_rev: null };
    fx.runtime = { ...fx.draft, runtimeSource: 'live' };
    const res = await get('/a1');
    assert.strictEqual(res.body.system_prompt, 'DRAFT');
    assert.strictEqual(res.body.runtimeSource, 'live');
    assert.strictEqual(res.body.unpublishedChanges, 0);
});

test('unknown agent → 404', async () => {
    fx.draft = null;
    const res = await get('/nope');
    assert.strictEqual(res.statusCode, 404);
});

test('?draft=1 for an editor also costs one load', async () => {
    const res = await get('/a1', { draft: '1' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(fx.loads, 1);
});
