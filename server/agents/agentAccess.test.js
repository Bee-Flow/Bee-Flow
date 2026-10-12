/**
 * agents/agentAccess.js: the agent edit gate, extracted from routes/agents/crud.js
 * so code below routes/ can ask it. routes/agents/crud.authz.test.js pins the
 * same rules through the router; this pins them on the module itself, with every
 * dependency injected, plus what the extraction must not change: the owner is
 * answered before any lookup, and a prefetched context is used instead of new
 * lookups.
 *
 * Run: cd server && node --test agents/agentAccess.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { makeAgentAccess } = require('./agentAccess');

function access(fx = {}) {
    const calls = { permission: 0, orgs: 0, user: 0 };
    const gate = makeAgentAccess({
        hasPermission: async () => { calls.permission++; return fx.hasManage ?? true; },
        resolveUserOrgIds: async () => { calls.orgs++; return 'orgIds' in fx ? fx.orgIds : new Set(['orgA']); },
        getUser: async () => { calls.user++; return fx.user ?? { orgRole: 'org_admin' }; },
        roles: () => ({ SystemRoles: { SUPER_ADMIN: 'admin' }, OrgRoles: { AGENT_EDITOR: 'agent_editor' } }),
    });
    return { gate, calls };
}
const req = (session = {}) => ({ session: { user: { id: 'me' }, ...session } });
const agent = (over = {}) => ({ id: 'a1', owner_id: 'someone', organization_id: 'orgA', is_published: 1, ...over });

test('the owner is answered first, without a single lookup', async () => {
    const { gate, calls } = access({ hasManage: false });
    assert.strictEqual(await gate.canModifyAgent(agent({ owner_id: 'me' }), 'me', req()), true);
    assert.deepStrictEqual(calls, { permission: 0, orgs: 0, user: 0 });
});

test('a super admin may edit anything', async () => {
    const { gate } = access({ hasManage: false });
    assert.strictEqual(await gate.canModifyAgent(agent(), 'me', req({ isAdmin: true })), true);
    assert.strictEqual(await gate.canModifyAgent(agent(), 'me', { session: { user: { id: 'me', role: 'admin' } } }), true);
});

test('anyone else needs manage_agents AND the agent\'s organisation', async () => {
    assert.strictEqual(await access({ hasManage: true }).gate.canModifyAgent(agent(), 'me', req()), true);
    assert.strictEqual(await access({ hasManage: false }).gate.canModifyAgent(agent(), 'me', req()), false);
    assert.strictEqual(await access({ orgIds: new Set(['orgB']) }).gate.canModifyAgent(agent(), 'me', req()), false);
    assert.strictEqual(await access().gate.canModifyAgent(agent({ organization_id: null }), 'me', req()), false, 'org-less agents are the owner\'s');
    assert.strictEqual(await access({ orgIds: null }).gate.canModifyAgent(agent(), 'me', req()), false, 'a degenerate context never widens');
});

test('an agent editor cannot edit another person\'s unpublished draft', async () => {
    const { gate } = access({ user: { orgRole: 'agent_editor' } });
    assert.strictEqual(await gate.canModifyAgent(agent({ is_published: 0 }), 'me', req()), false);
    assert.strictEqual(await gate.canModifyAgent(agent({ is_published: 1 }), 'me', req()), true);
});

test('a prefetched context saves the lookups; a failing user read does not fail the gate', async () => {
    const { gate, calls } = access();
    const ctx = await gate.buildCanModifyContext('me', req());
    assert.deepStrictEqual(calls, { permission: 1, orgs: 1, user: 1 });
    for (let i = 0; i < 3; i++) await gate.canModifyAgent(agent(), 'me', req(), ctx);
    assert.deepStrictEqual(calls, { permission: 1, orgs: 1, user: 1 });

    const broken = makeAgentAccess({
        hasPermission: async () => true,
        resolveUserOrgIds: async () => { throw new Error('down'); },
        getUser: async () => { throw new Error('down'); },
        roles: () => ({ SystemRoles: { SUPER_ADMIN: 'admin' }, OrgRoles: { AGENT_EDITOR: 'agent_editor' } }),
    });
    const c = await broken.buildCanModifyContext('me', req());
    assert.strictEqual(c.orgIds.size, 0);
    assert.strictEqual(c.user, null);
    assert.deepStrictEqual(await broken.buildCanModifyContext(null, req()), { hasManage: false, orgIds: new Set(), user: null });
});
