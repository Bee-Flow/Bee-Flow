'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAzureGroupSync } = require('./azureGroupSync');
const tid = '11111111-1111-1111-1111-111111111111';
const oid = '22222222-2222-2222-2222-222222222222';
const ga = '33333333-3333-3333-3333-333333333333';
const gb = '44444444-4444-4444-4444-444444444444';
const newOid = '55555555-5555-5555-5555-555555555555';
const clone = value => structuredClone(value);
function fixture({ binding = { syncOrganizationId: 'B', syncTenantId: tid }, failGroup, failProvision = false, memberA = [], memberB = [{ id: oid }] } = {}) {
    const groups = [{ id: 'manual-A', organizationId: 'A', source: 'manual' }, { id: 'manual-B', organizationId: 'B', source: 'manual' },
        { id: 'azure-A', organizationId: 'B', azureTenantId: tid, azureGroupId: ga, source: 'azure' },
        { id: 'azure-B', organizationId: 'B', azureTenantId: tid, azureGroupId: gb, source: 'azure' },
        { id: 'other-org-azure', organizationId: 'A', azureTenantId: tid, azureGroupId: ga, source: 'azure' }];
    const users = [{ id: 'multi', email: 'multi@example.test', azureTenantId: tid, azureUserId: oid, organizationId: 'A', groups: ['manual-A','manual-B','azure-A','azure-B'] },
        { id: 'manual', azureTenantId: tid, azureUserId: newOid, organizationId: 'B', groups: ['azure-A'] }];
    const managed = new Set(['multi:azure-A','multi:azure-B']);
    const removals = [], writes = [];
    const config = new Map([['azure_group_sync_binding', binding], ['azure_group_sync_B', { destructiveSync: true }]]);
    const store = {
        getAllGroups: async () => clone(groups), getAllUsers: async () => clone(users), getUser: async id => clone(users.find(u => u.id === id)),
        getGroupByAzureId: async (object, tenant, org) => clone(groups.find(g => g.azureGroupId === object && g.azureTenantId === tenant && g.organizationId === org)),
        getUserByAzureId: async (object, tenant) => clone(users.find(u => u.azureUserId === object && u.azureTenantId === tenant)),
        getUserByEmail: async email => clone(users.find(u => u.email === email)),
        updateGroup: async (id, patch) => { writes.push(id); Object.assign(groups.find(g => g.id === id), patch); return true; },
        createGroup: async group => { groups.push(clone(group)); return true; },
        deleteGroup: async id => { removals.push(id); groups.splice(groups.findIndex(g => g.id === id), 1); },
        createUserWithSeatCheck: async user => { if (failProvision) return { created: false, reason: 'seat_cap' }; users.push(clone(user)); return { created: true }; },
    };
    let queue = Promise.resolve(), active = 0, maxActive = 0, locks = 0;
    const withSyncLock = fn => {
        const call = queue.then(async () => { locks++; active++; maxActive = Math.max(active, maxActive); try { return await fn(); } finally { active--; } });
        queue = call.catch(() => {}); return call;
    };
    const membershipStore = {
        add: async (id, group, expectedOid) => { const u = users.find(x => x.id === id); assert.equal(expectedOid, u.azureUserId); if (!u.groups.includes(group.id)) { u.groups.push(group.id); managed.add(`${id}:${group.id}`); } },
        remove: async (id, group, expectedOid) => { assert.equal(expectedOid, users.find(x => x.id === id).azureUserId); if (managed.delete(`${id}:${group.id}`)) { removals.push(`${id}:${group.id}`); const u = users.find(x => x.id === id); u.groups = u.groups.filter(g => g !== group.id); } },
    };
    const sync = createAzureGroupSync({ userStore: store,
        configStore: { getConfigFresh: async key => clone(config.get(key)), getConfig: async key => clone(config.get(key)), setConfig: async (key, value) => { config.set(key, clone(value)); } },
        loadConfig: async () => ({ providers: { microsoft: { clientId: 'app', clientSecret: 'encrypted-at-rest', tenantId: tid } } }),
        membershipStore, withSyncLock, findUnboundIdentity: async object => users.filter(u => !u.azureTenantId && u.azureUserId === object), log: { warn() {} },
        graph: { getClientCredentialsToken: async () => 'token', getAppRoleAssignments: async () => [{ principalType: 'Group', principalId: ga }, { principalType: 'Group', principalId: gb }],
            graphGet: async path => ({ id: path.split('/')[1].split('?')[0], displayName: path.startsWith(`groups/${ga}`) ? 'A' : 'B' }),
            getGroupMembers: async (_token, id) => { if (id === failGroup) throw new Error('partial Graph read'); await Promise.resolve(); return clone(id === ga ? memberA : memberB); } },
    });
    return { sync, users, groups, removals, writes, config, store, metrics: () => ({ locks, maxActive }) };
}
test('wrong organization and missing binding fail before directory mutations', async () => {
    const f = fixture(); const before = clone(f.users);
    await assert.rejects(f.sync.syncAzureGroupsToOrg('A'), err => err.status === 403);
    assert.deepEqual(f.users, before); assert.deepEqual(f.writes, []);
    const unbound = fixture({ binding: null });
    await assert.rejects(unbound.sync.syncAzureGroupsToOrg('B'), err => err.code === 'azure_sync_unbound');
    await unbound.sync.initPeriodicSyncs(); assert.equal(unbound.metrics().locks, 0);
});
test('sync removes only its own departed group memberships, preserving explicit multi-org grants', async () => {
    const f = fixture(); const result = await f.sync.syncAzureGroupsToOrg('B');
    assert.equal(result.ok, true);
    assert.deepEqual(f.users.find(u => u.id === 'multi').groups, ['manual-A','manual-B','azure-B']);
    assert.equal(f.users.find(u => u.id === 'multi').organizationId, 'A');
    assert.deepEqual(f.users.find(u => u.id === 'manual').groups, ['azure-A']);
    assert.ok(!f.writes.includes('other-org-azure'));
});
test('users outside the authorized target organization are skipped; matching email never claims another identity', async () => {
    const f = fixture({ memberA: [{ id: oid }, { id: newOid, mail: 'multi@example.test' }] });
    f.users.find(u => u.id === 'multi').groups = ['manual-A'];
    f.users.find(u => u.id === 'manual').azureTenantId = '66666666-6666-6666-6666-666666666666';
    const before = clone(f.users);
    const result = await f.sync.syncAzureGroupsToOrg('B');
    assert.ok(result.details.some(s => s.includes('not an authorized member')));
    assert.ok(result.details.some(s => s.includes('administrator confirmation')));
    assert.deepEqual(f.users, before);
});
test('partial Graph snapshots and provisioning failures prohibit all destructive cleanup', async () => {
    for (const f of [fixture({ failGroup: gb }), fixture({ failProvision: true, memberB: [{ id: '77777777-7777-7777-7777-777777777777' }] })]) {
        const result = await f.sync.syncAzureGroupsToOrg('B');
        assert.equal(result.ok, false);
        assert.deepEqual(f.removals, []);
    }
});
test('manual and login syncs serialize through the same lock and recheck their binding', async () => {
    const f = fixture();
    await Promise.all([f.sync.syncAzureGroupsToOrg('B'), f.sync.syncAzureGroupsToOrg('B'), f.sync.syncUserGroupsOnLogin('multi', oid, 'B', tid)]);
    assert.equal(f.metrics().locks, 3); assert.equal(f.metrics().maxActive, 1);
    const before = clone(f.users);
    await f.sync.syncUserGroupsOnLogin('multi', oid, 'A', tid);
    assert.deepEqual(f.users, before);
});
test('login sync uses the confirmed target for an explicit member whose primary organization differs', async () => {
    const f = fixture();
    await f.sync.syncUserGroupsOnLogin('multi', oid, undefined, tid);
    assert.deepEqual(f.users.find(user => user.id === 'multi').groups, ['manual-A','manual-B','azure-B']);
    assert.equal(f.users.find(user => user.id === 'multi').organizationId, 'A');
});
test('verified legacy Azure groups in the target organization retain their local IDs', async () => {
    const f = fixture(); f.groups.find(g => g.id === 'azure-A').azureTenantId = null;
    await f.sync.syncAzureGroupsToOrg('B');
    assert.equal(f.groups.find(g => g.id === 'azure-A').azureTenantId, tid);
    assert.equal(f.groups.filter(g => g.azureGroupId === ga && g.organizationId === 'B').length, 1);
});
test('failed local reads and group writes prohibit all destructive cleanup', async () => {
    for (const operation of ['getAllUsers', 'updateGroup']) {
        const f = fixture();
        f.store[operation] = async () => { if (operation === 'updateGroup') return false; throw new Error('Local database read failed'); };
        const result = await f.sync.syncAzureGroupsToOrg('B');
        assert.equal(result.ok, false);
        assert.deepEqual(f.removals, []);
    }
});
test('an unbound legacy object with a changed email is skipped instead of creating a duplicate account', async () => {
    const f = fixture({ memberA: [{ id: newOid, mail: 'changed@example.test' }] });
    Object.assign(f.users.find(u => u.id === 'manual'), { azureTenantId: null, email: 'old@example.test' });
    const before = clone(f.users);
    const result = await f.sync.syncAzureGroupsToOrg('B');
    assert.equal(result.ok, true);
    assert.ok(result.details.some(detail => detail.includes('legacy Microsoft identity requires administrator confirmation')));
    assert.deepEqual(f.users.find(u => u.id === 'manual'), before.find(u => u.id === 'manual'));
    assert.equal(f.users.length, before.length);
});
