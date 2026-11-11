/**
 * auth/permissionsOrgGates.js resolveAdminOrgIds: the organisations the caller
 * administers, by the _evalOrgAdmin rule, among the organisations they belong
 * to.
 *
 * Proven: an admin orgRole counts in the home organisation only; plain
 * membership of a group in another organisation adds nothing; a group IN an
 * organisation that carries admin rights makes its members admins there; no
 * session or no user is no organisation.
 *
 * Run: cd server && node --test auth/resolveAdminOrgIds.test.js
 */

process.env.NODE_ENV = 'test';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// The collaborators go in through the permissions modules' own seam
// (auth/permissionsDeps.js), the one auth/permissions.js wires in production.
const fx = { users: {}, groups: [] };
const fakeUserStore = {
    getUser: async (/** @type {string} */ id) => fx.users[id] || null,
    getAllGroups: async () => fx.groups,
};
require('./permissionsDeps').wireDeps({
    userStore: () => fakeUserStore,
    orgScope: () => async () => ({ orgIds: new Set(), orgId: null, homeOrgId: null, isSuperAdmin: false, identityError: null }),
});
const { resolveAdminOrgIds } = require('./permissionsOrgGates');

const req = (/** @type {string} */ id) => ({ session: { user: { id } } });

beforeEach(() => { fx.users = {}; fx.groups = []; });

test('an org admin of A who is a plain group member of B administers A only', async () => {
    fx.users.oa = { id: 'oa', orgRole: 'org_admin', organizationId: 'orgA', groups: JSON.stringify(['gB']) };
    fx.groups = [{ id: 'gB', organizationId: 'orgB', permissions: ['use_forms'] }];
    assert.deepEqual(await resolveAdminOrgIds(req('oa')), new Set(['orgA']));
});

test('the legacy admin orgRole counts at home', async () => {
    fx.users.la = { id: 'la', orgRole: 'admin', organizationId: 'orgA', groups: [] };
    assert.deepEqual(await resolveAdminOrgIds(req('la')), new Set(['orgA']));
});

test('a group IN an organisation that carries admin rights makes its members admins there', async () => {
    fx.users.m = { id: 'm', orgRole: 'member', organizationId: 'orgA', groups: ['gB', 'gC'] };
    fx.groups = [
        { id: 'gB', organizationId: 'orgB', roles: ['org_admin'] },
        { id: 'gC', organizationId: 'orgC', permissions: ['manage_agents'] },
    ];
    assert.deepEqual(await resolveAdminOrgIds(req('m')), new Set(['orgB']));
});

test('a member, no session or no user administers nothing', async () => {
    fx.users.m = { id: 'm', orgRole: 'member', organizationId: 'orgA', groups: 'not json' };
    assert.deepEqual(await resolveAdminOrgIds(req('m')), new Set());
    assert.deepEqual(await resolveAdminOrgIds(req('nobody')), new Set());
    assert.deepEqual(await resolveAdminOrgIds({ session: {} }), new Set());
});
