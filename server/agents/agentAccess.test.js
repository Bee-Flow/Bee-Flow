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

const ROLES = () => ({ SystemRoles: { SUPER_ADMIN: 'admin' }, OrgRoles: { AGENT_EDITOR: 'agent_editor' } });

/**
 * `manageIn`: the organisations in which the caller holds manage_agents
 * (default: orgA, the agent's organisation).
 */
function access(fx = {}) {
    const calls = { permission: 0, orgs: 0, user: 0 };
    const manageIn = new Set(fx.manageIn ?? ['orgA']);
    const gate = makeAgentAccess({
        resolvePermissionsByOrg: async () => {
            calls.permission++;
            return { holds: (perm, orgId) => perm === 'manage_agents' && !!orgId && manageIn.has(orgId) };
        },
        resolveUserOrgIds: async () => { calls.orgs++; return 'orgIds' in fx ? fx.orgIds : new Set(['orgA']); },
        getUser: async () => { calls.user++; return fx.user ?? { orgRole: 'org_admin' }; },
        roles: ROLES,
    });
    return { gate, calls };
}
const req = (session = {}) => ({ session: { user: { id: 'me' }, ...session } });
const agent = (over = {}) => ({ id: 'a1', owner_id: 'someone', organization_id: 'orgA', is_published: 1, ...over });

test('the owner is answered first, without a single lookup', async () => {
    const { gate, calls } = access({ manageIn: [] });
    assert.strictEqual(await gate.canModifyAgent(agent({ owner_id: 'me' }), 'me', req()), true);
    assert.deepStrictEqual(calls, { permission: 0, orgs: 0, user: 0 });
});

test('a super admin may edit anything', async () => {
    const { gate } = access({ manageIn: [] });
    assert.strictEqual(await gate.canModifyAgent(agent(), 'me', req({ isAdmin: true })), true);
    assert.strictEqual(await gate.canModifyAgent(agent(), 'me', { session: { user: { id: 'me', role: 'admin' } } }), true);
});

test('anyone else needs manage_agents AND the agent\'s organisation', async () => {
    assert.strictEqual(await access().gate.canModifyAgent(agent(), 'me', req()), true);
    assert.strictEqual(await access({ manageIn: [] }).gate.canModifyAgent(agent(), 'me', req()), false);
    assert.strictEqual(await access({ orgIds: new Set(['orgB']) }).gate.canModifyAgent(agent(), 'me', req()), false);
    assert.strictEqual(await access().gate.canModifyAgent(agent({ organization_id: null }), 'me', req()), false, 'org-less agents are the owner\'s');
    assert.strictEqual(await access({ orgIds: null }).gate.canModifyAgent(agent(), 'me', req()), false, 'a degenerate context never widens');
});

test('manage_agents held in another organisation does not reach a member organisation\'s agent', async () => {
    // Admin of A, plain group member of B: B's agents are not theirs to edit.
    const both = new Set(['orgA', 'orgB']);
    const { gate } = access({ orgIds: both, manageIn: ['orgA'] });
    assert.strictEqual(await gate.canModifyAgent(agent({ organization_id: 'orgB' }), 'me', req()), false);
    assert.strictEqual(await gate.canModifyAgent(agent({ organization_id: 'orgA' }), 'me', req()), true);
    // The right held in B itself (for example through a group of B) does count.
    assert.strictEqual(await access({ orgIds: both, manageIn: ['orgB'] }).gate.canModifyAgent(agent({ organization_id: 'orgB' }), 'me', req()), true);
});

test('an agent editor cannot edit another person\'s unpublished draft', async () => {
    const { gate } = access({ user: { orgRole: 'agent_editor' } });
    assert.strictEqual(await gate.canModifyAgent(agent({ is_published: 0 }), 'me', req()), false);
    assert.strictEqual(await gate.canModifyAgent(agent({ is_published: 1 }), 'me', req()), true);
});

test('a prefetched context saves the lookups; a failing read does not fail the gate and grants nothing', async () => {
    const { gate, calls } = access();
    const ctx = await gate.buildCanModifyContext('me', req());
    assert.deepStrictEqual(calls, { permission: 1, orgs: 1, user: 1 });
    for (let i = 0; i < 3; i++) await gate.canModifyAgent(agent(), 'me', req(), ctx);
    assert.deepStrictEqual(calls, { permission: 1, orgs: 1, user: 1 });

    const broken = makeAgentAccess({
        resolvePermissionsByOrg: async () => { throw new Error('down'); },
        resolveUserOrgIds: async () => { throw new Error('down'); },
        getUser: async () => { throw new Error('down'); },
        roles: ROLES,
    });
    const c = await broken.buildCanModifyContext('me', req());
    assert.strictEqual(c.orgIds.size, 0);
    assert.strictEqual(c.user, null);
    assert.strictEqual(c.permissions.holds('manage_agents', 'orgA'), false);
    const none = await broken.buildCanModifyContext(null, req());
    assert.deepStrictEqual({ orgIds: none.orgIds, user: none.user }, { orgIds: new Set(), user: null });
    assert.strictEqual(none.permissions.holds('manage_agents', 'orgA'), false);

    const noPermissions = makeAgentAccess({
        resolvePermissionsByOrg: async () => { throw new Error('down'); },
        resolveUserOrgIds: async () => new Set(['orgA']),
        getUser: async () => ({ orgRole: 'org_admin' }),
        roles: ROLES,
    });
    assert.strictEqual(await noPermissions.canModifyAgent(agent(), 'me', req()), false);
});
