/**
 * GET /users, /groups and /organizations with `?scope=admin` (the admin
 * dashboard): each answers for the organisation auth/adminOrg.mts resolves.
 *
 *   - an organisation admin gets their HOME organisation only, also when a
 *     group of another organisation lists them;
 *   - a platform admin gets everything, or one organisation by `?orgId` or by
 *     the dashboard selection in the session;
 *   - without the parameter every list answers what it answered before.
 *
 * The real routers and the real auth/permissions barrel's resolver (strict
 * org-admin check included); the store functions are swapped in place.
 * Run: cd server && node --test auth/admin/listRoutes.adminScope.test.js
 */
'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../../testUtils/routeHarness');

const ORGS = [
    { id: 'org-a', name: 'Org A' },
    { id: 'org-b', name: 'Org B' },
];
const GROUPS = [
    { id: 'g-a', name: 'A staff', organizationId: 'org-a', permissions: [], roles: [] },
    { id: 'g-b', name: 'B staff', organizationId: 'org-b', permissions: ['page_chat'], roles: [] },
];
const USERS = [
    // Organisation admin of org-a who is also in a group of org-b.
    { id: 'adminA', username: 'admin-a', organizationId: 'org-a', orgRole: 'org_admin', groups: ['g-b'] },
    { id: 'memberA', username: 'member-a', organizationId: 'org-a', orgRole: 'member', groups: ['g-a'] },
    // Home organisation org-b, member of a group in org-a.
    { id: 'guestInA', username: 'guest', organizationId: 'org-b', orgRole: 'member', groups: ['g-a'] },
    { id: 'memberB', username: 'member-b', organizationId: 'org-b', orgRole: 'member', groups: ['g-b'] },
    // Holds manage_users in org-a without being an admin of it.
    { id: 'managerA', username: 'manager-a', organizationId: 'org-a', orgRole: 'member', groups: [] },
];
const PERMS = { adminA: ['manage_users', 'org_admin'], managerA: ['manage_users'] };

/** The union resolver the lists use without the parameter: home org plus every group's org. */
async function resolveUserOrgIds(req) {
    const me = USERS.find((u) => u.id === req.session?.user?.id);
    const ids = new Set();
    if (me?.organizationId) ids.add(me.organizationId);
    for (const gid of me?.groups || []) {
        const g = GROUPS.find((x) => x.id === gid);
        if (g?.organizationId) ids.add(g.organizationId);
    }
    return ids;
}

h.recordDb();
h.openGates({
    loadConfig: async () => ({ admin: { username: 'admin' } }),
    getUserPermissions: async (id) => PERMS[id] || [],
    resolveUserOrgIds,
});
const userStore = require('../../stores/userStore');
userStore.getAllUsers = async () => USERS.map((u) => ({ ...u }));
userStore.getAllGroups = async () => GROUPS.map((g) => ({ ...g }));
userStore.getAllOrganizations = async () => ORGS.map((o) => ({ ...o }));
userStore.getUser = async (id) => { const u = USERS.find((x) => x.id === id); return u ? { ...u } : null; };
userStore.getOrganization = async (id) => { const o = ORGS.find((x) => x.id === id); return o ? { ...o } : null; };

const router = require('express').Router();
router.use(require('./userRoutes'));
router.use(require('./groupRoleRoutes'));
router.use(require('./orgRoutes'));
const dispatch = h.dispatcher(router);

const asUser = (id) => ({ isAuthenticated: true, user: { id, role: 'user' } });
const asPlatform = (extra = {}) => ({ isAuthenticated: true, isAdmin: true, user: { id: 'root', role: 'admin' }, ...extra });

const get = (url, session) => dispatch({ method: 'GET', url, session });
async function ids(url, session) {
    const res = await get(url, session);
    assert.equal(res.statusCode, 200, `${url}: ${JSON.stringify(res.body)}`);
    return res.body.map((row) => row.id).sort();
}

test('organisation admin with scope=admin: only the home organisation, not the one a group adds', async () => {
    assert.deepEqual(await ids('/users?scope=admin', asUser('adminA')), ['adminA', 'guestInA', 'managerA', 'memberA']);
    assert.deepEqual(await ids('/groups?scope=admin', asUser('adminA')), ['g-a']);
    assert.deepEqual(await ids('/organizations?scope=admin', asUser('adminA')), ['org-a']);
});

test('organisation admin naming another organisation is refused on every list', async () => {
    for (const path of ['/users', '/groups', '/organizations']) {
        const res = await get(`${path}?scope=admin&orgId=org-b`, asUser('adminA'));
        assert.equal(res.statusCode, 403, path);
        assert.equal(res.body.code, 'org_admin_required', path);
    }
});

test('organisation admin naming their own organisation gets it', async () => {
    assert.deepEqual(await ids('/groups?scope=admin&orgId=org-a', asUser('adminA')), ['g-a']);
});

test('a holder of manage_users who is no admin of the home organisation is refused with scope=admin', async () => {
    for (const path of ['/users', '/groups', '/organizations']) {
        const res = await get(`${path}?scope=admin`, asUser('managerA'));
        assert.equal(res.statusCode, 403, path);
        assert.equal(res.body.code, 'org_admin_required', path);
    }
});

test('platform admin with scope=admin and no organisation: the same full lists as without it', async () => {
    for (const path of ['/users', '/groups', '/organizations']) {
        const scoped = await get(`${path}?scope=admin`, asPlatform());
        const plain = await get(path, asPlatform());
        assert.equal(scoped.statusCode, 200, path);
        assert.deepEqual(scoped.body, plain.body, path);
    }
    assert.deepEqual(await ids('/users?scope=admin', asPlatform()), ['admin', 'adminA', 'guestInA', 'managerA', 'memberA', 'memberB']);
    assert.deepEqual(await ids('/organizations?scope=admin', asPlatform()), ['org-a', 'org-b']);
});

test('platform admin with scope=admin and orgId: that organisation only', async () => {
    // Members of org-b: home organisation org-b (guestInA, memberB) or in one
    // of its groups (adminA, through g-b).
    assert.deepEqual(await ids('/users?scope=admin&orgId=org-b', asPlatform()), ['adminA', 'guestInA', 'memberB']);
    assert.deepEqual(await ids('/groups?scope=admin&orgId=org-b', asPlatform()), ['g-b']);
    assert.deepEqual(await ids('/organizations?scope=admin&orgId=org-b', asPlatform()), ['org-b']);
});

test('platform admin with an Access panel selection on the session: still the full lists', async () => {
    // The Access panel stores its entitlement context there on its own; only ?orgId narrows.
    const session = asPlatform({ adminSelectedOrgId: 'org-a' });
    assert.deepEqual(await ids('/organizations?scope=admin', session), await ids('/organizations?scope=admin', asPlatform()));
    assert.deepEqual(await ids('/groups?scope=admin', session), await ids('/groups?scope=admin', asPlatform()));
    assert.ok((await ids('/organizations?scope=admin', session)).includes('org-b'));
});

test('platform admin naming an organisation that does not exist gets 404', async () => {
    const res = await get('/organizations?scope=admin&orgId=org-x', asPlatform());
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.code, 'organization_not_found');
});

test('without scope=admin the lists keep their union scoping', async () => {
    // adminA is in a group of org-b, so the lists without the parameter still
    // reach org-b, exactly as before the parameter existed.
    for (const url of ['', '?scope=other']) {
        assert.deepEqual(await ids(`/users${url}`, asUser('adminA')), ['adminA', 'guestInA', 'managerA', 'memberA', 'memberB']);
        assert.deepEqual(await ids(`/groups${url}`, asUser('adminA')), ['g-a', 'g-b']);
        assert.deepEqual(await ids(`/organizations${url}`, asUser('adminA')), ['org-a', 'org-b']);
    }
    assert.deepEqual(await ids('/groups', asUser('managerA')), ['g-a']);
});

test('without the view permission the lists refuse before any scope is resolved', async () => {
    const res = await get('/users?scope=admin', asUser('memberA'));
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, 'Permission required to view users');
});
