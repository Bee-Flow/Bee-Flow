/**
 * auth/agentAccess.mts: the agent access rules and the two gates, with every
 * dependency injected. The edit rule's own matrix is core/agentRuntime/agentAccess.test.js
 * and routes/agents/crud.authz.test.js; here: the ladder (whoever may edit may
 * read; manage is the owner, the super admin or an organisation admin at home
 * in the agent's organisation), the chat audience, the gates' answers (404 for
 * no grade and for an unknown id alike, 403 below the grade, the turn routes'
 * 401/403), what a gate leaves on the request, and the per-request memo.
 *
 * Run: cd server && node --test auth/agentAccess.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeAgentAccess, gradeAtLeast, agentAccessOf } = require('./agentAccess.mts');
const { readGate } = require('./gateMeta');

const ROLES = () => ({ SystemRoles: { SUPER_ADMIN: 'admin' }, OrgRoles: { AGENT_EDITOR: 'agent_editor' } });

/**
 * `manageIn`: the organisations in which the caller holds manage_agents (default orgA);
 * `orgIds`: resolveUserOrgIds (default orgA; null = super admin); `groups`: the caller's
 * group ids; `user`: the user row; `agents`: the store by id; `published`: canSeePublished's answer.
 */
function access(fx = {}) {
    const calls = { permission: 0, orgs: 0, groups: 0, user: 0, getAgent: 0 };
    const manageIn = new Set(fx.manageIn ?? ['orgA']);
    const agents = fx.agents ?? {};
    const warnings = [];
    const a = makeAgentAccess({
        getAgent: async (id) => { calls.getAgent++; return agents[id] || null; },
        getAgentViews: async (id) => (agents[id] ? { draft: agents[id], runtime: { ...agents[id], runtimeSource: 'live' } } : null),
        getEffectiveUserId: (req) => req.session?.user?.id || 'guest_1',
        resolvePermissionsByOrg: async () => {
            calls.permission++;
            return { holds: (perm, orgId) => perm === 'manage_agents' && !!orgId && manageIn.has(orgId) };
        },
        resolveUserOrgIds: async () => { calls.orgs++; return 'orgIds' in fx ? fx.orgIds : new Set(['orgA']); },
        resolveUserGroups: async () => { calls.groups++; return fx.groups ?? []; },
        canSeePublished: () => fx.published ?? false,
        getUser: async () => { calls.user++; return 'user' in fx ? fx.user : { organizationId: 'orgA', orgRole: 'org_admin' }; },
        roles: ROLES,
        isOrgAdminRole: (role) => role === 'org_admin',
        warn: (m) => warnings.push(m),
    });
    return { a, calls, warnings };
}
const req = (session = {}, params = { id: 'a1' }) => ({ session: { user: { id: 'me' }, ...session }, params });
const anon = (params = { id: 'a1' }) => ({ session: {}, params });
const agent = (over = {}) => ({ id: 'a1', owner_id: 'someone', organization_id: 'orgA', is_published: true, ...over });

/** Dispatch a gate and capture its answer. */
async function run(gate, r) {
    const out = { status: 200, body: null, next: false };
    const res = { status(c) { out.status = c; return { json(b) { out.body = b; return out; } }; } };
    await gate(r, res, () => { out.next = true; });
    return out;
}

// ── The ladder ────────────────────────────────────────────────────────

test('read: the owner, a system or swarm agent, the published audience; nothing else', async () => {
    const { a } = access();
    assert.equal(await a.canReadAgent(agent({ owner_id: 'me' }), 'me', req()), true);
    assert.equal(await a.canReadAgent(agent({ owner_id: 'system' }), 'me', req()), true);
    assert.equal(await a.canReadAgent(agent({ owner_id: 'swarm' }), 'me', req()), true);
    assert.equal(await a.canReadAgent(agent(), 'me', req()), false);
    assert.equal(await access({ published: true }).a.canReadAgent(agent(), 'me', req()), true);
    assert.equal(await a.canReadAgent(null, 'me', req()), false);
});

test('whoever may edit may read: an organisation admin reads a colleague\'s draft they may edit', async () => {
    const { a } = access();
    assert.equal(await a.gradeOf(req(), agent({ is_published: false })), 'manage');
    assert.equal(await access({ manageIn: [], user: { organizationId: 'orgA', orgRole: 'member' } }).a.gradeOf(req(), agent({ is_published: false })), null);
});

test('the grades: read for the audience, edit for manage_agents, manage for the owner, the super admin or the home organisation admin', async () => {
    assert.equal(await access({ published: true, manageIn: [] }).a.gradeOf(req(), agent()), 'read');
    assert.equal(await access({ user: { organizationId: 'orgA', orgRole: 'agent_editor' } }).a.gradeOf(req(), agent()), 'edit');
    assert.equal(await access({ user: { organizationId: 'orgB', orgRole: 'org_admin' }, orgIds: new Set(['orgA', 'orgB']) }).a.gradeOf(req(), agent()), 'edit',
        'an admin of another organisation who may edit through manage_agents does not manage the agent');
    assert.equal(await access().a.gradeOf(req(), agent()), 'manage');
    assert.equal(await access({ manageIn: [] }).a.gradeOf(req(), agent({ owner_id: 'me' })), 'manage');
    assert.equal(await access({ manageIn: [], orgIds: null }).a.gradeOf(req({ isAdmin: true }), agent()), 'manage');
    assert.equal(await access({ manageIn: [] }).a.gradeOf(req(), agent({ organization_id: null })), null, 'an agent without an organisation is its owner\'s');
});

test('gradeOf never looks beyond `upTo`: a read-only route spends no permission lookup on a reader', async () => {
    const { a, calls } = access({ published: true });
    assert.equal(await a.gradeOf(req(), agent(), 'read'), 'read');
    assert.equal(calls.permission, 0);
    assert.equal(await a.gradeOf(req(), agent(), 'manage'), 'manage');
    assert.equal(calls.permission, 1);
});

test('gradeAtLeast orders the ladder', () => {
    assert.equal(gradeAtLeast('manage', 'read'), true);
    assert.equal(gradeAtLeast('read', 'edit'), false);
    assert.equal(gradeAtLeast(null, 'read'), false);
});

// ── The chat audience ────────────────────────────────────────────────

test('chat: a published agent only; the owner; a member of its organisation; someone in no organisation reaches a published agent in none', async () => {
    const { a } = access();
    assert.equal(await a.canChatAgent(agent({ is_published: false, owner_id: 'me' }), 'me', req()), false);
    assert.equal(await a.canChatAgent(agent({ owner_id: 'me' }), 'me', req()), true);
    assert.equal(await a.canChatAgent(agent(), 'me', req()), true);
    assert.equal(await a.canChatAgent(agent({ organization_id: 'orgB' }), 'me', req()), false);
    assert.equal(await a.canChatAgent(agent({ organization_id: null }), 'me', req()), false, 'a member reaches no agent outside an organisation');
    const nobody = access({ orgIds: new Set(), user: null });
    assert.equal(await nobody.a.canChatAgent(agent({ organization_id: null }), 'guest_1', anon()), true);
    assert.equal(await nobody.a.canChatAgent(agent(), 'guest_1', anon()), false);
});

test('chat: a shared group narrows the audience; the super admin is a member of their home organisation, not a bypass', async () => {
    assert.equal(await access({ groups: ['g1'] }).a.canChatAgent(agent({ shared_groups: ['g1'] }), 'me', req()), true);
    assert.equal(await access({ groups: ['g2'] }).a.canChatAgent(agent({ shared_groups: ['g1'] }), 'me', req()), false);
    assert.equal(await access({ groups: ['g1'] }).a.canChatAgent(agent({ shared_groups: '["g1"]' }), 'me', req()), true, 'a raw row carries the groups as JSON');
    const admin = access({ orgIds: null, user: { organizationId: 'orgA' } });
    assert.equal(await admin.a.canChatAgent(agent(), 'me', req({ isAdmin: true })), true);
    assert.equal(await admin.a.canChatAgent(agent({ organization_id: 'orgB' }), 'me', req({ isAdmin: true })), false);
});

// ── The gates ─────────────────────────────────────────────────────────

test('requireAgentGrade: an unknown id and an agent the caller holds no grade on answer the same 404', async () => {
    const { a } = access({ agents: { a1: agent() }, manageIn: [] });
    const gate = a.requireAgentGrade('read');
    const unknown = await run(gate, req({}, { id: 'nope' }));
    const foreign = await run(gate, req());
    assert.deepEqual([unknown.status, unknown.body], [404, { error: 'Agent not found' }]);
    assert.deepEqual([foreign.status, foreign.body], [unknown.status, unknown.body]);
    assert.equal(foreign.next, false);
});

test('requireAgentGrade: below the grade is the structured 403; at the grade the handler runs with req.agentAccess', async () => {
    const { a } = access({ agents: { a1: agent() }, published: true, manageIn: [] });
    const refused = await run(a.requireAgentGrade('edit'), req());
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'agent_not_editable');
    const r = req();
    const passed = await run(a.requireAgentGrade('read', { views: true }), r);
    assert.equal(passed.next, true);
    const left = agentAccessOf(r);
    assert.equal(left.agent.id, 'a1');
    assert.equal(left.grade, 'read');
    assert.equal(left.userId, 'me');
    assert.equal(left.views.runtime.runtimeSource, 'live');
    assert.throws(() => agentAccessOf(req()), /agent gate missing/);
});

test('requireAgentGrade: manage has its own refusal, and `param` names the path parameter', async () => {
    const { a } = access({ agents: { a1: agent() }, user: { organizationId: 'orgA', orgRole: 'agent_editor' } });
    const refused = await run(a.requireAgentGrade('manage', { param: 'agentId' }), req({}, { agentId: 'a1' }));
    assert.equal(refused.status, 403);
    assert.match(refused.body.error, /transfer/);
    const owner = await run(a.requireAgentGrade('manage', { param: 'agentId' }), req({ user: { id: 'someone' } }, { agentId: 'a1' }));
    assert.equal(owner.next, true);
});

test('the gates are tagged scoped, with the grade, so the route contract can read them', () => {
    const { a } = access();
    assert.deepEqual(readGate(a.requireAgentGrade('edit')), { axis: 'scoped', minGrade: 'edit', param: 'id' });
    assert.deepEqual(readGate(a.requireAgentChat()), { axis: 'scoped', minGrade: 'chat', param: 'id' });
});

test('requireAgentChat: 404 unknown; a visitor gets 401 on a draft and on a published agent without a public page alike; a stranger 403 on a draft', async () => {
    const draft = agent({ is_published: false });
    const noPage = agent({ embed_enabled: false });
    for (const [row, who] of [[draft, anon()], [noPage, anon()]]) {
        const { a } = access({ agents: { a1: row } });
        const out = await run(a.requireAgentChat(), who);
        assert.deepEqual([out.status, out.body], [401, { error: 'Not authenticated' }]);
    }
    assert.equal((await run(access({ agents: {} }).a.requireAgentChat(), req())).status, 404);
    const stranger = await run(access({ agents: { a1: draft } }).a.requireAgentChat(), req());
    assert.deepEqual([stranger.status, stranger.body], [403, { error: 'Access denied' }]);
    const owner = await run(access({ agents: { a1: draft } }).a.requireAgentChat(), req({ user: { id: 'someone' } }));
    assert.equal(owner.next, true);
});

test('requireAgentChat: a visitor takes a turn with a published agent in no organisation whose owner switched Web embed on; outside the audience is 403 with a warning of ids only', async () => {
    const visitor = access({ agents: { a1: agent({ organization_id: null, embed_enabled: true }) }, orgIds: new Set(), user: null });
    const r = anon();
    const out = await run(visitor.a.requireAgentChat(), r);
    assert.equal(out.next, true);
    assert.equal(agentAccessOf(r).grade, 'chat');
    assert.match(agentAccessOf(r).userId, /^guest_/);
    const outside = access({ agents: { a1: agent({ organization_id: 'orgB' }) } });
    const refused = await run(outside.a.requireAgentChat(), req());
    assert.deepEqual([refused.status, refused.body], [403, { error: 'Access denied' }]);
    assert.equal(outside.warnings.length, 1);
    assert.match(outside.warnings[0], /user me .* agent a1/);
});

// ── The memo ──────────────────────────────────────────────────────────

test('the per-request lookups are made once per request, so a list asks about many agents for one set of reads', async () => {
    const { a, calls } = access({ published: true });
    const r = req();
    for (const id of ['a1', 'a2', 'a3']) await a.gradeOf(r, agent({ id }));
    assert.deepEqual([calls.orgs, calls.groups, calls.permission, calls.user], [1, 1, 1, 1]);
    await a.gradeOf(req(), agent());
    assert.equal(calls.permission, 2, 'a new request reads again');
});
