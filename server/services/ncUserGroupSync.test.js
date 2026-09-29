/**
 * ncUserGroupSync — the access decisions the 6-hourly backstop makes.
 *
 * Regression this file exists for: the existing-user branch reactivated
 * ANY inactive user before it knew their groups and without consulting
 * shouldMirrorUser (which only gated the create path). Every user that
 * applyGroupMemberChange had deactivated for falling outside
 * selective_groups came back at the next backstop run — an access decision
 * silently undone every six hours.
 *
 * Also pinned: the v2 (body-bound) HMAC — this module was the last v1
 * signer, and the connector's v1 acceptance is explicitly temporary — and
 * the impersonation allow-list on the service-level proxy.
 *
 * Fake stores + fetch; no Postgres, no network.
 *
 * Run: node --test server/services/ncUserGroupSync.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const crypto = require('crypto');

const TENANT_KEY = 'k'.repeat(64);
const ORG = {
    id: 'org-1',
    connector_callback_url: 'https://cloud.example.com/index.php/apps/app_api/proxy/bee_flow',
    nc_admin_uid: 'admin',
    nc_sync_mode: 'selective_groups',
    ncSyncGroups: ['staff'],
};

const state = { users: new Map(), byNcUid: new Map(), updates: [], groups: new Map() };

function inject(rel, exports) {
    const resolved = require.resolve(path.join(__dirname, rel));
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
inject('../stores/userStore.js', {
    getUserByNcUid: async (orgId, ncUid) => state.byNcUid.get(`${orgId}|${ncUid}`) || null,
    getUser: async (id) => state.users.get(id) || null,
    getAllUsers: async () => [...state.users.values()],
    getAllGroups: async () => [...state.groups.values()],
    updateUser: async (id, updates) => { state.updates.push({ id, updates }); },
    createUserWithSeatCheck: async () => ({ created: true }),
    updateOrganization: async () => {},
    createGroup: async () => {},
});
inject('../stores/configStore.js', {
    getSecret: async (k) => (k === `connector_tenant_key_${ORG.id}` ? TENANT_KEY : null),
    getConfig: async () => null,
});

const sync = require('./ncUserGroupSync');

// ── fetch stub ──────────────────────────────────────────────────────────────
let requests = [];
let groupsByUid = {};
let usersByUid = {};
const realFetch = global.fetch;

function installFetch() {
    global.fetch = async (url, options = {}) => {
        const u = new URL(url);
        requests.push({ url: u.pathname + u.search, headers: options.headers || {} });
        const uidMatch = u.pathname.match(/\/cloud\/users\/([^/]+)(\/groups)?/);
        if (uidMatch) {
            const uid = decodeURIComponent(uidMatch[1]);
            const body = uidMatch[2]
                ? { ocs: { data: { groups: groupsByUid[uid] || [] } } }
                : { ocs: { data: usersByUid[uid] || { email: `${uid}@example.com`, displayname: uid } } };
            return { ok: true, status: 200, json: async () => body };
        }
        return { ok: true, status: 200, json: async () => ({ ocs: { data: [] } }) };
    };
}

function seedExistingUser({ ncUid, status }) {
    const user = { id: `nc_${ORG.id}_${ncUid}`, nc_uid: ncUid, status, email: `${ncUid}@example.com`, displayName: ncUid, groups: [], organizationId: ORG.id, provider: 'nextcloud_connector' };
    state.users.set(user.id, user);
    state.byNcUid.set(`${ORG.id}|${ncUid}`, user);
    return user;
}

beforeEach(() => {
    state.users.clear(); state.byNcUid.clear(); state.updates.length = 0; state.groups.clear();
    requests = []; groupsByUid = {}; usersByUid = {};
    installFetch();
});

// ── The reactivation bug ────────────────────────────────────────────────────

test('an inactive user OUTSIDE the sync mode is not resurrected', async () => {
    seedExistingUser({ ncUid: 'bob', status: 'inactive' });
    groupsByUid.bob = ['contractors']; // not in ncSyncGroups
    await sync.applyUserCreated(ORG, 'bob');
    const statusWrites = state.updates.filter(u => 'status' in u.updates);
    assert.deepEqual(statusWrites, [],
        'selective_groups excluded this user — the backstop must not hand access back');
});

test('an inactive user INSIDE the sync mode is reactivated', async () => {
    seedExistingUser({ ncUid: 'alice', status: 'inactive' });
    groupsByUid.alice = ['staff'];
    await sync.applyUserCreated(ORG, 'alice');
    const statusWrites = state.updates.filter(u => 'status' in u.updates);
    assert.equal(statusWrites.length, 1);
    assert.equal(statusWrites[0].updates.status, 'active');
});

test('a transient groups failure never upgrades status (fail-closed)', async () => {
    seedExistingUser({ ncUid: 'alice', status: 'inactive' });
    const stub = global.fetch;
    global.fetch = async (url, opts) => {
        if (String(url).includes('/groups')) throw new Error('OCS down');
        return stub(url, opts);
    };
    await sync.applyUserCreated(ORG, 'alice');
    assert.deepEqual(state.updates.filter(u => 'status' in u.updates), [],
        'a Nextcloud hiccup must not be a reason to re-enable an account');
});

test('an ACTIVE user outside the sync mode is left alone by this path', async () => {
    // applyGroupMemberChange owns deactivation; applyUserCreated must not
    // start flipping active users off as a side effect of the fix.
    seedExistingUser({ ncUid: 'carol', status: 'active' });
    groupsByUid.carol = ['contractors'];
    await sync.applyUserCreated(ORG, 'carol');
    assert.deepEqual(state.updates.filter(u => 'status' in u.updates), []);
});

test('identity + group refresh still propagate for an active user', async () => {
    seedExistingUser({ ncUid: 'dave', status: 'active' });
    usersByUid.dave = { email: 'new@example.com', displayname: 'Dave New' };
    groupsByUid.dave = ['staff'];
    await sync.applyUserCreated(ORG, 'dave');
    const merged = Object.assign({}, ...state.updates.map(u => u.updates));
    assert.equal(merged.email, 'new@example.com');
    assert.equal(merged.displayName, 'Dave New');
    assert.deepEqual(merged.groups, [`nc_${ORG.id}_staff`]);
});

test('mirror_all reactivates unless an excluded group applies', async () => {
    const org = { ...ORG, nc_sync_mode: 'mirror_all', ncSyncGroups: [], ncSyncExcludedGroups: ['blocked'] };
    seedExistingUser({ ncUid: 'erin', status: 'inactive' });
    groupsByUid.erin = ['blocked'];
    await sync.applyUserCreated(org, 'erin');
    assert.deepEqual(state.updates.filter(u => 'status' in u.updates), [], 'excluded group must still block');

    state.updates.length = 0;
    groupsByUid.erin = ['everyone'];
    await sync.applyUserCreated(org, 'erin');
    assert.equal(state.updates.filter(u => 'status' in u.updates)[0]?.updates.status, 'active');
});

// ── v2 HMAC + impersonation allow-list ──────────────────────────────────────

test('service-level reads sign the v2 (body-bound) form the connector verifies', async () => {
    seedExistingUser({ ncUid: 'alice', status: 'active' });
    groupsByUid.alice = ['staff'];
    await sync.applyUserCreated(ORG, 'alice');

    assert.ok(requests.length > 0, 'expected OCS traffic');
    const req = requests[0];
    const [ts, sig] = String(req.headers['X-Beeflow-Sig']).split('.');
    const emptyHash = crypto.createHash('sha256').update('').digest('hex');
    // Signed over the path the CONNECTOR sees: Nextcloud's proxy strips the
    // callback URL's own prefix, so the signature covers `/nc/...` only.
    const connectorPath = req.url.slice(req.url.indexOf('/nc/'));
    const expected = crypto.createHmac('sha256', TENANT_KEY)
        .update(`${ts}\nGET\n${decodeURIComponent(connectorPath)}\n${req.headers['X-Beeflow-NC-Uid']}\n${emptyHash}`)
        .digest('hex');
    assert.equal(sig, expected,
        'must sign v2 — the connector accepts the bodiless v1 form only "for one release", '
        + 'and this module was the last v1 signer');
});

test('impersonation is limited to the org admin, the synced uid, or anonymous', () => {
    // The uid handed to the connector becomes AppAPI impersonation: whoever
    // it names, Nextcloud answers as. Today every caller is service-level,
    // but the guard makes that a property of the code, not of the call sites.
    assert.throws(() => sync._assertImpersonatable(ORG, 'victim'), /Refusing to impersonate/);
    assert.equal(sync._assertImpersonatable(ORG, 'admin'), 'admin', 'group enumeration needs admin context');
    assert.equal(sync._assertImpersonatable(ORG, ''), '', 'the anonymous/service context stays available');
});

test('the synced uid is impersonatable only for the duration of its sync', async () => {
    seedExistingUser({ ncUid: 'alice', status: 'active' });
    groupsByUid.alice = ['staff'];
    // During the sync the uid is allowed — that is how fetchNcUser works at all.
    await sync.applyUserCreated(ORG, 'alice');
    assert.ok(requests.some(r => r.headers['X-Beeflow-NC-Uid'] === 'alice'));
    // Once it returns, the permission is gone again.
    assert.throws(() => sync._assertImpersonatable(ORG, 'alice'), /Refusing to impersonate/,
        'the allow-list must not leak beyond the sync it was opened for');
});

test('group enumeration impersonates the stored org admin', async () => {
    await sync.listNcGroups(ORG);
    assert.equal(requests.at(-1).headers['X-Beeflow-NC-Uid'], 'admin');
});

test.after(() => { global.fetch = realFetch; });

// ── Finding from the pre-production security review ─────────────────────────

test('two overlapping syncs of the same uid do not revoke each other\'s permission', async () => {
    // The allow-list used a boolean "did I add it?" flag, so when two syncs of
    // one uid overlapped — the 6-hourly backstop while a webhook sync runs, or
    // a manual "Sync now" — the second added nothing and the FIRST to finish
    // deleted the entry underneath it. Its next OCS read then threw inside the
    // catch that swallows transient failures, so it completed silently with no
    // groups and no status change: an access decision quietly skipped.
    seedExistingUser({ ncUid: 'alice', status: 'inactive' });
    groupsByUid.alice = ['staff'];

    let release;
    const gate = new Promise((r) => { release = r; });
    const realFetch = global.fetch;
    let firstUserCall = true;
    global.fetch = async (url, opts) => {
        // Hold the FIRST sync inside its user lookup so the second overtakes it.
        if (firstUserCall && String(url).includes('/cloud/users/alice?')) {
            firstUserCall = false;
            await gate;
        }
        return realFetch(url, opts);
    };
    try {
        const slow = sync.applyUserCreated(ORG, 'alice');
        const fast = sync.applyUserCreated(ORG, 'alice');
        await fast;          // finishes first, must NOT drop the shared entry
        release();
        await slow;
    } finally {
        global.fetch = realFetch;
    }

    // The slow sync still saw its groups, so it still made the access decision.
    const statusWrites = state.updates.filter(u => 'status' in u.updates);
    assert.ok(statusWrites.length >= 1,
        'the overtaken sync must still complete its reactivation, not fail silently');
    assert.equal(statusWrites[0].updates.status, 'active');
});

test('the allow-list is scoped to one organisation', async () => {
    // The entry recorded "this uid may be impersonated" without saying for
    // whom, so one tenant's in-flight sync briefly widened what another
    // tenant's could ask for.
    const OTHER = { ...ORG, id: 'org-2' };
    assert.throws(() => sync._assertImpersonatable(OTHER, 'alice'), /Refusing to impersonate/);
});

// ── Full sync outcome on org health (backstop backoff + admin visibility) ────
//
// runFullSync returns before it writes ncLastSyncAt when the NC user list
// cannot be read, so a broken connector was retried and logged on every
// backstop tick. It now opens connector.nc_sync_failed (the row the backstop
// backs off on) and resolves it on success. The store behind the emitter is a
// stub, so no Postgres.

const orgHealth = require('./orgHealth');

function stubHealthStore() {
    const calls = { upsert: [], resolve: [] };
    orgHealth._setStore({
        upsertProblem: async (p) => { calls.upsert.push(p); return { inserted: true, reopened: false, count: 1 }; },
        appendEvent: async () => ({ id: 'ev' }),
        resolveProblems: async (id, codes) => { calls.resolve.push({ id, codes }); return 1; },
    });
    return calls;
}
test.after(() => { orgHealth._setStore(null); });

const USERS_PATH = '/apps/app_api/api/v1/users';

function failUsersList(status) {
    const ok = global.fetch;
    global.fetch = async (url, options) => {
        if (String(url).includes(USERS_PATH)) {
            requests.push({ url: new URL(url).pathname, headers: options?.headers || {} });
            return { ok: false, status, json: async () => ({}) };
        }
        return ok(url, options);
    };
}

test('a full sync that cannot read the NC user list opens connector.nc_sync_failed, URL-free', async () => {
    const calls = stubHealthStore();
    failUsersList(401);

    const result = await sync.runFullSync(ORG);

    assert.match(result.error, /HTTP 401/);
    assert.equal(calls.upsert.length, 1);
    const p = calls.upsert[0];
    assert.equal(p.code, sync.NC_SYNC_FAILED);
    assert.equal(p.code, 'connector.nc_sync_failed');
    assert.equal(p.category, 'connector');
    assert.equal(p.severity, 'warning', 'a failing user sync must not mark the org as unable to chat');
    assert.equal(p.organizationId, ORG.id);
    assert.equal(p.source, 'ncSync');
    assert.deepEqual(p.meta, { stage: 'list_users', reason: 'http_401', httpStatus: 401 });
    const stored = JSON.stringify(p);
    assert.ok(!stored.includes('cloud.example.com') && !stored.includes('/nc/'),
        'the health row must not carry the proxy URL or path');
    assert.deepEqual(calls.resolve, [], 'a failure must not resolve anything');
});

test('a successful full sync resolves connector.nc_sync_failed', async () => {
    const calls = stubHealthStore();
    const result = await sync.runFullSync(ORG);
    assert.equal(result.error, undefined);
    assert.deepEqual(calls.upsert, []);
    assert.deepEqual(calls.resolve, [{ id: ORG.id, codes: ['connector.nc_sync_failed'] }]);
});

test('runFullSync has no backoff of its own: "Sync now" right after a failure still reaches Nextcloud', async () => {
    // The 24h backoff lives in the backstop only. The manual route calls
    // runFullSync directly, so an admin who fixed the connector can retry at
    // once — and that success closes the problem the backstop backs off on.
    const calls = stubHealthStore();
    const working = global.fetch;
    failUsersList(404);
    assert.match((await sync.runFullSync(ORG)).error, /HTTP 404/);

    global.fetch = working;
    requests = [];
    const retry = await sync.runFullSync(ORG);
    assert.equal(retry.error, undefined);
    assert.ok(requests.some(r => r.url.includes(USERS_PATH)), 'the retry must actually ask Nextcloud');
    assert.deepEqual(calls.resolve, [{ id: ORG.id, codes: ['connector.nc_sync_failed'] }]);
});

test('summarizeSyncError classifies from an allow-list and never echoes the message', () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    assert.deepEqual(sync.summarizeSyncError(timeout), { stage: 'list_users', reason: 'timeout' });

    const refused = new TypeError('fetch failed');
    refused.cause = { code: 'ECONNREFUSED' };
    assert.deepEqual(sync.summarizeSyncError(refused), { stage: 'list_users', reason: 'unreachable', errorCode: 'ECONNREFUSED' });

    const noKey = new Error('Org org-1 has no tenant key');
    assert.deepEqual(sync.summarizeSyncError(noKey), { stage: 'list_users', reason: 'no_tenant_key' });

    const noUrl = new Error('Org org-1 has no connector_callback_url');
    assert.deepEqual(sync.summarizeSyncError(noUrl), { stage: 'list_users', reason: 'no_callback_url' });

    const odd = new Error('something at https://secret.example.com/?token=abc');
    const s = sync.summarizeSyncError(odd);
    assert.deepEqual(s, { stage: 'list_users', reason: 'error' });
    assert.ok(!JSON.stringify(s).includes('secret.example.com'));
});
