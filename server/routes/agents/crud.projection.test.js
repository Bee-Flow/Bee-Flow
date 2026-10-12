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

const fx = { userId: 'owner', draft: null, runtime: null, loads: 0, callerOrgIds: new Set(), monitoring: null, asked: [] };
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
        resolveUserOrgIds: async () => fx.callerOrgIds,
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
    // Chat signals: the resolver for the agent's org (complianceCounting).
    '../../core/entitlements/chatMonitoringFlag': {
        resolveChatMonitoring: async (orgKey) => { fx.asked.push(orgKey); return fx.monitoring; },
    },
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
    fx.callerOrgIds = new Set();
    fx.monitoring = null;
    fx.asked = [];
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

// ── Chat signals: complianceCounting { state, from } ─────────────────

const COUNTING_OFF = { state: 'off', from: null };
const AGENT_ON = {
    state: 'on', version: '2026-10-14T09:00:00.000Z', from: '2026-10-14', surfaces: ['direct', 'agent'],
    paused: [], signals: ['outcomes'], noticeUrl: 'https://acme.example/n', visitorNoticeUrl: null, retentionDays: 90,
};
const inOrg = (over = {}) => {
    fx.draft = { ...fx.draft, organization_id: 'org-1', ...over };
    fx.runtime = { ...fx.runtime, organization_id: 'org-1', ...over };
};

test('complianceCounting: a member of the agent\'s org is told the state and the start date, nothing else', async () => {
    inOrg();
    fx.callerOrgIds = new Set(['org-1']);
    fx.monitoring = AGENT_ON;
    const res = await get('/a1');
    assert.deepStrictEqual(res.body.complianceCounting, { state: 'on', from: '2026-10-14' });
    assert.deepStrictEqual(fx.asked, ['org-1'], 'the resolver is asked about the AGENT\'s org');
    fx.monitoring = { ...AGENT_ON, state: 'scheduled' };
    assert.deepStrictEqual((await get('/a1')).body.complianceCounting, { state: 'scheduled', from: '2026-10-14' });
    // The editor's concept view carries it too.
    assert.deepStrictEqual((await get('/a1', { draft: '1' })).body.complianceCounting, { state: 'scheduled', from: '2026-10-14' });
});

test('complianceCounting: off for another org\'s member, a super admin and an agent without an org', async () => {
    inOrg();
    fx.monitoring = AGENT_ON;
    fx.callerOrgIds = new Set(['org-2']);
    assert.deepStrictEqual((await get('/a1')).body.complianceCounting, COUNTING_OFF);
    fx.callerOrgIds = null; // a super admin: resolveUserOrgIds answers null
    assert.deepStrictEqual((await get('/a1')).body.complianceCounting, COUNTING_OFF);

    fx.asked = [];
    inOrg({ organization_id: null });
    fx.callerOrgIds = new Set(['org-1']);
    assert.deepStrictEqual((await get('/a1')).body.complianceCounting, COUNTING_OFF);
    assert.deepStrictEqual(fx.asked, [], 'no org, no question');
});

test('complianceCounting: off when agent chat is not counted (off, only other chat types, or paused)', async () => {
    inOrg();
    fx.callerOrgIds = new Set(['org-1']);
    fx.monitoring = { ...AGENT_ON, state: 'off' };
    assert.deepStrictEqual((await get('/a1')).body.complianceCounting, COUNTING_OFF);
    fx.monitoring = { ...AGENT_ON, surfaces: ['direct'], paused: [{ surface: 'agent', missing: ['dpia_expired'] }] };
    assert.deepStrictEqual((await get('/a1')).body.complianceCounting, COUNTING_OFF);
    fx.monitoring = null;
    assert.deepStrictEqual((await get('/a1')).body.complianceCounting, COUNTING_OFF);
});

test('complianceCounting: a resolver failure reads off and the agent still loads', async () => {
    inOrg();
    fx.callerOrgIds = new Set(['org-1']);
    fx.monitoring = Promise.reject(new Error('ECONNREFUSED'));
    fx.monitoring.catch(() => {});
    const res = await get('/a1');
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.complianceCounting, COUNTING_OFF);
});

