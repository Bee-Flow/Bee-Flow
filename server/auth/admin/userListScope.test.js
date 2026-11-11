/**
 * auth/admin/userListScope.mts: who may list users, and the admin dashboard's
 * `?scope=admin` list, built with fake collaborators. The routes over it:
 * listRoutes.adminScope.test.js.
 * Run: cd server && node --test auth/admin/userListScope.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createUserListScope, membersOfOrg } = require('./userListScope.mts');

const GROUPS = [{ id: 'g-a', organizationId: 'org-a' }, { id: 'g-b', organizationId: 'org-b' }];
const USERS = [
    { id: 'homeA', organizationId: 'org-a', groups: [] },
    { id: 'groupA', organizationId: 'org-b', groups: '["g-a"]' },
    { id: 'homeB', organizationId: 'org-b', groups: ['g-b'] },
    { id: 'garbled', organizationId: 'org-c', groups: '{not json' },
    { id: 'objectGroups', organizationId: 'org-c', groups: '{"g-a":true}' },
    { id: 'system', organizationId: 'org-a', groups: [], isSystem: true },
];
const isOperator = (u) => !!u.isSystem;

test('the members of an organisation: home organisation or one of its groups, never the system row', () => {
    assert.deepEqual(membersOfOrg(USERS, GROUPS, 'org-a', isOperator).map((u) => u.id), ['homeA', 'groupA']);
    assert.deepEqual(membersOfOrg(USERS, GROUPS, 'org-b', isOperator).map((u) => u.id), ['groupA', 'homeB']);
    assert.deepEqual(membersOfOrg(USERS, GROUPS, 'org-x', isOperator), []);
});

function build({ perms = [], adminOrgId = null } = {}) {
    const calls = { resolve: 0 };
    const scope = createUserListScope({
        getUserPermissions: async () => perms,
        resolveAdminOrgId: async () => { calls.resolve++; return adminOrgId; },
        getAllUsers: async () => USERS,
        getAllGroups: async () => GROUPS,
        isPlatformOperator: isOperator,
        stripKeyMaterial: (u) => ({ id: u.id }),
    });
    return { ...scope, calls };
}

const req = (session, query = {}) => ({ session: { isAuthenticated: true, user: { id: 'me' }, ...session }, query });

test('a platform admin may list users; anyone else needs a user-management permission', async () => {
    assert.equal(await build().mayViewUsers(req({ isAdmin: true })), true);
    assert.equal(await build().mayViewUsers(req({ user: { id: 'me', role: 'admin' } })), true);
    for (const p of ['all', 'manage_users', 'admin_security', 'org_admin']) {
        assert.equal(await build({ perms: [p] }).mayViewUsers(req({})), true, p);
    }
    assert.equal(await build({ perms: ['page_chat'] }).mayViewUsers(req({})), false);
});

test('without scope=admin the resolver is not asked and the caller keeps the unscoped list', async () => {
    const scope = build({ adminOrgId: 'org-a' });
    assert.equal(await scope.adminScopedUsers(req({}, { scope: 'other' })), null);
    assert.equal(scope.calls.resolve, 0);
});

test('scope=admin: the resolved organisation\'s members, stripped; null (all organisations) keeps the full list', async () => {
    assert.deepEqual(await build({ adminOrgId: 'org-a' }).adminScopedUsers(req({}, { scope: 'admin' })), [{ id: 'homeA' }, { id: 'groupA' }]);
    assert.equal(await build({ adminOrgId: null }).adminScopedUsers(req({}, { scope: 'admin' })), null);
});

test('a refusal of the resolver reaches the caller', async () => {
    const scope = createUserListScope({
        getUserPermissions: async () => [],
        resolveAdminOrgId: async () => { throw Object.assign(new Error('Organization admin access required'), { status: 403 }); },
        getAllUsers: async () => USERS,
        getAllGroups: async () => GROUPS,
        isPlatformOperator: isOperator,
        stripKeyMaterial: (u) => u,
    });
    await assert.rejects(scope.adminScopedUsers(req({}, { scope: 'admin' })), (e) => e.status === 403);
});
