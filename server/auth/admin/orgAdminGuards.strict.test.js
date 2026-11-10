// @typecheck
/**
 * Who administers an organisation, per router: an admin of org A who is only a
 * member of an ordinary group of org B does not administer B.
 *
 * The guards in auth/admin/orgAdminGuards.js (requireOrgAdmin,
 * requireOrgAdminForUser, isOrgAdminForOrg) decide with permissions._evalOrgAdmin:
 * org X is administered by someone whose own org is X with an admin orgRole,
 * or who belongs to a group OF X that carries admin rights. This file drives
 * the real routers that mount those guards (userRoutes, orgRoutes,
 * featureAccessRoutes) and groupRoleRoutes, whose group edits are limited to the
 * caller's own org, and pins for each:
 *
 *   - ann, org_admin of orgA and a plain member of orgB's g_b, gets 403 on orgB's
 *     user create, update, delete and MFA reset, on orgB's settings, on orgB's
 *     group-access and org-access grants, and on orgB's groups;
 *   - bob, org_admin of orgB, and root, a platform admin, still pass.
 *
 * No module mocking: the routers are served by testUtils/routeHarness over its
 * recording database seam, and the store and permission functions they call
 * through module objects are swapped with testUtils/swaps. requireAuth,
 * requireAdmin and getUserPermissions are swapped on auth/permissions BEFORE the
 * routers are required, because the routers destructure them at load. The
 * org-admin decision itself (_evalOrgAdmin) is never replaced.
 *
 * Run: cd server && node --test auth/admin/orgAdminGuards.strict.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

const h = require('../../testUtils/routeHarness');
const { makeSwaps } = require('../../testUtils/swaps');

const db = h.recordDb();
const permissions = require('../permissions');
const limits = require('../../core/entitlements/limits');
const swaps = makeSwaps();

/** @type {{ users: Record<string, any>[], groups: Record<string, any>[], orgs: Record<string, any>[], perms: Record<string, string[]>, writes: unknown[][] }} */
const state = { users: [], groups: [], orgs: [], perms: {}, writes: [] };

/** @type {import('express').RequestHandler} */
const needsSession = (req, res, next) => (req.session && req.session.isAuthenticated && req.session.user
    ? next()
    : res.status(401).json({ error: 'Not authenticated' }));
swaps.swap(permissions, 'requireAuth', needsSession);
swaps.swap(permissions, 'requireAdmin', needsSession);
swaps.swap(permissions, 'getUserPermissions', async (/** @type {string} */ id) => state.perms[id] || []);
swaps.swap(limits, 'checkResourceLimits', async () => null);

const userStore = require('../../stores/userStore');
const entitlements = require('../../core/entitlements/entitlements');
// Every call names its user; the default session user is a stranger to both orgs.
const serveAt = (/** @type {string} */ file) => h.serve('/', require(file), { user: { id: 'nobody', organizationId: 'none', role: 'user', email: 'nobody@example.test' } });
const users = serveAt('./userRoutes');
const orgs = serveAt('./orgRoutes');
const access = serveAt('./featureAccessRoutes');
const groups = serveAt('./groupRoleRoutes');

const ANN = { id: 'ann', role: 'user' };
const BOB = { id: 'bob', role: 'user' };
const ROOT = { id: 'root', role: 'admin' };

function reset() {
    state.orgs = [{ id: 'orgA', name: 'Org A' }, { id: 'orgB', name: 'Org B' }];
    state.groups = [
        { id: 'g_a', name: 'A team', organizationId: 'orgA' },
        { id: 'g_b', name: 'B team', organizationId: 'orgB' },
    ];
    state.users = [
        { id: 'ann', username: 'ann', organizationId: 'orgA', groups: ['g_a', 'g_b'], orgRole: 'org_admin', role: 'user', status: 'active' },
        { id: 'bob', username: 'bob', organizationId: 'orgB', groups: ['g_b'], orgRole: 'org_admin', role: 'user', status: 'active' },
        { id: 'ben', username: 'ben', organizationId: 'orgB', groups: ['g_b'], orgRole: 'member', role: 'user', status: 'active', mfa_enabled: true },
    ];
    // The permissions an org_admin holds (config/orgRoles.json), flat, as getUserPermissions answers.
    const orgAdmin = ['manage_users', 'admin_security', 'admin_ai_config', 'admin_monitoring', 'admin_compliance', 'org_admin'];
    state.perms = { ann: orgAdmin, bob: orgAdmin, ben: [] };
    state.writes = [];
}

/** @param {string} id */
const findUser = (id) => state.users.find((u) => u.id === id) || null;
const copy = (/** @type {unknown} */ v) => JSON.parse(JSON.stringify(v));
/** @param {string} what */
const record = (what) => async (/** @type {unknown[]} */ ...args) => { state.writes.push([what, ...args]); return true; };

test.before(async () => {
    await db.settle();
    swaps.swap(userStore, 'getUser', async (/** @type {string} */ id) => copy(findUser(id)));
    swaps.swap(userStore, 'getAllUsers', async () => copy(state.users));
    swaps.swap(userStore, 'getAllGroups', async () => copy(state.groups));
    swaps.swap(userStore, 'getAllRoles', async () => []);
    swaps.swap(userStore, 'getOrganization', async (/** @type {string} */ id) => copy(state.orgs.find((o) => o.id === id) || null));
    swaps.swap(userStore, 'getAllOrganizations', async () => copy(state.orgs));
    swaps.swap(userStore, 'updateUser', record('updateUser'));
    swaps.swap(userStore, 'deleteUser', record('deleteUser'));
    swaps.swap(userStore, 'deleteAllSecurityKeys', async () => 0);
    swaps.swap(userStore, 'createUserWithSeatCheck', async (/** @type {unknown} */ u) => { state.writes.push(['createUser', u]); return { created: true }; });
    swaps.swap(userStore, 'updateOrganization', record('updateOrganization'));
    swaps.swap(userStore, 'updateGroup', record('updateGroup'));
    swaps.swap(userStore, 'logAccessAudit', async () => {});
    // What PUT /organizations/:orgId/org-access reads and writes (see featureAccessRoutes.customKeep.test.js).
    swaps.swap(userStore, 'getOrgEnabledIntegrations', async () => []);
    swaps.swap(userStore, 'setOrgEnabledIntegrations', record('setOrgEnabledIntegrations'));
    swaps.swap(userStore, 'setOrgEnabledBetaFeatures', async () => true);
    swaps.swap(userStore, 'getOrgBetaEveryone', async () => null);
    swaps.swap(userStore, 'setOrgBetaEveryone', async () => true);
    swaps.swap(userStore, 'setOrgGrantedCapabilities', async () => true);
    swaps.swap(entitlements, 'resolveEntitlements', async () => ({
        mode: 'self-hosted',
        ceiling: { core: [], beta: [], integration: ['gmail'] },
        orgAvailable: { core: [], beta: [], integration: ['gmail'] },
        orgEnabled: { core: [], beta: [], integration: [] },
    }));
    swaps.swap(entitlements, 'invalidateForOrg', async () => {});
    swaps.swap(entitlements.registry, 'refreshMcpIntegrationDescriptors', async () => {});
    swaps.swap(entitlements.registry, 'getCapability', () => null);
    swaps.swap(entitlements.registry, 'listCapabilities', () => [
        { id: 'gmail', kind: 'integration', name: 'Gmail', userFacing: true, groupTogglable: true },
    ]);
});
test.beforeEach(reset);
test.after(async () => {
    swaps.restore();
    for (const api of [users, orgs, access, groups]) await api.close();
});

const NEW_USER = { username: 'newb', password: 'Plenty-of-length-and-mixed-9', organizationId: 'orgB' };

/**
 * Every write to orgB the routers expose, as [api, method, url, body].
 * @type {[ReturnType<typeof h.serve>, string, string, Record<string, unknown>][]}
 */
const ORG_B_WRITES = [
    [users, 'POST', '/users', NEW_USER],
    [users, 'PUT', '/users/ben', { displayName: 'Changed' }],
    [users, 'POST', '/users/ben/mfa/reset', {}],
    [users, 'DELETE', '/users/ben', {}],
    [orgs, 'PUT', '/organizations/orgB', { description: 'Changed' }],
    [access, 'PUT', '/organizations/orgB/org-access', { granted: ['gmail'] }],
    [groups, 'PUT', '/groups/g_b', { description: 'Changed' }],
];

test('an admin of orgA who is a plain group member of orgB is refused every orgB write', async () => {
    for (const [api, method, url, body] of ORG_B_WRITES) {
        const res = await api.call(method, url, { user: ANN, body });
        assert.strictEqual(res.status, 403, `${method} ${url}: ${res.status} ${res.text}`);
    }
    assert.deepStrictEqual(state.writes, [], 'nothing may reach the store');
});

test('nor may they read orgB\'s settings or its group-access grants', async () => {
    /** @type {[ReturnType<typeof h.serve>, string][]} */
    const reads = [[orgs, '/organizations/orgB'], [access, '/organizations/orgB/group-access']];
    for (const [api, url] of reads) {
        const res = await api.call('GET', url, { user: ANN });
        assert.strictEqual(res.status, 403, `GET ${url}: ${res.status} ${res.text}`);
        assert.strictEqual(res.body.error, 'Organization admin access required');
    }
});

test('the refusals name the org-admin rule, not a missing permission', async () => {
    const put = await users.call('PUT', '/users/ben', { user: ANN, body: { displayName: 'x' } });
    assert.strictEqual(put.body.error, 'You can only manage users in your organisation');
    const settings = await orgs.call('PUT', '/organizations/orgB', { user: ANN, body: { description: 'x' } });
    assert.strictEqual(settings.body.error, 'Organization admin access required');
    const grants = await access.call('PUT', '/organizations/orgB/org-access', { user: ANN, body: { granted: [] } });
    assert.strictEqual(grants.body.error, 'Organization admin access required');
});

test('the same admin still manages their own org', async () => {
    state.users.push({ id: 'eva', username: 'eva', organizationId: 'orgA', groups: ['g_a'], orgRole: 'member', role: 'user', status: 'active' });
    const res = await users.call('PUT', '/users/eva', { user: ANN, body: { displayName: 'Eva' } });
    assert.strictEqual(res.status, 200, res.text);
    const own = await orgs.call('PUT', '/organizations/orgA', { user: ANN, body: { description: 'Ours' } });
    assert.strictEqual(own.status, 200, own.text);
});

for (const [who, caller] of /** @type {[string, Record<string, unknown>][]} */ ([['orgB\'s own admin', BOB], ['a platform admin', ROOT]])) {
    test(`${who} passes every orgB write`, async () => {
        for (const [api, method, url, body] of ORG_B_WRITES) {
            reset();
            const res = await api.call(method, url, { user: caller, body });
            assert.strictEqual(res.status, 200, `${method} ${url}: ${res.status} ${res.text}`);
            assert.ok(state.writes.length > 0, `${method} ${url} wrote nothing`);
        }
    });
}

test('an admin through an admin-carrying group of orgB administers orgB, whatever their own orgRole', async () => {
    state.groups.push({ id: 'g_b_admins', name: 'B admins', organizationId: 'orgB', roles: ['org_admin'] });
    state.users.push({ id: 'cat', username: 'cat', organizationId: 'orgA', groups: ['g_b_admins'], orgRole: 'member', role: 'user', status: 'active' });
    const res = await orgs.call('PUT', '/organizations/orgB', { user: { id: 'cat', role: 'user' }, body: { description: 'By cat' } });
    assert.strictEqual(res.status, 200, res.text);
    const user = await users.call('PUT', '/users/ben', { user: { id: 'cat', role: 'user' }, body: { displayName: 'By cat' } });
    assert.strictEqual(user.status, 200, user.text);
});
