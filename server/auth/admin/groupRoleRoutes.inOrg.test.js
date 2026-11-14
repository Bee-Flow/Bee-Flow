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
const { pg, close: closePg } = usePglitePool();
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

test('adding a member puts the user in the group and audits it once; adding the same member again changes nothing', async () => {
    const audits = async () => (await pg.query(
        `SELECT target_id, changed_by, organization_id, new_values FROM access_audit_log WHERE action = 'group.member.add'`)).rows;
    const added = await api.call('POST', '/groups/a-team/members', { body: { userId: MEMBER_A.id } });
    assert.equal(added.status, 200, added.text);
    assert.deepEqual(added.body, { success: true });
    assert.deepEqual((await userStore.getUser(MEMBER_A.id)).groups, ['a-team']);
    const rows = await audits();
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].target_id, rows[0].changed_by, rows[0].organization_id], ['a-team', ADMIN_A.id, ORG_A]);
    assert.equal(JSON.parse(rows[0].new_values).userId, MEMBER_A.id);

    const again = await api.call('POST', '/groups/a-team/members', { body: { userId: MEMBER_A.id } });
    assert.deepEqual(again.body, { success: true, alreadyMember: true });
    assert.equal((await audits()).length, 1);
});

test('a user who is not there, or belongs to another organisation, is not added', async () => {
    assert.equal((await api.call('POST', '/groups/a-team/members', { body: { userId: 'grp-nobody' } })).status, 404);
    await userStore.createUser({ ...mk('grp-member-b', ORG_B), passwordHash: 'x' });
    const other = await api.call('POST', '/groups/a-team/members', { body: { userId: 'grp-member-b' } });
    assert.equal(other.status, 403);
    assert.deepEqual((await userStore.getUser('grp-member-b')).groups, []);
});

test('a group update is audited with what changed, and not at all when nothing did', async () => {
    const audits = async () => (await pg.query(
        `SELECT new_values FROM access_audit_log WHERE action = 'group.update' AND target_id = 'a-team' ORDER BY created_at`)).rows;
    const before = (await audits()).length;
    const first = await api.call('PUT', '/groups/a-team', { body: { perUserCostLimit: 25 } });
    assert.equal(first.status, 200, first.text);
    const rows = await audits();
    assert.equal(rows.length, before + 1);
    assert.equal(JSON.parse(rows.at(-1).new_values).perUserCostLimit, 25);

    assert.equal((await api.call('PUT', '/groups/a-team', { body: { perUserCostLimit: 25 } })).status, 200);
    assert.equal((await api.call('PUT', '/groups/a-team', { body: { description: 'not an audited field' } })).status, 200);
    assert.equal((await audits()).length, before + 1, 'the same value again, or a field outside the audit, adds no row');
});
