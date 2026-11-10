/**
 * Sign-in follows the Nextcloud user sync: an account the sync deactivates
 * (disabled in Nextcloud, outside the organisation's sync selection, or no
 * longer in Nextcloud) cannot sign in, and can again once the sync activates
 * it. The sync runs against store functions that keep what it writes; the
 * question "may this row sign in" is put to the real gate
 * (auth/accountStatusGate.js).
 *
 * Fake stores + fetch; no Postgres, no network.
 *
 * Run: node --test server/services/ncUserGroupSync.signIn.test.js
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

/** @type {Map<string, any>} */
const users = new Map();

// The sync calls its stores through the module objects, so those are the seam.
const userStore = require('../stores/userStore');
const configStore = require('../stores/configStore');
const { makeSwaps } = require('../testUtils/swaps');
const { swap, restore } = makeSwaps();
for (const [name, fn] of Object.entries({
    getUserByNcUid: async (orgId, ncUid) => [...users.values()].find(u => u.organizationId === orgId && u.nc_uid === ncUid) || null,
    getUser: async (id) => users.get(id) || null,
    getAllUsers: async () => [...users.values()],
    hasMirroredNcUsers: async () => true,
    getAllGroups: async () => [],
    updateUser: async (id, updates) => { Object.assign(users.get(id), updates); },
    createUserWithSeatCheck: async () => ({ created: true }),
    updateOrganization: async () => {},
    createGroup: async () => {},
})) swap(userStore, name, fn);
swap(configStore, 'getSecret', async (k) => (k === `connector_tenant_key_${ORG.id}` ? 'k'.repeat(64) : null));
swap(configStore, 'getConfig', async () => null);

const sync = require('./ncUserGroupSync');
const orgHealth = require('./orgHealth');
const { isLoginBlockedAccount } = require('../auth/accountStatusGate');

orgHealth._setStore({
    upsertProblem: async () => ({ inserted: true, reopened: false, count: 1 }),
    appendEvent: async () => ({ id: 'ev' }),
    resolveProblems: async () => 1,
});

let groupsByUid = {};
let ncUserList = [];
let disabledUids = [];
const realFetch = global.fetch;
const json = (body) => ({ ok: true, status: 200, json: async () => body });

beforeEach(() => {
    users.clear();
    groupsByUid = { admin: ['admin'] }; ncUserList = []; disabledUids = [];
    global.fetch = /** @type {any} */ (async (url) => {
        const u = new URL(url);
        if (u.pathname.endsWith('/cloud/users/disabled')) {
            const page = disabledUids.slice(Number(u.searchParams.get('offset')) || 0);
            return json({ ocs: { data: { users: page.length ? Object.fromEntries(page.map((id) => [id, { id }])) : [] } } });
        }
        const m = u.pathname.match(/\/cloud\/users\/([^/]+)(\/groups)?/);
        if (m) {
            const uid = decodeURIComponent(m[1]);
            if (m[2]) return json({ ocs: { data: { groups: groupsByUid[uid] || [] } } });
            return json({ ocs: { data: { id: uid, enabled: !disabledUids.includes(uid), email: `${uid}@example.com`, displayname: uid } } });
        }
        if (u.pathname.endsWith('/apps/app_api/api/v1/users')) return json({ ocs: { data: ncUserList } });
        return json({ ocs: { data: [] } });
    });
});
test.after(() => { global.fetch = realFetch; orgHealth._setStore(null); restore(); });

function seed(ncUid) {
    const user = { id: `nc_${ORG.id}_${ncUid}`, nc_uid: ncUid, status: 'active', email: `${ncUid}@example.com`, displayName: ncUid, groups: [], organizationId: ORG.id, provider: 'nextcloud_connector' };
    users.set(user.id, user);
    return user;
}
const maySignIn = (user) => !isLoginBlockedAccount(user);

test('an account disabled in Nextcloud cannot sign in, and can again once it is enabled', async () => {
    const bob = seed('bob');
    assert.equal(maySignIn(bob), true);

    disabledUids = ['bob'];
    await sync.applyUserCreated(MIRROR_ALL, 'bob');
    assert.equal(bob.status, 'inactive');
    assert.equal(maySignIn(bob), false);

    disabledUids = [];
    await sync.applyUserCreated(MIRROR_ALL, 'bob');
    assert.equal(bob.status, 'active');
    assert.equal(maySignIn(bob), true);
});

test('an account outside the sync selection cannot sign in, and can again once the selection admits it', async () => {
    const alice = seed('alice');

    groupsByUid.alice = ['visitors'];
    await sync.applyGroupMemberChange(ORG, 'alice');
    assert.equal(alice.status, 'inactive');
    assert.equal(maySignIn(alice), false);

    groupsByUid.alice = ['staff'];
    await sync.applyGroupMemberChange(ORG, 'alice');
    assert.equal(alice.status, 'active');
    assert.equal(maySignIn(alice), true);
});

test('an account removed from Nextcloud cannot sign in', async () => {
    const bob = seed('bob');
    await sync.applyUserDeleted(MIRROR_ALL, 'bob');
    assert.equal(bob.status, 'inactive');
    assert.equal(maySignIn(bob), false);
});

test('full sync: an account that left Nextcloud cannot sign in, and can again once it is back', async () => {
    const bob = seed('bob');

    ncUserList = [];
    await sync.runFullSync(MIRROR_ALL);
    assert.equal(bob.status, 'inactive');
    assert.equal(maySignIn(bob), false);

    ncUserList = ['bob'];
    await sync.runFullSync(MIRROR_ALL);
    assert.equal(bob.status, 'active');
    assert.equal(maySignIn(bob), true);
});

test('full sync: an account disabled in Nextcloud cannot sign in, and can again once it is enabled', async () => {
    const bob = seed('bob');
    ncUserList = ['bob'];

    disabledUids = ['bob'];
    await sync.runFullSync(MIRROR_ALL);
    assert.equal(bob.status, 'inactive');
    assert.equal(maySignIn(bob), false);

    disabledUids = [];
    await sync.runFullSync(MIRROR_ALL);
    assert.equal(bob.status, 'active');
    assert.equal(maySignIn(bob), true);
});
