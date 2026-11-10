/**
 * auth/permissionGrants.mts and its store-backed form in permissionsResolve.js
 * (resolvePermissionsByOrg, hasPermissionInOrg): which organisation each of a
 * user's permissions holds in.
 *
 * Proven:
 *   - a group's permissions, capability grants and roles hold in the GROUP's
 *     organisation; a group without one, the direct role and the orgRole hold
 *     in the home organisation; a group's orgRole resolves and holds in the
 *     group's organisation;
 *   - 'all' in a grant covers every permission in that organisation only;
 *   - an absent organisation never holds; a platform admin holds everywhere;
 *   - a store error holds nowhere;
 *   - the flat getUserPermissions answer is the union of the same grants.
 *
 * Run: cd server && node --test auth/permissionGrants.test.js
 */

process.env.NODE_ENV = 'test';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { collectPermissionGrants, permissionsOfGrants, grantsHoldInOrg } = require('./permissionGrants.mts');

// ── The pure collector ──────────────────────────────────────────────────────

/** @param {Record<string, any>} [over] */
function sources(over = {}) {
    return {
        groupIds: [],
        allGroups: [],
        allRoles: [],
        impliedByCapability: { meeting_notes: ['use_meeting_notes'] },
        normaliseOrgRole: (/** @type {unknown} */ r) => (typeof r === 'string' && r ? (r === 'admin' ? 'org_admin' : r) : null),
        permsForRoleInOrg: async (/** @type {string} */ role, /** @type {unknown} */ orgId) => ({
            org_admin: ['manage_agents', 'manage_knowledge'],
            agent_editor: [`edit_in_${orgId}`],
        })[role] || null,
        orgWideGrants: async () => [],
        ...over,
    };
}

test('a group grant holds in the group\'s organisation, the orgRole in the home organisation', async () => {
    const grants = await collectPermissionGrants(
        { orgRole: 'member', organizationId: 'orgA' },
        sources({
            groupIds: ['gB'],
            allGroups: [{ id: 'gB', organizationId: 'orgB', permissions: ['manage_agents'] }],
            permsForRoleInOrg: async (/** @type {string} */ role) => (role === 'member' ? ['use_forms'] : null),
        }),
    );
    assert.deepEqual(grants, [
        { orgId: 'orgB', permissions: ['manage_agents'] },
        { orgId: 'orgA', permissions: ['use_forms'] },
    ]);
    assert.equal(grantsHoldInOrg(grants, 'manage_agents', 'orgB'), true);
    assert.equal(grantsHoldInOrg(grants, 'manage_agents', 'orgA'), false);
    assert.equal(grantsHoldInOrg(grants, 'use_forms', 'orgA'), true);
    assert.equal(grantsHoldInOrg(grants, 'use_forms', 'orgB'), false);
});

test('an org_admin of A who is a plain member of a group in B holds manage_agents in A only', async () => {
    const grants = await collectPermissionGrants(
        { orgRole: 'org_admin', organizationId: 'orgA' },
        sources({ groupIds: ['gB'], allGroups: [{ id: 'gB', organizationId: 'orgB', permissions: ['use_forms'] }] }),
    );
    assert.equal(grantsHoldInOrg(grants, 'manage_agents', 'orgA'), true);
    assert.equal(grantsHoldInOrg(grants, 'manage_agents', 'orgB'), false);
    assert.equal(grantsHoldInOrg(grants, 'use_forms', 'orgB'), true);
});

test('capability grants and group roles hold with their group; the direct role in the home organisation', async () => {
    const grants = await collectPermissionGrants(
        { role: 'light', organizationId: 'orgA' },
        sources({
            groupIds: ['gB', 'missing'],
            allGroups: [{ id: 'gB', organizationId: 'orgB', granted_capabilities: ['meeting_notes'], roles: ['r1', 'gone'] }],
            allRoles: [{ id: 'r1', permissions: ['manage_skills'] }, { id: 'light', permissions: ['use_apps'] }],
        }),
    );
    assert.deepEqual(grants, [
        { orgId: 'orgB', permissions: ['use_meeting_notes', 'manage_skills'] },
        { orgId: 'orgA', permissions: ['use_apps'] },
    ]);
});

test('a group without an organisation holds in the home organisation, or nowhere without one', async () => {
    const group = { id: 'g0', permissions: ['manage_agents'] };
    const homed = await collectPermissionGrants({ organizationId: 'orgA' }, sources({ groupIds: ['g0'], allGroups: [group] }));
    assert.equal(grantsHoldInOrg(homed, 'manage_agents', 'orgA'), true);

    const homeless = await collectPermissionGrants({ organizationId: '' }, sources({ groupIds: ['g0'], allGroups: [group] }));
    assert.deepEqual(homeless, [{ orgId: null, permissions: ['manage_agents'] }]);
    assert.equal(grantsHoldInOrg(homeless, 'manage_agents', 'orgA'), false);
    assert.equal(grantsHoldInOrg(homeless, 'manage_agents', null), false);
    assert.equal(grantsHoldInOrg(homeless, 'manage_agents', ''), false);
});

test('a group orgRole resolves and holds in the group\'s organisation', async () => {
    /** @type {unknown[]} */
    const asked = [];
    const grants = await collectPermissionGrants(
        { organizationId: 'orgA' },
        sources({
            groupIds: ['gB'],
            allGroups: [{ id: 'gB', organizationId: 'orgB', orgRole: 'agent_editor' }],
            permsForRoleInOrg: async (/** @type {string} */ role, /** @type {unknown} */ orgId) => { asked.push([role, orgId]); return [`edit_in_${orgId}`]; },
        }),
    );
    assert.deepEqual(asked, [['agent_editor', 'orgB']]);
    assert.deepEqual(grants, [{ orgId: 'orgB', permissions: ['edit_in_orgB'] }]);
});

test('\'all\' covers every permission, in its own organisation only', async () => {
    const grants = await collectPermissionGrants(
        { organizationId: 'orgA' },
        sources({ groupIds: ['gB'], allGroups: [{ id: 'gB', organizationId: 'orgB', permissions: ['all'] }] }),
    );
    assert.equal(grantsHoldInOrg(grants, 'manage_agents', 'orgB'), true);
    assert.equal(grantsHoldInOrg(grants, 'manage_agents', 'orgA'), false);
});

test('the org-wide grants are asked for the home organisation with the normalised orgRole', async () => {
    /** @type {unknown[]} */
    const asked = [];
    const grants = await collectPermissionGrants(
        { orgRole: 'admin', organizationId: 'orgA' },
        sources({ orgWideGrants: async (/** @type {unknown} */ orgId, /** @type {unknown} */ role) => { asked.push([orgId, role]); return ['use_meeting_notes']; } }),
    );
    assert.deepEqual(asked, [['orgA', 'org_admin']]);
    assert.deepEqual(permissionsOfGrants(grants), ['manage_agents', 'manage_knowledge', 'use_meeting_notes']);
});

// ── The store-backed form ───────────────────────────────────────────────────

// The collaborators go in through the permissions modules' own seam
// (auth/permissionsDeps.js), the one auth/permissions.js wires in production.
const fx = { users: {}, groups: [], roles: [], throwUser: false };
const fakeUserStore = {
    getUser: async (/** @type {string} */ id) => { if (fx.throwUser) throw new Error('down'); return fx.users[id] || null; },
    getAllGroups: async () => fx.groups,
    getAllRoles: async () => fx.roles,
    getOrganization: async () => null,
    getOrgBetaEveryone: async () => [],
};
require('./permissionsDeps').wireDeps({
    userStore: () => fakeUserStore,
    userStoreNow: () => fakeUserStore,
    orgScope: () => async () => ({ orgIds: new Set(), orgId: null, homeOrgId: null, isSuperAdmin: false, identityError: null }),
    orgRolePolicy: () => ({
        getOrgRoleOverrides: async () => ({}),
        resolveOrgRolePermissions: async (/** @type {unknown} */ _orgId, /** @type {Record<string, string[]>} */ defaults) => defaults,
    }),
});
const perms = require('./permissionsResolve');
const { invalidateAllPermissionCaches } = require('./permissionsCache');

beforeEach(async () => {
    fx.users = {}; fx.groups = []; fx.roles = []; fx.throwUser = false;
    await invalidateAllPermissionCaches();
});

test('hasPermissionInOrg: manage rights from the home orgRole do not reach a group organisation', async () => {
    fx.users.oa = { id: 'oa', role: 'user', orgRole: 'org_admin', organizationId: 'orgA', groups: ['gB'] };
    fx.groups = [{ id: 'gB', organizationId: 'orgB', permissions: [] }];
    assert.equal(await perms.hasPermissionInOrg('oa', 'manage_agents', 'orgA'), true);
    assert.equal(await perms.hasPermissionInOrg('oa', 'manage_agents', 'orgB'), false);
    assert.equal(await perms.hasPermission('oa', 'manage_agents'), true, 'the flat answer is unchanged');
});

test('resolvePermissionsByOrg answers many questions from one read', async () => {
    fx.users.m = { id: 'm', role: 'user', orgRole: 'member', organizationId: 'orgA', groups: ['gB'] };
    fx.groups = [{ id: 'gB', organizationId: 'orgB', orgRole: 'agent_editor' }];
    const byOrg = await perms.resolvePermissionsByOrg('m');
    assert.equal(byOrg.holds('manage_agents', 'orgB'), true);
    assert.equal(byOrg.holds('manage_agents', 'orgA'), false);
    assert.equal(byOrg.holds('manage_agents', null), false);
});

test('a platform admin holds everywhere; an unknown user and a store error nowhere', async () => {
    fx.users.root = { id: 'root', role: 'admin', groups: [] };
    assert.equal(await perms.hasPermissionInOrg('root', 'manage_agents', 'orgZ'), true);
    assert.equal(await perms.hasPermissionInOrg('x', 'manage_agents', 'orgZ', { isAdmin: true }), true);
    assert.equal(await perms.hasPermissionInOrg('nobody', 'manage_agents', 'orgA'), false);
    assert.equal(await perms.hasPermissionInOrg(null, 'manage_agents', 'orgA'), false);

    fx.throwUser = true;
    const origError = console.error;
    console.error = () => {};
    try {
        assert.equal(await perms.hasPermissionInOrg('oa', 'manage_agents', 'orgA'), false);
    } finally { console.error = origError; }
    assert.equal(perms.isPermissionLookupDegraded(), true);
});

test('the flat permission list is the union of the per-organisation grants', async () => {
    fx.users.u = { id: 'u', role: 'light', orgRole: 'agent_editor', organizationId: 'orgA', groups: ['gB', 'g0'] };
    fx.roles = [{ id: 'light', permissions: ['use_apps'] }];
    fx.groups = [
        { id: 'gB', organizationId: 'orgB', permissions: ['use_forms'], orgRole: 'dpo' },
        { id: 'g0', permissions: ['manage_skills'] },
    ];
    const flat = await perms.getUserPermissions('u');
    const byOrg = await perms.resolvePermissionsByOrg('u');
    for (const p of flat) {
        if (p === 'page_chat') continue; // the floor, not an organisation grant
        assert.ok(byOrg.holds(p, 'orgA') || byOrg.holds(p, 'orgB'), `${p} holds in some organisation`);
    }
    assert.equal(byOrg.holds('dpo', 'orgB'), true);
    assert.equal(byOrg.holds('dpo', 'orgA'), false);
    assert.equal(byOrg.holds('manage_skills', 'orgA'), true, 'an org-less group holds at home');
    assert.equal(byOrg.holds('use_apps', 'orgA'), true, 'the direct role holds at home');
    assert.equal(byOrg.holds('manage_agents', 'orgA'), true, 'the orgRole holds at home');
});
