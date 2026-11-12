'use strict';
/**
 * The group routes over the real router, the real stores and a real Postgres (PGlite): a group
 * of organisation A is created, edited, deleted and given members only with org_admin or
 * manage_users held IN A, not with a right that comes from a group of another organisation. And
 * a group name another organisation already uses is not reported as taken.
 *
 * Run: cd server && node --test auth/admin/groupRoleRoutes.inOrg.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'grp-test-session-secret-0123456789abcdef';
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'grp-test-master-key-0123456789abcdef0123456789';

const { usePglitePool } = require('../../testUtils/pglitePool');
const { close: closePg } = usePglitePool();
const h = require('../../testUtils/routeHarness');

const ORG_A = 'org-grp-a';
const ORG_B = 'org-grp-b';
const mk = (id, org, extra = {}) => ({ id, username: id, email: `${id}@grp.test`, organizationId: org, role: 'user', orgRole: 'member', groups: [], ...extra });
const ADMIN_A = mk('grp-admin-a', ORG_A, { orgRole: 'org_admin' });
const MEMBER_A = mk('grp-member-a', ORG_A);
// A member of A who manages users only through a group of B.
const CROSS = mk('grp-cross', ORG_A, { groups: ['grp-b-managers'] });

let api;
let userStore;

before(async () => {
    userStore = require('../../stores/userStore');
    await userStore.initDB();
    for (const id of [ORG_A, ORG_B]) await userStore.createOrganization({ id, name: id }, { autoGrantTrial: false });
    await userStore.createGroup({ id: 'grp-b-managers', name: 'B managers', organizationId: ORG_B, permissions: ['manage_users', 'org_admin'] });
    await userStore.createGroup({ id: 'finance', name: 'Finance', organizationId: ORG_B, permissions: [] });
    await userStore.createGroup({ id: 'a-team', name: 'A team', organizationId: ORG_A, permissions: [] });
    for (const u of [ADMIN_A, MEMBER_A, CROSS]) await userStore.createUser({ ...u, passwordHash: 'x' });
    api = h.serve('/', require('./groupRoleRoutes'), { user: ADMIN_A });
}, { timeout: 120_000 });

after(async () => {
    await api.close();
    await closePg();
});

test('a right held through a group of another organisation manages no group of the home organisation', async () => {
    const as = { user: CROSS };
    assert.equal((await api.call('POST', '/groups', { ...as, body: { name: 'Cross team' } })).status, 403);
    assert.equal(await userStore.getGroup('cross-team'), null);
    assert.equal((await api.call('PUT', '/groups/a-team', { ...as, body: { description: 'changed' } })).status, 403);
    assert.equal((await userStore.getGroup('a-team')).description || '', '');
    assert.equal((await api.call('POST', '/groups/a-team/members', { ...as, body: { userId: MEMBER_A.id } })).status, 403);
    assert.deepEqual((await userStore.getUser(MEMBER_A.id)).groups, []);
    assert.equal((await api.call('DELETE', '/groups/a-team', as)).status, 403);
    assert.ok(await userStore.getGroup('a-team'));
});

test('the organisation admin of A manages A\'s groups', async () => {
    const created = await api.call('POST', '/groups', { body: { name: 'Admin team' } });
    assert.equal(created.status, 200, created.text);
    assert.equal(created.body.group.organizationId, ORG_A);
    assert.equal((await api.call('PUT', '/groups/a-team', { body: { description: 'changed' } })).status, 200);
});

test('a name another organisation uses gets its own id; a name this organisation uses is taken', async () => {
    const res = await api.call('POST', '/groups', { body: { name: 'Finance' } });
    assert.equal(res.status, 200, res.text);
    assert.notEqual(res.body.group.id, 'finance');
    assert.ok(res.body.group.id.startsWith('finance-'));
    assert.equal((await userStore.getGroup('finance')).organizationId, ORG_B);
    const again = await api.call('POST', '/groups', { body: { name: 'A team' } });
    assert.equal(again.status, 400);
    assert.equal(again.body.error, 'Group already exists');
});
