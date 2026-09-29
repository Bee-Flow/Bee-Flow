/**
 * BFSF-272 — agent-category management routes.
 *
 * Pins: idempotent create (case-insensitive duplicate returns the EXISTING
 * row with existing:true instead of stacking "Sales" next to "sales"), the
 * new PATCH rename (org-scoped, 409 on name clash), and the guided DELETE
 * (409-with-count when in use; ?reassignTo=none uncategorises;
 * ?reassignTo=<id> merges — same-org targets only; cross-org mutations 404
 * — the pre-fix DELETE let any manage_agents holder remove another org's
 * category by id).
 *
 * Same Module-resolve-hook harness as crud.authz.test.js.
 *
 * Run: cd server && node --test routes/agents/categories.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// ── Mutable fixtures ─────────────────────────────────────────────────
const fx = {
    orgIds: new Set(['orgA']),   // resolveUserOrgIds (null = super-admin)
    categories: {},              // id → row
    agentCounts: {},             // id → in-use count
    reassigns: [],               // spy
    deletes: [],                 // spy
};

const noop = () => {};
const mw = () => (req, res, next) => next();

const MOCKS = {
    '../../stores/agentStore': {
        getAgentCategory: async (id) => fx.categories[id] || null,
        findAgentCategoryByName: async (orgId, name) =>
            Object.values(fx.categories).find(c =>
                (c.organization_id || null) === (orgId || null)
                && c.name.toLowerCase() === String(name).trim().toLowerCase()) || null,
        createAgentCategory: async (orgId, name, icon, color) => {
            const row = { id: `new-${name}`, organization_id: orgId, name, icon: icon || '📁', color: color || '#888' };
            fx.categories[row.id] = row;
            return row;
        },
        updateAgentCategory: async (id, patch) => {
            if (!fx.categories[id]) return null;
            fx.categories[id] = { ...fx.categories[id], ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
            return fx.categories[id];
        },
        countAgentsInCategory: async (id) => fx.agentCounts[id] || 0,
        reassignAgentsCategory: async (fromId, toId) => { fx.reassigns.push({ fromId, toId }); return fx.agentCounts[fromId] || 0; },
        deleteAgentCategory: async (id, orgId) => { fx.deletes.push({ id, orgId }); delete fx.categories[id]; return true; },
        getAgent: async () => null,
        getAgentCategories: async () => Object.values(fx.categories),
    },
    '../../core/agentRuntime': {},
    '../../core/aiAgent': { getAIConfig: noop, getProviderForModel: noop },
    '../../core/llm/modelResolver': { normalizeTierModel: (m) => m },
    '../../stores/configStore': {},
    '../../auth': {
        requirePermission: mw,
        requireActiveOrgForMutations: mw,
        OrgRoles: { AGENT_EDITOR: 'agent_editor' }, SystemRoles: { SUPER_ADMIN: 'admin' },
        hasPermission: async () => true,
        resolveUserOrgIds: async () => fx.orgIds,
        canSeePublished: () => false,
        resolveUserGroups: async () => [],
        assertUserCanUseOrg: async () => {},
        validateSharedGroupsForOrg: async () => [],
        isOrgAdminRole: () => true,
    },
    '../../stores/memoryStore': {},
    '../../utils/routeHelpers': { getEffectiveUserId: () => 'user1', getUserAuth: () => ({}) },
    '../../stores/userStore': { getUser: async () => ({ orgRole: 'org_admin' }) },
    '../../stores/usageStore': {},
    '../../core/entitlements/limits': { checkSubscriptionLimits: async () => ({}), checkResourceLimits: async () => ({}) },
    '../../core/http/sseHelpers': { setupSSE: noop, sendSSEError: noop, persistAndTitle: async () => {}, getOrCreateAgentConversation: async () => {} },
    '../../stores/skillStore': { getSkillScope: async () => null },
    '../../stores/knowledgeBases': { getKB: async () => null, isSystemKB: () => false },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:categories:${request}`;
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

function resetFx() {
    fx.orgIds = new Set(['orgA']);
    fx.categories = {
        sales: { id: 'sales', organization_id: 'orgA', name: 'Sales' },
        marketing: { id: 'marketing', organization_id: 'orgA', name: 'Marketing' },
        foreign: { id: 'foreign', organization_id: 'orgB', name: 'Foreign' },
    };
    fx.agentCounts = {};
    fx.reassigns.length = 0;
    fx.deletes.length = 0;
}

function dispatch({ method, url, body = {} }) {
    return new Promise((resolve, reject) => {
        const [path, qs] = url.split('?');
        const request = {
            method,
            url,
            body,
            query: Object.fromEntries(new URLSearchParams(qs || '')),
            headers: {},
            session: { user: { id: 'user1' } },
            get(name) { return this.headers[String(name).toLowerCase()]; },
        };
        void path;
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

// ═══ Idempotent create ══════════════════════════════════════════════

test('POST duplicate name (case-insensitive) returns the existing row with existing:true', async () => {
    resetFx();
    const res = await dispatch({ method: 'POST', url: '/categories', body: { name: '  sAlEs ' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.id, 'sales', 'the existing row, not a doppelgänger');
    assert.strictEqual(res.body.existing, true);
    assert.strictEqual(Object.keys(fx.categories).length, 3, 'nothing inserted');
});

test('POST a genuinely new name creates it', async () => {
    resetFx();
    const res = await dispatch({ method: 'POST', url: '/categories', body: { name: 'Support' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.existing, undefined);
    assert.ok(fx.categories[res.body.id]);
});

// ═══ PATCH rename ═══════════════════════════════════════════════════

test('PATCH renames within the org; clash with another category 409s', async () => {
    resetFx();
    let res = await dispatch({ method: 'PATCH', url: '/categories/sales', body: { name: 'Verkoop' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.name, 'Verkoop');

    resetFx();
    res = await dispatch({ method: 'PATCH', url: '/categories/sales', body: { name: 'marketing' } });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'name_taken');
});

test('PATCH on another org\'s category → 404 (no cross-org leak)', async () => {
    resetFx();
    const res = await dispatch({ method: 'PATCH', url: '/categories/foreign', body: { name: 'Hijack' } });
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(fx.categories.foreign.name, 'Foreign', 'untouched');
});

test('super-admin (resolveUserOrgIds null) may manage any category', async () => {
    resetFx();
    fx.orgIds = null;
    const res = await dispatch({ method: 'PATCH', url: '/categories/foreign', body: { name: 'Renamed by root' } });
    assert.strictEqual(res.statusCode, 200);
});

// ═══ DELETE / guided flow ═══════════════════════════════════════════

test('DELETE an in-use category without reassignTo → 409 with the live count', async () => {
    resetFx();
    fx.agentCounts.sales = 4;
    const res = await dispatch({ method: 'DELETE', url: '/categories/sales' });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'category_in_use');
    assert.strictEqual(res.body.count, 4);
    assert.strictEqual(fx.deletes.length, 0, 'nothing deleted');
});

test('DELETE ?reassignTo=none uncategorises the agents, then deletes', async () => {
    resetFx();
    fx.agentCounts.sales = 4;
    const res = await dispatch({ method: 'DELETE', url: '/categories/sales?reassignTo=none' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(fx.reassigns, [{ fromId: 'sales', toId: null }]);
    assert.strictEqual(res.body.reassigned, 4);
    assert.strictEqual(fx.deletes.length, 1);
});

test('DELETE ?reassignTo=<id> merges into a same-org category', async () => {
    resetFx();
    fx.agentCounts.sales = 2;
    const res = await dispatch({ method: 'DELETE', url: '/categories/sales?reassignTo=marketing' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(fx.reassigns, [{ fromId: 'sales', toId: 'marketing' }]);
});

test('merge target from another org (or self) is rejected', async () => {
    resetFx();
    let res = await dispatch({ method: 'DELETE', url: '/categories/sales?reassignTo=foreign' });
    assert.strictEqual(res.statusCode, 400);

    resetFx();
    res = await dispatch({ method: 'DELETE', url: '/categories/sales?reassignTo=sales' });
    assert.strictEqual(res.statusCode, 400);
});

test('DELETE on another org\'s category → 404 (the pre-fix cross-org hole)', async () => {
    resetFx();
    const res = await dispatch({ method: 'DELETE', url: '/categories/foreign' });
    assert.strictEqual(res.statusCode, 404);
    assert.ok(fx.categories.foreign, 'still there');
});
