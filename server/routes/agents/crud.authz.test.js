/**
 * BFSF-271 — canModifyAgent authorization matrix + route-level 403s.
 *
 * The pre-fix gate returned true for ANY manage_agents holder (any org) except
 * agent_editor-on-draft — a cross-org IDOR on PUT/DELETE/publish/tool-params.
 * These tests pin the hardened rules:
 *   owner → allow · super-admin → allow · same-org manage_agents → allow
 *   cross-org → deny · org-less agent non-owner → deny
 *   same-org WITHOUT manage_agents → deny
 *   same-org agent_editor on another's unpublished draft → deny (published → allow)
 *
 * Heavy top-level deps of crud.js are stubbed via the Module resolve hook,
 * exactly like routes/agents/crud.test.js.
 *
 * Run: cd server && node --test routes/agents/crud.authz.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// ── Mutable per-test fixtures the mocks close over ──────────────────
const fx = {
    userId: 'user1',            // getEffectiveUserId
    hasManage: true,            // hasPermission(userId, 'manage_agents')
    orgIds: new Set(['orgA']),  // resolveUserOrgIds
    user: { orgRole: 'org_admin' }, // userStore.getUser
    agents: {},                 // agentStore.getAgent fixtures by id
};

const noop = () => {};
const mw = () => (req, res, next) => next();

const MOCKS = {
    '../../stores/agentStore': {
        getAgent: async (id) => fx.agents[id] || null,
        forceDeleteAgent: async () => true,
    },
    // DELETE asks "what breaks?" before it deletes (A1c). Stubbed to
    // "checked, and nothing uses it" so this suite keeps testing the AUTHZ
    // decision alone; what the guard itself refuses on — a consumer, a kind
    // it could not check, somebody else's conversations — is
    // crud.usage.test.js, end to end through the real gatherUsage.
    './usage': {
        gatherUsage: async () => ({
            rows: [], counts: {}, unchecked: [],
            chat: { conversationCount: 0, userCount: 0, othersConversationCount: 0, lastUsedAt: null },
            audience: { isPublished: false, scope: 'private', groupIds: [], organizationId: null },
        }),
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
        hasPermission: async () => fx.hasManage,
        resolveUserOrgIds: async () => fx.orgIds,
        canSeePublished: () => false,
        resolveUserGroups: async () => [],
        assertUserCanUseOrg: async () => {},
        validateSharedGroupsForOrg: async () => [],
        isOrgAdminRole: (r) => ['org_admin', 'admin'].includes(r),
    },
    '../../stores/memoryStore': {},
    '../../utils/routeHelpers': { getEffectiveUserId: () => fx.userId, getUserAuth: () => ({}) },
    '../../stores/userStore': { getUser: async () => fx.user },
    '../../stores/usageStore': {},
    '../../core/entitlements/limits': { checkSubscriptionLimits: async () => ({}), checkResourceLimits: async () => ({}) },
    '../../core/http/sseHelpers': { setupSSE: noop, sendSSEError: noop, persistAndTitle: async () => {}, getOrCreateAgentConversation: async () => {} },
    '../../stores/skillStore': { getSkillScope: async () => null },
    '../../stores/knowledgeBases': { getKB: async () => null, isSystemKB: () => false },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:crud-authz:${request}`;
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
const { canModifyAgent } = router;

test.after(() => { Module._resolveFilename = originalResolve; });

function resetFx() {
    fx.userId = 'user1';
    fx.hasManage = true;
    fx.orgIds = new Set(['orgA']);
    fx.user = { orgRole: 'org_admin' };
    fx.agents = {};
}

const req = (session = {}) => ({ session: { user: { id: fx.userId }, ...session } });
const AGENT = (over = {}) => ({ id: 'a1', owner_id: 'someone-else', organization_id: 'orgA', is_published: 1, ...over });

// ═══ canModifyAgent unit matrix ═════════════════════════════════════

test('owner always allowed (even without manage_agents)', async () => {
    resetFx();
    fx.hasManage = false;
    assert.strictEqual(await canModifyAgent(AGENT({ owner_id: 'user1' }), 'user1', req()), true);
});

test('super-admin always allowed (session.isAdmin)', async () => {
    resetFx();
    fx.hasManage = false;
    assert.strictEqual(await canModifyAgent(AGENT(), 'user1', req({ isAdmin: true })), true);
});

test('same-org org_admin with manage_agents allowed', async () => {
    resetFx();
    assert.strictEqual(await canModifyAgent(AGENT(), 'user1', req()), true);
});

test('same-org agent_editor: published allowed, unpublished draft denied', async () => {
    resetFx();
    fx.user = { orgRole: 'agent_editor' };
    assert.strictEqual(await canModifyAgent(AGENT({ is_published: 1 }), 'user1', req()), true);
    assert.strictEqual(await canModifyAgent(AGENT({ is_published: 0 }), 'user1', req()), false);
});

test('CROSS-ORG manage_agents holder denied (the BFSF-271 IDOR)', async () => {
    resetFx();
    fx.orgIds = new Set(['orgB']); // requester belongs to another org
    assert.strictEqual(await canModifyAgent(AGENT({ organization_id: 'orgA' }), 'user1', req()), false);
});

test('org-less agent (system/personal draft): non-owner denied even with manage_agents', async () => {
    resetFx();
    assert.strictEqual(await canModifyAgent(AGENT({ organization_id: null }), 'user1', req()), false);
});

test('same-org WITHOUT manage_agents denied', async () => {
    resetFx();
    fx.hasManage = false;
    assert.strictEqual(await canModifyAgent(AGENT(), 'user1', req()), false);
});

test('multi-org membership: secondary org counts (Set semantics, not primary-org equality)', async () => {
    resetFx();
    fx.orgIds = new Set(['orgB', 'orgA']);
    assert.strictEqual(await canModifyAgent(AGENT({ organization_id: 'orgA' }), 'user1', req()), true);
});

// ═══ Route-level: cross-org PUT/DELETE return the structured 403 ═══

function dispatch({ method, url, body = {} }) {
    return new Promise((resolve, reject) => {
        const request = {
            method,
            url,
            body,
            headers: {},
            session: { user: { id: fx.userId } },
            get(name) { return this.headers[String(name).toLowerCase()]; },
        };
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(request, res, (err) => reject(err || new Error(`fell through router: ${method} ${url}`)));
    });
}

test('PUT /agents/:id from a cross-org admin → 403 agent_not_editable', async () => {
    resetFx();
    fx.orgIds = new Set(['orgB']);
    fx.agents.a1 = AGENT({ organization_id: 'orgA' });
    const res = await dispatch({ method: 'PUT', url: '/a1', body: { name: 'hijack' } });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.code, 'agent_not_editable');
});

test('DELETE /agents/:id from a cross-org admin → 403 agent_not_editable', async () => {
    resetFx();
    fx.orgIds = new Set(['orgB']);
    fx.agents.a1 = AGENT({ organization_id: 'orgA' });
    const res = await dispatch({ method: 'DELETE', url: '/a1' });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.code, 'agent_not_editable');
});

test('DELETE /agents/:id by the owner → 200 (owner path unaffected)', async () => {
    resetFx();
    fx.hasManage = false; // owners need no permission
    fx.agents.a1 = AGENT({ owner_id: 'user1' });
    const res = await dispatch({ method: 'DELETE', url: '/a1' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
});
