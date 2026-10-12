'use strict';

/**
 * The id lists the builder model fills ids from (builderPickerCatalog.js).
 *
 * What is pinned:
 *   - the canvas permission filters carry over: an agent that cannot run inside
 *     an automation is `canUse:false`, a knowledge base reports `canWrite` from
 *     canUserManageKB, a system base is never a choice, a provider is listed only
 *     for a service the user has;
 *   - a FAILED read is its own answer (an error string beside an empty list),
 *     never the same as "none", and one failing list does not take the others
 *     with it;
 *   - nothing in a row is anything but the user's own ids, names and descriptions.
 *
 * Run: cd server && node --test automation/builderPickerCatalog.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const picker = require('./builderPickerCatalog');

// Every collaborator is injected (`deps`): no store, no database, no module cache.
let state;
const reset = () => {
    state = {
        mine: [], published: [], agentsThrow: null, identityError: null, orgId: 'org1', groups: ['g1'],
        kbs: [], kbThrow: null, canManage: false, isOrgAdmin: false, orgIds: new Set(['org1']), seenOrgIds: null,
        features: { support_inbox: false, meeting_notes: false }, inboxes: [], publicBase: null, mcpIds: new Set(),
    };
};
reset();
const deps = {
    agentStore: () => ({
        async getAgents() { if (state.agentsThrow) throw new Error(state.agentsThrow); return state.mine; },
        async getPublishedAgentsForUser() { return state.published; },
    }),
    resolveUserGroups: async () => state.groups,
    resolvePrincipal: async () => ({ organizationId: state.orgId, identityError: state.identityError }),
    kbStore: () => ({
        async listKBs(_u, orgIds) { state.seenOrgIds = orgIds; if (state.kbThrow) throw new Error(state.kbThrow); return state.kbs; },
        filterByGroupAccess: (kbs) => kbs,
        canUserManageKB: (kb, _u, _o, canManage) => kb.managed === true || canManage === true,
        isSystemKB: (kb) => kb.tenant_id === 'system',
    }),
    askerContext: async () => ({ orgIds: state.orgIds, userGroups: state.groups }),
    hasPermission: async () => state.canManage,
    isOrgAdmin: async () => state.isOrgAdmin,
    hasFeature: async (_u, f) => state.features[f] === true,
    listInboxes: async () => state.inboxes,
    publicBaseUrl: () => state.publicBase,
    availableMcpServerIds: async () => state.mcpIds,
};

beforeEach(reset);

const agent = (over) => ({ id: 'a1', name: 'Helper', description: 'Answers', owner_id: 'u1', is_published: false, organization_id: null, shared_groups: [], ...over });

test('agents: own agents and published org agents, with canUse and the reason when not', async () => {
    state.mine = [agent({ id: 'own', name: 'Mine' })];
    state.published = [
        agent({ id: 'shared', name: 'Shared', owner_id: 'u2', is_published: true, published_version: 2, organization_id: 'org1' }),
        agent({ id: 'draft', name: 'Draft', owner_id: 'u2', is_published: false, organization_id: 'org1' }),
        agent({ id: 'system', name: 'System', owner_id: 'system', is_published: true }),
    ];
    const { agents, agentsError } = await picker.buildAgentPickerForUser('u1', { deps });
    assert.equal(agentsError, null);
    const byId = Object.fromEntries(agents.map(a => [a.id, a]));
    assert.equal(byId.own.canUse, true);
    assert.equal(byId.shared.canUse, true);
    assert.equal(byId.draft.canUse, false);
    assert.equal(byId.draft.reason, 'not_published');
    assert.equal(byId.system, undefined, 'a product agent is not a choice');
});

test('agents: a failed read is an error beside an empty list, not an empty workspace', async () => {
    state.agentsThrow = 'db down';
    const r = await picker.buildAgentPickerForUser('u1', { deps });
    assert.deepEqual(r.agents, []);
    assert.equal(r.agentsError, 'db down');
});

test('agents: a failed IDENTITY read is not read as "every org agent belongs to another workspace"', async () => {
    state.identityError = 'the account could not be read';
    const r = await picker.buildAgentPickerForUser('u1', { deps });
    assert.match(r.agentsError, /identity unavailable/);
    assert.deepEqual(r.agents, []);
});

test('agents: a principal the caller already resolved is used, not read again', async () => {
    state.identityError = 'would fail';
    const r = await picker.buildAgentPickerForUser('u1', { principal: { organizationId: 'org1', identityError: null }, deps });
    assert.equal(r.agentsError, null);
});

test('knowledge bases: canWrite comes from canUserManageKB, system bases are dropped', async () => {
    state.kbs = [
        { id: 'k1', name: 'Handbook', description: 'HR', organization_id: 'org1', managed: true },
        { id: 'k2', name: 'Wiki', organization_id: 'org1' },
        { id: 'k3', name: 'Shipped', tenant_id: 'system', organization_id: null },
        { id: 'k4', name: 'Notes', organization_id: null, managed: true },
    ];
    const { knowledgeBases, knowledgeBasesError } = await picker.buildKnowledgeBasePickerForUser('u1', { deps });
    assert.equal(knowledgeBasesError, null);
    assert.deepEqual(knowledgeBases.map(k => [k.id, k.canWrite, k.scope]), [['k1', true, 'org'], ['k2', false, 'org'], ['k4', true, 'personal']]);
});

test('knowledge bases: manage_knowledge turns every visible base writable', async () => {
    state.kbs = [{ id: 'k2', name: 'Wiki', organization_id: 'org1' }];
    state.canManage = true;
    const { knowledgeBases } = await picker.buildKnowledgeBasePickerForUser('u1', { deps });
    assert.equal(knowledgeBases[0].canWrite, true);
});

test('knowledge bases: orgIds is always a Set (a null would read as super-admin)', async () => {
    await picker.listKnowledgeBasePicker({ userId: 'u1', orgIds: null, userGroups: [], canManage: false, isOrgAdmin: false }, { deps });
    assert.ok(state.seenOrgIds instanceof Set);
    assert.equal(state.seenOrgIds.size, 0);
});

test('knowledge bases: a failed read is an error beside an empty list', async () => {
    state.kbThrow = 'store down';
    const r = await picker.buildKnowledgeBasePickerForUser('u1', { deps });
    assert.deepEqual(r.knowledgeBases, []);
    assert.equal(r.knowledgeBasesError, 'store down');
});

test('app-event providers: only the services this user has, plus the always-on approvals', async () => {
    const withGmail = await picker.buildAppEventProvidersFor({
        userId: 'u1', session: {}, apps: [{ id: 'gmail', label: 'Gmail', available: true }, { id: 'nextcloud', label: 'Nextcloud', available: false }],
        userToolNames: new Set(['gmail_search']), userToolDefs: [], orgId: 'org1',
    }, { deps });
    const ids = withGmail.map(p => p.id);
    assert.ok(ids.includes('gmail'));
    assert.ok(ids.includes('approvals'));
    assert.ok(!ids.includes('nextcloud'), 'a service the user does not have is not offered');
    const none = await picker.buildAppEventProvidersFor({ userId: 'u1', session: {}, apps: [], userToolNames: new Set(), userToolDefs: [], orgId: null }, { deps });
    assert.deepEqual(none.map(p => p.id), ['approvals']);
});

test('app-event providers: the support provider needs an inbox, the meeting-notes provider its capability — both fail closed', async () => {
    const base = { userId: 'u1', session: {}, apps: [], userToolNames: new Set(), userToolDefs: [], orgId: 'org1' };
    assert.ok(!(await picker.buildAppEventProvidersFor(base, { deps })).some(p => p.id === 'meeting-notes'));
    state.features.support_inbox = true; // the beta alone is not enough: no inbox exists
    assert.ok(!(await picker.buildAppEventProvidersFor(base, { deps })).some(p => p.id === 'support'));
    state.inboxes = [{ id: 'i1' }];
    assert.ok((await picker.buildAppEventProvidersFor(base, { deps })).some(p => p.id === 'support'));
    state.features.meeting_notes = true;
    const on = await picker.buildAppEventProvidersFor(base, { deps });
    assert.ok(on.some(p => p.id === 'meeting-notes'), 'listed once the capability is on');
});

test('buildPickerCatalogsForUser never throws, and one failing list keeps the others', async () => {
    state.agentsThrow = 'agents down';
    state.kbs = [{ id: 'k1', name: 'Handbook', organization_id: 'org1', managed: true }];
    const out = await picker.buildPickerCatalogsForUser('u1', { user: { organizationId: 'org1' } },
        { apps: [{ id: 'gmail', label: 'Gmail', available: true }], toolNames: new Set(['gmail_search']) }, { deps });
    assert.equal(out.agentsError, 'agents down');
    assert.equal(out.knowledgeBasesError, null);
    assert.equal(out.knowledgeBases.length, 1);
    assert.equal(out.appEventProvidersError, null);
    assert.ok(out.appEventProviders.some(p => p.id === 'gmail'));
});

test('buildPickerCatalogsForUser: a flowlet asks for no providers', async () => {
    const out = await picker.buildPickerCatalogsForUser('u1', {}, { apps: [] }, { providers: false, deps });
    assert.equal(out.appEventProviders, undefined);
    assert.equal(out.appEventProvidersError, undefined);
    assert.ok(Array.isArray(out.agents));
});

test('rows carry ids, names and descriptions and nothing else', async () => {
    state.mine = [agent({ id: 'own', name: 'Mine', description: 'D', owner_id: 'u1', config: { secret: 'x' }, shared_groups: ['g1'] })];
    const { agents } = await picker.buildAgentPickerForUser('u1', { deps });
    assert.deepEqual(Object.keys(agents[0]).sort(), ['canUse', 'description', 'id', 'name', 'reason', 'scope']);
});
