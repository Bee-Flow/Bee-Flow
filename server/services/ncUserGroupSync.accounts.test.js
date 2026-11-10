/**
 * The Nextcloud user sync and the accounts it leaves as they are: a group
 * event in manual mode, and a person who signed in before the sync met them.
 *
 * Fake stores + fetch; no Postgres, no network.
 *
 * Run: node --test server/services/ncUserGroupSync.accounts.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// The proxy call uses the global fetch only with the private-hosts switch on
// (see ncUserGroupSync.test.js).
process.env.NEXTCLOUD_ALLOW_PRIVATE_HOSTS = '1';

const ORG = {
    id: 'org-1',
    connector_callback_url: 'https://cloud.example.com/index.php/apps/app_api/proxy/bee_flow',
    nc_admin_uid: 'admin',
    nc_sync_mode: 'selective_groups',
    ncSyncGroups: ['staff'],
    nc_onboarding_completed_at: '2026-01-05T09:00:00Z', // the sync mode is chosen
};
const MIRROR_ALL = { ...ORG, nc_sync_mode: 'mirror_all', ncSyncGroups: [] };
const MANUAL = { ...ORG, nc_sync_mode: 'manual', ncSyncGroups: [] };

const state = { users: new Map(), updates: [], creates: [] };

// The sync calls its stores through the module objects, so those are the seam.
const userStore = require('../stores/userStore');
const configStore = require('../stores/configStore');
const { makeSwaps } = require('../testUtils/swaps');
const { swap, restore } = makeSwaps();
for (const [name, fn] of Object.entries({
    getUserByNcUid: async (orgId, ncUid) => [...state.users.values()].find(u => u.organizationId === orgId && u.nc_uid === ncUid) || null,
    getUser: async (id) => state.users.get(id) || null,
    hasMirroredNcUsers: async () => true,
    updateUser: async (id, updates) => { state.updates.push({ id, updates }); },
    createUserWithSeatCheck: async (u) => { state.creates.push(u); return { created: true }; },
})) swap(userStore, name, fn);
swap(configStore, 'getSecret', async (k) => (k === `connector_tenant_key_${ORG.id}` ? 'k'.repeat(64) : null));
swap(configStore, 'getConfig', async () => null);

const sync = require('./ncUserGroupSync');

let groupsByUid = {};
const realFetch = global.fetch;
const json = (body) => ({ ok: true, status: 200, json: async () => body });

beforeEach(() => {
    state.users.clear(); state.updates.length = 0; state.creates.length = 0;
    groupsByUid = { admin: ['admin'] };
    global.fetch = /** @type {any} */ (async (url) => {
        const m = new URL(url).pathname.match(/\/cloud\/users\/([^/]+)(\/groups)?/);
        if (!m) return json({ ocs: { data: [] } });
        const uid = decodeURIComponent(m[1]);
        if (m[2]) return json({ ocs: { data: { groups: groupsByUid[uid] || [] } } });
        return json({ ocs: { data: { id: uid, enabled: true, email: `${uid}@example.com`, displayname: uid } } });
    });
});
test.after(() => { global.fetch = realFetch; restore(); });

const statusWrites = () => state.updates.filter(u => 'status' in u.updates);

function seedExistingUser({ ncUid, status, ...rest }) {
    const user = { id: `nc_${ORG.id}_${ncUid}`, nc_uid: ncUid, status, email: `${ncUid}@example.com`, displayName: ncUid, groups: [], organizationId: ORG.id, provider: 'nextcloud_connector', ...rest };
    state.users.set(user.id, user);
    return user;
}

// ── Manual mode: a group event ──────────────────────────────────────────────

test('manual mode: a group event updates the groups of a linked user and keeps the status', async () => {
    const admin = seedExistingUser({ ncUid: 'admin', status: 'active', orgRole: 'org_admin' });
    groupsByUid.admin = ['admin', 'staff'];
    const r = await sync.applyGroupMemberChange(MANUAL, 'admin', 'staff');
    assert.deepEqual(r, { action: 'groups_updated', userId: admin.id, groups: ['nc_org-1_staff'] });
    assert.deepEqual(statusWrites(), []);

    // The same groups again: nothing is written.
    admin.groups = ['nc_org-1_staff'];
    state.updates.length = 0;
    assert.deepEqual(await sync.applyGroupMemberChange(MANUAL, 'admin', 'staff'), { action: 'noop' });
    assert.deepEqual(state.updates, []);
});

test('manual mode: a group event creates nobody and activates nobody', async () => {
    groupsByUid.carol = ['staff'];
    assert.deepEqual(await sync.applyGroupMemberChange(MANUAL, 'carol', 'staff'), { action: 'noop' });
    assert.deepEqual(state.creates, []);

    seedExistingUser({ ncUid: 'bob', status: 'inactive' });
    groupsByUid.bob = ['staff'];
    await sync.applyGroupMemberChange(MANUAL, 'bob', 'staff');
    assert.deepEqual(statusWrites(), []);
});

// ── A row without a stored uid at the plain id ──────────────────────────────

test('a row at the plain id without a stored uid and with the same e-mail address is that person: nobody is created', async () => {
    // What a sign-in without a uid leaves: the id from the address, no uid.
    const row = { id: 'nc_org-1_john-doe', nc_uid: null, status: 'active', email: 'John.Doe@example.com', displayName: 'John', groups: [], organizationId: ORG.id, provider: 'nextcloud_connector' };
    state.users.set(row.id, row);
    assert.deepEqual(await sync.applyUserCreated(MIRROR_ALL, 'john.doe'), { action: 'skip', reason: 'duplicate_id' });
    assert.deepEqual(state.creates, []);
    assert.deepEqual(state.updates, []);
});

test('a row at the plain id without a stored uid and with another e-mail address is someone else: the new user gets the id with a hash', async () => {
    const row = { id: 'nc_org-1_john-doe', nc_uid: null, status: 'active', email: 'someone@example.com', displayName: 'S', groups: [], organizationId: ORG.id, provider: null };
    state.users.set(row.id, row);
    const r = await sync.applyUserCreated(MIRROR_ALL, 'john.doe');
    assert.equal(r.action, 'create');
    assert.match(r.userId, /^nc_org-1_john-doe-[0-9a-f]{8}$/);
});
