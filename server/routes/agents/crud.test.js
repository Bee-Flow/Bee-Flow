/**
 * Unit tests for validateAgentConfigReferences (routes/agents/crud.js) — the
 * anti-leak skill/KB reference check. crud.js's heavy top-level deps (aiAgent,
 * agentRuntime, sseHelpers, limits, …) are stubbed via the Module resolve hook
 * so the module loads without the LLM/DB graph; skillStore + knowledgeBases are
 * stubbed with in-memory fixtures.
 *
 * Run: cd server && node --test routes/agents/crud.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// ── Fixtures the lazy stores read ───────────────────────────────────
const SKILLS = { // skill id → { org_id, user_id }
    's-orgA': { org_id: 'orgA', user_id: 'someone' },
    's-orgB': { org_id: 'orgB', user_id: 'someone' },
    's-personal': { org_id: null, user_id: 'owner' },        // personal, owned by the agent owner
    's-personal-other': { org_id: null, user_id: 'other' },  // personal, owned by someone else
};
const KBS = {
    'kb-orgA': { organization_id: 'orgA', tenant_id: 'someone' },
    'kb-orgB': { organization_id: 'orgB', tenant_id: 'someone' },
    'kb-owned': { organization_id: null, tenant_id: 'owner' },
    'kb-system': { organization_id: null, tenant_id: 'system', _system: true },
};

const noop = () => {};
const mw = () => (req, res, next) => next();

const MOCKS = {
    '../../stores/agentStore': {},
    '../../core/agentRuntime': {},
    '../../core/aiAgent': { getAIConfig: noop, getProviderForModel: noop },
    '../../core/llm/modelResolver': { normalizeTierModel: (m) => m },
    '../../stores/configStore': {},
    '../../auth': {
        requirePermission: mw,
        requireActiveOrgForMutations: mw,
        OrgRoles: {}, SystemRoles: {},
        resolveUserOrgIds: async () => new Set(),
        canSeePublished: () => false,
        resolveUserGroups: async () => [],
        assertUserCanUseOrg: async () => {},
        validateSharedGroupsForOrg: async () => [],
    },
    '../../stores/memoryStore': {},
    '../../utils/routeHelpers': { getEffectiveUserId: () => 'owner', getUserAuth: () => ({}) },
    '../../stores/userStore': {},
    '../../stores/usageStore': {},
    '../../core/entitlements/limits': { checkSubscriptionLimits: async () => ({}), checkResourceLimits: async () => ({}) },
    '../../core/http/sseHelpers': { setupSSE: noop, sendSSEError: noop, persistAndTitle: async () => {}, getOrCreateAgentConversation: async () => {} },
    // Lazy requires inside validateAgentConfigReferences:
    '../../stores/skillStore': { getSkillScope: async (id) => SKILLS[id] || null },
    '../../stores/knowledgeBases': { getKB: async (id) => KBS[id] || null, isSystemKB: (kb) => !!kb?._system },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:crud:${request}`;
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

const { validateAgentConfigReferences } = require('./crud');

test.after(() => { Module._resolveFilename = originalResolve; });

const agent = (orgId) => ({ owner_id: 'owner', organization_id: orgId });

test('org-bound agent keeps a same-org skill (no drop, no warning)', async () => {
    const res = await validateAgentConfigReferences(agent('orgA'), { attachedSkillIds: ['s-orgA'] });
    assert.deepStrictEqual(res.droppedSkillIds, []);
    assert.deepStrictEqual(res.warnings, []);
});

test('org-less agent drops an ORG skill (warning, not a hard 400)', async () => {
    const res = await validateAgentConfigReferences(agent(null), { attachedSkillIds: ['s-orgA'] });
    assert.deepStrictEqual(res.droppedSkillIds, ['s-orgA']);
    assert.strictEqual(res.warnings.length, 1);
});

test('org-less agent KEEPS its own personal skill', async () => {
    const res = await validateAgentConfigReferences(agent(null), { attachedSkillIds: ['s-personal'] });
    assert.deepStrictEqual(res.droppedSkillIds, []);
    assert.deepStrictEqual(res.warnings, []);
});

test('org-less agent drops a personal skill owned by someone else', async () => {
    const res = await validateAgentConfigReferences(agent(null), { attachedSkillIds: ['s-personal-other'] });
    assert.deepStrictEqual(res.droppedSkillIds, ['s-personal-other']);
});

test('cross-org skill is dropped (anti-leak preserved, no throw)', async () => {
    const res = await validateAgentConfigReferences(agent('orgA'), { attachedSkillIds: ['s-orgA', 's-orgB'] });
    assert.deepStrictEqual(res.droppedSkillIds, ['s-orgB']);
    assert.deepStrictEqual(res.warnings, ['skill s-orgB']);
});

test('same-org KB is allowed; owner-owned and system KBs allowed', async () => {
    await assert.doesNotReject(() => validateAgentConfigReferences(agent('orgA'), { knowledge_base_ids: ['kb-orgA'] }));
    await assert.doesNotReject(() => validateAgentConfigReferences(agent(null), { knowledge_base_ids: ['kb-owned'] }));
    await assert.doesNotReject(() => validateAgentConfigReferences(agent('orgA'), { knowledge_base_ids: ['kb-system'] }));
});

test('cross-org KB throws a hard 400 (high-severity leak stays blocked)', async () => {
    await assert.rejects(
        () => validateAgentConfigReferences(agent('orgA'), { knowledge_base_ids: ['kb-orgB'] }),
        (err) => err.status === 400 && /knowledge base kb-orgB/.test(err.message),
    );
});
