/**
 * routes/automation/agentBindings.js: GET/PUT /:id/agent-bindings over a real
 * Express app, with every dependency injected through makeAgentBindingsRouter
 * (no module mocking). The gate behind it is the real one
 * (automation/agentBinding.js), its full rules are in agentBinding.test.js; this
 * file proves the route in front of it.
 *
 * Proven:
 *   - the body is validated before anything is read or written;
 *   - GET needs view rights, PUT is refused to anyone who cannot edit;
 *   - a refusal from the gate reaches the client as its code and sentence, and
 *     an unknown agent looks exactly like one the caller may not edit;
 *   - GET /by-agent/:agentId/automation-ids answers only for an agent the viewer
 *     may edit, and an unknown agent reads the same as one that is not theirs;
 *   - the answer after a PUT is the listing the dialog redraws from;
 *   - the router is mounted under /api/automation next to the sharing routes.
 *
 * Run: cd server && node --test routes/automation/agentBindings.test.js
 */

'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { makeAgentBindingsRouter } = require('./agentBindings');
const { makeAgentAccess } = require('../../agents/agentAccess');
const { serve, assertRefused } = require('../../core/http/routeHarness');

const USERS = {
    owner: { id: 'owner', organizationId: 'org1', groups: [] },
    ed: { id: 'ed', organizationId: 'org1', groups: [] },
    vic: { id: 'vic', organizationId: 'org1', groups: [] },
    stranger: { id: 'stranger', organizationId: 'org1', groups: [] },
};
const SHARES = [
    { principalType: 'user', principalId: 'ed', role: 'edit' },
    { principalType: 'user', principalId: 'vic', role: 'view' },
];
const published = (over) => ({ is_published: 1, published_version: 1, organization_id: 'org1', shared_groups: [], ...over });
const AGENTS = {
    mine: published({ id: 'mine', name: 'Owner agent', owner_id: 'owner' }),
    eds: published({ id: 'eds', name: 'Ed agent', owner_id: 'ed' }),
};

let bindings;
let writes;
let api;

before(() => {
    const store = {
        getAutomation: async (id) => (id === 'a1'
            ? { id: 'a1', userId: 'owner', organizationId: 'org1', kind: 'automation', definition: { trigger: { kind: 'agent_call', toolName: 'send_invoice' } } }
            : null),
        listSharesForAutomation: async () => SHARES,
        listBindingsForAutomation: async () => bindings.map((agentId) => ({ agentId })),
        applyAgentBindings: async (id, change, by) => {
            writes.push({ id, ...change, by });
            bindings = bindings.filter((x) => !(change.remove || []).includes(x)).concat((change.add || []).filter((x) => !bindings.includes(x)));
            return bindings.map((agentId) => ({ agentId }));
        },
        listAutomationsBoundToAgent: async (agentId) => (bindings.includes(agentId) ? [{ id: 'a1' }] : []),
    };
    api = serve('/', makeAgentBindingsRouter({
        store,
        getUser: async (id) => USERS[id] || null,
        hasPermission: async () => false,
        userStore: { getUser: async (id) => USERS[id] || null },
        agentStore: {
            getForRuntime: async (id) => (AGENTS[id] ? { ...AGENTS[id] } : null),
            getAgents: async (userId) => Object.values(AGENTS).filter((a) => a.owner_id === userId),
            getPublishedAgentsForUser: async () => Object.values(AGENTS),
        },
        agentAccess: makeAgentAccess({
            hasPermission: async () => false,
            resolveUserOrgIds: async () => new Set(['org1']),
            getUser: async (id) => USERS[id] || null,
            roles: () => ({ SystemRoles: { SUPER_ADMIN: 'admin' }, OrgRoles: { AGENT_EDITOR: 'agent_editor' } }),
        }),
    }));
});
after(() => api.close());
beforeEach(() => { bindings = []; writes = []; });

const call = (method, path, { as = 'owner', body } = {}) => api.call(method, path, { body, user: { id: as, organizationId: 'org1' } });

test('PUT validates the body before anything is read or written', async () => {
    for (const body of [undefined, {}, { agentIds: 'mine' }, { agentIds: [1] }, { agentIds: [''] }, { agentIds: ['mine'], extra: true }]) {
        const res = await call('PUT', '/a1/agent-bindings', { body: body === undefined ? {} : body });
        assertRefused(assert, res);
    }
    const tooMany = await call('PUT', '/a1/agent-bindings', { body: { agentIds: Array.from({ length: 51 }, (_, i) => `a${i}`) } });
    assertRefused(assert, tooMany, 'body.agentIds');
    assert.deepStrictEqual(writes, []);
});

test('GET lists the links as the viewer may see them, with what they may add', async () => {
    bindings = ['mine', 'eds'];
    const res = await call('GET', '/a1/agent-bindings', { as: 'ed' });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.bindings.map((b) => [b.agentId, b.name, b.canEdit]), [[null, null, false], ['eds', 'Ed agent', true]]);
    assert.strictEqual(res.body.canManage, true);
    assert.strictEqual(res.body.isAgentCall, true);
    assert.strictEqual(res.body.toolName, 'send_invoice');
    assert.ok(!res.text.includes('Owner agent'), 'the name of an agent the viewer cannot edit is not in the answer');
});

test('GET: view rights are enough to read, a stranger is refused, an unknown automation is 404', async () => {
    assert.strictEqual((await call('GET', '/a1/agent-bindings', { as: 'vic' })).body.canManage, false);
    const stranger = await call('GET', '/a1/agent-bindings', { as: 'stranger' });
    assert.strictEqual(stranger.status, 403);
    assert.strictEqual(stranger.body.code, 'automation_forbidden');
    assert.strictEqual((await call('GET', '/nope/agent-bindings')).status, 404);
    assert.strictEqual((await call('PUT', '/nope/agent-bindings', { body: { agentIds: [] } })).status, 404);
});

test('PUT: the owner links an agent and gets the listing back', async () => {
    const res = await call('PUT', '/a1/agent-bindings', { body: { agentIds: ['mine'] } });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(writes, [{ id: 'a1', add: ['mine'], remove: [], by: 'owner' }]);
    assert.deepStrictEqual(res.body.bindings.map((b) => b.agentId), ['mine']);
    assert.strictEqual(res.body.kept, 0);
});

test('PUT: a view-only sharee and a stranger cannot link, and nothing is written', async () => {
    for (const as of ['vic', 'stranger']) {
        const res = await call('PUT', '/a1/agent-bindings', { as, body: { agentIds: ['eds'] } });
        assert.strictEqual(res.status, 403, as);
        assert.strictEqual(res.body.code, 'automation_forbidden', as);
    }
    assert.deepStrictEqual(writes, []);
});

test('PUT: an editor needs edit rights on the agent; unknown and not-yours read the same', async () => {
    const notEditable = await call('PUT', '/a1/agent-bindings', { as: 'ed', body: { agentIds: ['mine'] } });
    const unknown = await call('PUT', '/a1/agent-bindings', { as: 'ed', body: { agentIds: ['no-such-agent'] } });
    for (const res of [notEditable, unknown]) {
        assert.strictEqual(res.status, 403);
        assert.strictEqual(res.body.code, 'agent_not_linkable');
        assert.strictEqual(res.body.error, notEditable.body.error);
    }
    const ok = await call('PUT', '/a1/agent-bindings', { as: 'ed', body: { agentIds: ['eds'] } });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(writes.length, 1);
});

test('PUT: leaves a link the caller cannot edit alone and says so', async () => {
    bindings = ['mine'];
    const res = await call('PUT', '/a1/agent-bindings', { as: 'ed', body: { agentIds: [] } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.kept, 1);
    assert.deepStrictEqual(writes, []);
    assert.deepStrictEqual(bindings, ['mine']);
});

test('GET /by-agent/:agentId/automation-ids: the automations linked to an agent the viewer may edit', async () => {
    bindings = ['eds'];
    const res = await call('GET', '/by-agent/eds/automation-ids', { as: 'ed' });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { automationIds: ['a1'] });
    const notTheirs = await call('GET', '/by-agent/eds/automation-ids', { as: 'stranger' });
    const unknown = await call('GET', '/by-agent/no-such-agent/automation-ids', { as: 'ed' });
    for (const r of [notTheirs, unknown]) {
        assert.strictEqual(r.status, 404);
        assert.strictEqual(r.body.code, 'not_found');
    }
});

test('the router is mounted under /api/automation', () => {
    const src = require('node:fs').readFileSync(require.resolve('../automation.js'), 'utf8');
    assert.match(src, /require\('\.\/automation\/agentBindings'\)\.makeAgentBindingsRouter\(\)/);
});
