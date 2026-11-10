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

// The proxy call goes through nextcloudFetch (the Nextcloud host gate). With
// the private-hosts switch on it uses the global fetch, which is what this
// file stubs; without it the guarded undici client would resolve the fake
// host for real.
process.env.NEXTCLOUD_ALLOW_PRIVATE_HOSTS = '1';

const TENANT_KEY = 'k'.repeat(64);
const ORG = {
    id: 'org-1',
    connector_callback_url: 'https://cloud.example.com/index.php/apps/app_api/proxy/bee_flow',
    nc_admin_uid: 'admin',
    nc_sync_mode: 'selective_groups',
    ncSyncGroups: ['staff'],
    nc_onboarding_completed_at: '2026-01-05T09:00:00Z', // the sync mode is chosen
};

const state = { users: new Map(), byNcUid: new Map(), updates: [], groups: new Map(), creates: [] };

function inject(rel, exports) {
    const resolved = require.resolve(path.join(__dirname, rel));
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
inject('../stores/userStore.js', {
    getUserByNcUid: async (orgId, ncUid) => state.byNcUid.get(`${orgId}|${ncUid}`) || null,
    getUser: async (id) => state.users.get(id) || null,
    getAllUsers: async () => [...state.users.values()],
    hasMirroredNcUsers: async (orgId, afterDay = null) => [...state.users.values()].some(u => u.organizationId === orgId
        && u.provider === 'nextcloud_connector' && u.nc_uid && !['org_admin', 'admin'].includes(u.orgRole || '')
        && (!afterDay || String(u.createdAt || '') > afterDay)),
    getAllGroups: async () => [...state.groups.values()],
    updateUser: async (id, updates) => { state.updates.push({ id, updates }); },
    createUserWithSeatCheck: async (u) => { state.creates.push(u); return { created: true }; },
    updateOrganization: async () => {},
    createGroup: async () => {},
});
inject('../stores/configStore.js', {
    getSecret: async (k) => (k === `connector_tenant_key_${ORG.id}` ? TENANT_KEY : null),
    getConfig: async () => null,
});

const sync = require('./ncUserGroupSync');
const USERS_PATH = '/apps/app_api/api/v1/users';

// ── fetch stub ──────────────────────────────────────────────────────────────
let requests = [];
let groupsByUid = {};
let usersByUid = {};
let ncUserList = [];   // what AppAPI's user list answers
let disabledUids = []; // what Nextcloud reports as disabled, to its admin
const realFetch = global.fetch;

const json = (body) => ({ ok: true, status: 200, json: async () => body });

// Nextcloud keys the disabled list by uid, and sends an empty one as [].
function disabledAnswer(u) {
    const limit = Number(u.searchParams.get('limit')) || disabledUids.length;
    const page = disabledUids.slice(Number(u.searchParams.get('offset')) || 0).slice(0, limit);
    return { ocs: { data: { users: page.length ? Object.fromEntries(page.map((id) => [id, { id }])) : [] } } };
}

function installFetch() {
    global.fetch = async (url, options = {}) => {
        const u = new URL(url);
        const headers = options.headers || {};
        requests.push({ url: u.pathname + u.search, headers });
        if (u.pathname.endsWith('/cloud/users/disabled')) return json(disabledAnswer(u));
        const uidMatch = u.pathname.match(/\/cloud\/users\/([^/]+)(\/groups)?/);
        if (uidMatch) {
            const uid = decodeURIComponent(uidMatch[1]);
            if (uidMatch[2]) return json({ ocs: { data: { groups: groupsByUid[uid] || [] } } });
            const data = usersByUid[uid] || { email: `${uid}@example.com`, displayname: uid };
            // Only an administrator is told whether an account is enabled.
            const asAdmin = headers['X-Beeflow-NC-Uid'] === ORG.nc_admin_uid;
            return json({ ocs: { data: asAdmin ? { id: uid, enabled: !disabledUids.includes(uid), ...data } : data } });
        }
        if (u.pathname.endsWith(USERS_PATH)) return json({ ocs: { data: ncUserList } });
        return json({ ocs: { data: [] } });
    };
}

/** Let one kind of request fail (or answer something else), the rest as usual. */
function intercept(matches, answer) {
    const usual = global.fetch;
    global.fetch = async (url, options) => (matches(String(url), options?.headers || {}) ? answer() : usual(url, options));
}
const statusWrites = () => state.updates.filter(u => 'status' in u.updates);

function seedExistingUser({ ncUid, status, orgId = ORG.id }) {
    const user = { id: `nc_${orgId}_${ncUid}`, nc_uid: ncUid, status, email: `${ncUid}@example.com`, displayName: ncUid, groups: [], organizationId: orgId, provider: 'nextcloud_connector' };
    state.users.set(user.id, user);
    state.byNcUid.set(`${orgId}|${ncUid}`, user);
    return user;
}

beforeEach(() => {
    state.users.clear(); state.byNcUid.clear(); state.updates.length = 0; state.groups.clear(); state.creates.length = 0;
    requests = []; groupsByUid = { admin: ['admin'] }; usersByUid = {}; ncUserList = []; disabledUids = [];
    delete process.env.NEXTCLOUD_SYNC_DISABLED_PAGE_SIZE;
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
    failUsersList(503);

    const result = await sync.runFullSync(ORG);

    assert.match(result.error, /HTTP 503/);
    assert.equal(calls.upsert.length, 1);
    const p = calls.upsert[0];
    assert.equal(p.code, sync.NC_SYNC_FAILED);
    assert.equal(p.code, 'connector.nc_sync_failed');
    assert.equal(p.category, 'connector');
    assert.equal(p.severity, 'warning', 'a failing user sync must not mark the org as unable to chat');
    assert.equal(p.organizationId, ORG.id);
    assert.equal(p.source, 'ncSync');
    assert.deepEqual(p.meta, { stage: 'list_users', reason: 'http_503', httpStatus: 503 });
    const stored = JSON.stringify(p);
    assert.ok(!stored.includes('cloud.example.com') && !stored.includes('/nc/'),
        'the health row must not carry the proxy URL or path');
    assert.deepEqual(calls.resolve, [], 'a failure must not resolve anything');
});

test('a 401 on the user list opens connector.key_divergence, a 404 connector.app_removed, a 503 connector.nc_sync_failed', async () => {
    for (const [status, code] of [[401, 'connector.key_divergence'], [404, 'connector.app_removed'], [503, 'connector.nc_sync_failed']]) {
        const calls = stubHealthStore();
        failUsersList(status);
        await sync.runFullSync(ORG);
        assert.deepEqual(calls.upsert.map(p => p.code), [code], `HTTP ${status}`);
        assert.equal(calls.upsert[0].severity, code === 'connector.key_divergence' ? 'critical' : 'warning');
        assert.equal(calls.upsert[0].meta.httpStatus, status);
    }
});

test('a successful full sync resolves the sync failure codes, and the admin-rights code when the disabled accounts were read', async () => {
    const calls = stubHealthStore();
    const result = await sync.runFullSync(ORG);
    assert.equal(result.error, undefined);
    assert.deepEqual(calls.upsert, []);
    assert.deepEqual(calls.resolve, [{ id: ORG.id, codes: ['connector.nc_sync_failed', 'connector.app_removed', 'connector.key_divergence', 'connector.nc_admin_rights_missing'] }]);
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
    assert.deepEqual(calls.resolve, [{ id: ORG.id, codes: ['connector.nc_sync_failed', 'connector.app_removed', 'connector.key_divergence', 'connector.nc_admin_rights_missing'] }]);
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

// ── Accounts that are disabled in Nextcloud ─────────────────────────────────
//
// A disabled account counts as gone: deactivated, and active again once
// Nextcloud reports it enabled. A status changes only on a definite answer.

const MIRROR_ALL = { ...ORG, nc_sync_mode: 'mirror_all', ncSyncGroups: [] };
const DISABLED_PATH = '/cloud/users/disabled';
const fails = (status) => () => ({ ok: false, status, json: async () => ({}) });

test('full sync: a disabled account is deactivated and no account is created for one', async () => {
    stubHealthStore();
    const bob = seedExistingUser({ ncUid: 'bob', status: 'active' });
    seedExistingUser({ ncUid: 'alice', status: 'active' });
    ncUserList = ['alice', 'bob', 'newdisabled', 'newenabled'];
    disabledUids = ['bob', 'newdisabled'];

    const result = await sync.runFullSync(MIRROR_ALL);

    assert.deepEqual(statusWrites(), [{ id: bob.id, updates: { status: 'inactive' } }]);
    assert.deepEqual(state.creates.map(u => u.ncUid), ['newenabled']);
    assert.equal(result.deactivated, 1);
    assert.equal(result.created, 1);
    assert.deepEqual(result.errors, []);
    assert.ok(!requests.some(r => r.headers['X-Beeflow-NC-Uid'] === 'bob'), 'a disabled account is not read any further');
});

test('full sync: an account that is enabled again is activated again', async () => {
    stubHealthStore();
    const bob = seedExistingUser({ ncUid: 'bob', status: 'inactive' });
    ncUserList = ['bob'];
    disabledUids = [];

    const result = await sync.runFullSync(MIRROR_ALL);

    assert.deepEqual(statusWrites(), [{ id: bob.id, updates: { status: 'active' } }]);
    assert.equal(result.reactivated, 1);
    assert.equal(result.deactivated, 0);
});

test('full sync: an account that is still disabled stays inactive', async () => {
    stubHealthStore();
    seedExistingUser({ ncUid: 'bob', status: 'inactive' });
    ncUserList = ['bob'];
    disabledUids = ['bob'];
    await sync.runFullSync(MIRROR_ALL);
    assert.deepEqual(statusWrites(), []);
});

test('full sync: a failed read of the disabled accounts changes no status', async () => {
    for (const answer of [
        fails(503),
        fails(403),
        () => { throw new Error('socket hang up'); },
        () => json({ ocs: { data: {} } }),                         // no list in the answer
        () => json({ ocs: { data: { users: 'none' } } }),          // not a list
        () => json({ ocs: { data: { users: [{ name: 'bob' }] } } }), // entries without an id
    ]) {
        state.updates.length = 0;
        const calls = stubHealthStore();
        seedExistingUser({ ncUid: 'bob', status: 'active' });     // disabled in Nextcloud
        seedExistingUser({ ncUid: 'carol', status: 'inactive' }); // enabled in Nextcloud
        ncUserList = ['bob', 'carol'];
        disabledUids = ['bob'];
        installFetch();
        intercept((url) => url.includes(DISABLED_PATH), answer);

        const result = await sync.runFullSync(MIRROR_ALL);

        assert.deepEqual(statusWrites(), [], 'nobody is deactivated and nobody is activated again');
        assert.deepEqual(result.errors, [{ stage: 'disabled_accounts', error: 'lookup_failed' }]);
        assert.equal(result.error, undefined, 'the sync itself still completes');
        assert.equal(calls.resolve.length, 1);
        assert.deepEqual(calls.resolve[0].codes, ['connector.nc_sync_failed', 'connector.app_removed', 'connector.key_divergence'],
            'the disabled accounts were not read: the admin-rights code stays open');
    }
});

test('full sync: a list that stops halfway changes no status', async () => {
    stubHealthStore();
    process.env.NEXTCLOUD_SYNC_DISABLED_PAGE_SIZE = '2';
    for (const uid of ['a', 'b', 'c']) seedExistingUser({ ncUid: uid, status: 'active' });
    seedExistingUser({ ncUid: 'carol', status: 'inactive' });
    ncUserList = ['a', 'b', 'c', 'carol'];
    disabledUids = ['a', 'b', 'c'];
    intercept((url) => url.includes(DISABLED_PATH) && url.includes('offset=2'), fails(500));

    const result = await sync.runFullSync(MIRROR_ALL);

    assert.deepEqual(statusWrites(), [], 'the first page alone is not acted on');
    assert.deepEqual(result.errors, [{ stage: 'disabled_accounts', error: 'lookup_failed' }]);
});

test('full sync: the disabled accounts are read page by page, the page size is configurable, 0 reads all at once', async () => {
    for (const [size, expected] of [['2', ['limit=2&offset=0', 'limit=2&offset=2']], ['0', ['']], [undefined, ['limit=500&offset=0']]]) {
        stubHealthStore();
        state.updates.length = 0; requests = [];
        if (size === undefined) delete process.env.NEXTCLOUD_SYNC_DISABLED_PAGE_SIZE;
        else process.env.NEXTCLOUD_SYNC_DISABLED_PAGE_SIZE = size;
        for (const uid of ['a', 'b', 'c']) seedExistingUser({ ncUid: uid, status: 'active' });
        ncUserList = ['a', 'b', 'c'];
        disabledUids = ['a', 'b', 'c'];

        await sync.runFullSync(MIRROR_ALL);

        const pages = requests.filter(r => r.url.includes(DISABLED_PATH));
        assert.deepEqual(pages.map(r => r.url.split('format=json')[1].replace(/^&/, '')), expected, `page size ${size}`);
        assert.ok(pages.every(r => r.headers['X-Beeflow-NC-Uid'] === 'admin'), 'read as the stored admin');
        assert.deepEqual(statusWrites().map(u => u.updates.status), ['inactive', 'inactive', 'inactive'], `page size ${size}`);
    }
});

test('full sync: the list of a stored admin who is not a Nextcloud admin is not acted on', async () => {
    // Nextcloud answers a non-admin with an empty list, which says nothing.
    stubHealthStore();
    groupsByUid.admin = ['staff'];
    seedExistingUser({ ncUid: 'carol', status: 'inactive' });
    ncUserList = ['carol'];
    const result = await sync.runFullSync(MIRROR_ALL);
    assert.deepEqual(statusWrites(), []);
    assert.deepEqual(result.errors, [{ stage: 'disabled_accounts', error: 'lookup_failed' }]);
    assert.ok(!requests.some(r => r.url.includes(DISABLED_PATH)));
});

test('full sync: without a stored admin no status changes for being disabled or enabled', async () => {
    stubHealthStore();
    seedExistingUser({ ncUid: 'carol', status: 'inactive' });
    ncUserList = ['carol'];
    await sync.runFullSync({ ...MIRROR_ALL, nc_admin_uid: '' });
    assert.deepEqual(statusWrites(), []);
});

test('full sync: a disabled account that is pending or suspended keeps that status', async () => {
    stubHealthStore();
    seedExistingUser({ ncUid: 'pat', status: 'pending' });
    seedExistingUser({ ncUid: 'sam', status: 'suspended' });
    ncUserList = ['pat', 'sam'];
    disabledUids = ['pat', 'sam'];
    await sync.runFullSync(MIRROR_ALL);
    assert.deepEqual(statusWrites(), []);
});

test('full sync: an account gone from Nextcloud is still deactivated when the disabled accounts cannot be read', async () => {
    stubHealthStore();
    const gone = seedExistingUser({ ncUid: 'gone', status: 'active' });
    ncUserList = [];
    intercept((url) => url.includes(DISABLED_PATH), fails(503));
    await sync.runFullSync(MIRROR_ALL);
    assert.deepEqual(statusWrites(), [{ id: gone.id, updates: { status: 'inactive' } }]);
});

test('user event: a disabled account is deactivated, with one read as the stored admin', async () => {
    const bob = seedExistingUser({ ncUid: 'bob', status: 'active' });
    disabledUids = ['bob'];

    const r = await sync.applyUserCreated(MIRROR_ALL, 'bob');

    assert.deepEqual(r, { action: 'deactivate', userId: bob.id, reason: 'nc_disabled' });
    assert.deepEqual(state.updates, [{ id: bob.id, updates: { status: 'inactive' } }]);
    assert.deepEqual(requests.map(q => q.headers['X-Beeflow-NC-Uid']), ['admin']);
});

test('user event: no account is created for a disabled account', async () => {
    disabledUids = ['newbie'];
    const r = await sync.applyUserCreated(MIRROR_ALL, 'newbie');
    assert.deepEqual(r, { action: 'skip', reason: 'nc_disabled' });
    assert.deepEqual(state.creates, []);
});

test('user event: an account that is enabled again is activated again', async () => {
    const bob = seedExistingUser({ ncUid: 'bob', status: 'inactive' });
    await sync.applyUserCreated(MIRROR_ALL, 'bob');
    assert.deepEqual(statusWrites(), [{ id: bob.id, updates: { status: 'active' } }]);
});

test('user event: a disabled account that is pending or suspended keeps that status', async () => {
    for (const status of ['pending', 'suspended', 'inactive']) {
        state.updates.length = 0;
        seedExistingUser({ ncUid: 'pat', status });
        disabledUids = ['pat'];
        assert.deepEqual(await sync.applyUserCreated(MIRROR_ALL, 'pat'), { action: 'noop' });
        assert.deepEqual(state.updates, []);
    }
});

test('user event: a failed or incomplete read of the account changes no status', async () => {
    const adminRead = (url, headers) => url.includes('/cloud/users/bob?') && headers['X-Beeflow-NC-Uid'] === 'admin';
    for (const answer of [
        fails(503),
        fails(404),
        () => { throw new Error('timeout'); },
        () => json({ ocs: { data: { id: 'bob', email: 'bob@example.com' } } }),         // no `enabled`
        () => json({ ocs: { data: { id: 'bob', enabled: 'maybe' } } }),                 // not a yes or no
        () => json({ ocs: { data: { id: 'someone-else', enabled: false } } }),          // about another account
        () => json({ ocs: {} }),
    ]) {
        for (const status of ['active', 'inactive']) {
            state.updates.length = 0;
            seedExistingUser({ ncUid: 'bob', status });
            disabledUids = status === 'active' ? ['bob'] : [];
            installFetch();
            intercept(adminRead, answer);
            await sync.applyUserCreated(MIRROR_ALL, 'bob');
            assert.deepEqual(statusWrites(), [], `status ${status} must stay`);
        }
    }
});

test('user event: without a stored admin an inactive account is not activated', async () => {
    seedExistingUser({ ncUid: 'bob', status: 'inactive' });
    await sync.applyUserCreated({ ...MIRROR_ALL, nc_admin_uid: '' }, 'bob');
    assert.deepEqual(statusWrites(), []);
});

test('group event: a disabled account is not activated by a change of groups', async () => {
    seedExistingUser({ ncUid: 'bob', status: 'inactive' });
    groupsByUid.bob = ['staff'];
    disabledUids = ['bob'];
    assert.deepEqual(await sync.applyGroupMemberChange(ORG, 'bob', 'staff'), { action: 'noop' });
    assert.deepEqual(state.updates, []);

    // Not known either way: no change.
    intercept((url, headers) => url.includes('/cloud/users/bob?') && headers['X-Beeflow-NC-Uid'] === 'admin', fails(503));
    assert.deepEqual(await sync.applyGroupMemberChange(ORG, 'bob', 'staff'), { action: 'noop' });
    assert.deepEqual(state.updates, []);
});

test('group event: an enabled account that enters a synced group is activated', async () => {
    const bob = seedExistingUser({ ncUid: 'bob', status: 'inactive' });
    groupsByUid.bob = ['staff'];
    const r = await sync.applyGroupMemberChange(ORG, 'bob', 'staff');
    assert.deepEqual(r, { action: 'reactivate', userId: bob.id });
});

// ── Guests ──────────────────────────────────────────────────────────────────

test('a guest gets no new account by default', async () => {
    groupsByUid['guest@partner.example'] = ['guest_app'];
    const r = await sync.applyUserCreated(MIRROR_ALL, 'guest@partner.example');
    assert.deepEqual(r, { action: 'skip', reason: 'guest' });
    assert.deepEqual(state.creates, []);
});

test('a guest is recognised by the guests backend when the group is not reported', async () => {
    usersByUid.visitor = { email: 'visitor@partner.example', displayname: 'Visitor', backend: 'Guests' };
    const r = await sync.applyUserCreated(MIRROR_ALL, 'visitor');
    assert.deepEqual(r, { action: 'skip', reason: 'guest' });
    assert.deepEqual(state.creates, []);
});

test('a guest gets an account when the groups to sync name the guests group', async () => {
    groupsByUid.visitor = ['guest_app'];
    for (const org of [
        { ...MIRROR_ALL, ncSyncGroups: ['guest_app'] },
        { ...ORG, nc_sync_mode: 'selective_groups', ncSyncGroups: ['staff', 'guest_app'] },
    ]) {
        state.creates.length = 0;
        const r = await sync.applyUserCreated(org, 'visitor');
        assert.equal(r.action, 'create');
        assert.equal(state.creates.length, 1);
    }
});

test('a guest in another synced group still gets no account unless the guests group is named', async () => {
    groupsByUid.visitor = ['guest_app', 'staff'];
    const r = await sync.applyUserCreated(ORG, 'visitor'); // selective_groups: ['staff']
    assert.deepEqual(r, { action: 'skip', reason: 'guest' });
});

test('an excluded guests group keeps guests out even when it is also named for sync', async () => {
    groupsByUid.visitor = ['guest_app'];
    const r = await sync.applyUserCreated({ ...MIRROR_ALL, ncSyncGroups: ['guest_app'], ncSyncExcludedGroups: ['guest_app'] }, 'visitor');
    assert.deepEqual(r, { action: 'skip', reason: 'sync_mode_excludes' });
});

test('a full sync creates accounts for regular users and none for guests', async () => {
    stubHealthStore();
    ncUserList = ['alice', 'guest@partner.example'];
    groupsByUid['guest@partner.example'] = ['guest_app'];
    const result = await sync.runFullSync(MIRROR_ALL);
    assert.deepEqual(state.creates.map(u => u.ncUid), ['alice']);
    assert.equal(result.created, 1);
});

test('a guest who already has an account keeps it', async () => {
    stubHealthStore();
    seedExistingUser({ ncUid: 'visitor', status: 'active' });
    groupsByUid.visitor = ['guest_app'];
    ncUserList = ['visitor'];

    await sync.runFullSync(MIRROR_ALL);
    await sync.applyUserCreated(MIRROR_ALL, 'visitor');
    await sync.applyGroupMemberChange(MIRROR_ALL, 'visitor', 'guest_app');

    assert.deepEqual(statusWrites(), []);
});

// ── One organisation at a time ──────────────────────────────────────────────

test('a disabled account changes users of its own organisation only', async () => {
    stubHealthStore();
    const mine = seedExistingUser({ ncUid: 'bob', status: 'active' });
    const theirs = seedExistingUser({ ncUid: 'bob', status: 'active', orgId: 'org-2' });
    ncUserList = ['bob'];
    disabledUids = ['bob'];

    await sync.runFullSync(MIRROR_ALL);
    assert.deepEqual(state.updates, [{ id: mine.id, updates: { status: 'inactive' } }]);

    state.updates.length = 0;
    mine.status = 'active';
    await sync.applyUserCreated(MIRROR_ALL, 'bob');
    assert.deepEqual(state.updates, [{ id: mine.id, updates: { status: 'inactive' } }]);
    assert.equal(theirs.status, 'active');
    assert.ok(requests.every(r => r.url.startsWith(new URL(ORG.connector_callback_url).pathname)), 'every read goes to this organisation\'s Nextcloud');
});

test('an enabled account activates users of its own organisation only', async () => {
    stubHealthStore();
    const mine = seedExistingUser({ ncUid: 'bob', status: 'inactive' });
    seedExistingUser({ ncUid: 'bob', status: 'inactive', orgId: 'org-2' });
    ncUserList = ['bob'];
    await sync.runFullSync(MIRROR_ALL);
    assert.deepEqual(state.updates.map(u => u.id), [mine.id]);
});

// ── The Bee Flow id of a new user ───────────────────────────────────────────

/** Mirror one account and keep its row, as the store does. */
async function mirror(org, ncUid) {
    const r = await sync.applyUserCreated(org, ncUid);
    if (r.action === 'create') {
        const row = { ...state.creates.at(-1), nc_uid: ncUid };
        state.users.set(row.id, row);
        state.byNcUid.set(`${org.id}|${ncUid}`, row);
    }
    return r;
}
const mainId = (org, uid) => `nc_${org.id}_${String(uid || '').replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 40) || 'user'}`;

test('a new user gets the id nc_<organisation>_<uid with dashes, cut to 40>', async () => {
    const uids = ['alice', 'john.doe', 'jane_roe', 'ann@acme.example', 'Jan de Vries', 'q'.repeat(64)];
    for (const uid of uids) {
        const r = await mirror(MIRROR_ALL, uid);
        assert.equal(r.action, 'create', uid);
        assert.equal(r.userId, mainId(MIRROR_ALL, uid), uid);
    }
    assert.deepEqual(state.creates.map(u => u.id), [
        'nc_org-1_alice', 'nc_org-1_john-doe', 'nc_org-1_jane-roe', 'nc_org-1_ann-acme-example', 'nc_org-1_Jan-de-Vries', `nc_org-1_${'q'.repeat(40)}`,
    ]);
});

test('john.doe then john_doe are two users: the second id carries a hash of its uid', async () => {
    const r1 = await mirror(MIRROR_ALL, 'john.doe');
    const r2 = await mirror(MIRROR_ALL, 'john_doe');
    assert.equal(r1.userId, 'nc_org-1_john-doe');
    assert.match(r2.userId, /^nc_org-1_john-doe-[0-9a-f]{8}$/);
    assert.deepEqual(state.creates.map(u => [u.id, u.ncUid]), [[r1.userId, 'john.doe'], [r2.userId, 'john_doe']]);
    // Each is found again by its uid: nobody is created a second time.
    assert.equal((await mirror(MIRROR_ALL, 'john.doe')).userId, r1.userId);
    assert.equal((await mirror(MIRROR_ALL, 'john_doe')).userId, r2.userId);
    assert.equal(state.creates.length, 2);
});

test('a user row with the id nc_<organisation>_john-doe and the uid john.doe is that account: it is updated, nobody is created', async () => {
    const row = { id: 'nc_org-1_john-doe', nc_uid: 'john.doe', status: 'active', email: 'old@example.com', displayName: 'john.doe', groups: [], organizationId: ORG.id, provider: 'nextcloud_connector' };
    state.users.set(row.id, row);
    state.byNcUid.set(`${ORG.id}|john.doe`, row);
    const r = await sync.applyUserCreated(MIRROR_ALL, 'john.doe');
    assert.equal(r.action, 'update');
    assert.equal(r.userId, 'nc_org-1_john-doe');
    assert.deepEqual(state.creates, []);
});

test('both ids belong to other accounts: nobody is created, the answer says duplicate_id', async () => {
    const first = await mirror(MIRROR_ALL, 'john.doe');
    const second = await mirror(MIRROR_ALL, 'john_doe');
    // Give the second row to another uid, then mirror john_doe as a new account.
    state.byNcUid.delete(`${ORG.id}|john_doe`);
    state.users.get(second.userId).nc_uid = 'someone-else';
    const r = await sync.applyUserCreated(MIRROR_ALL, 'john_doe');
    assert.deepEqual(r, { action: 'skip', reason: 'duplicate_id' });
    assert.equal(state.creates.length, 2);
    assert.equal(first.userId, 'nc_org-1_john-doe');
});

test('the same uid in two organisations gets one id per organisation', async () => {
    const other = { ...MIRROR_ALL, id: 'org-2' };
    const mine = await sync.applyUserCreated(MIRROR_ALL, 'john.doe');
    assert.equal(mine.userId, 'nc_org-1_john-doe');
    // org-2 has no tenant key in this file: its sync reads nothing and creates nobody.
    const theirs = await sync.applyUserCreated(other, 'john.doe');
    assert.equal(theirs.action, 'error');
    assert.deepEqual(state.creates.map(u => u.organizationId), ['org-1']);
});

// ── A user without an e-mail address ────────────────────────────────────────

const { resetSightings } = require('./ncAccountState.mts');
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a user without an e-mail address is skipped and opens auth.missing_email for the organisation', async () => {
    resetSightings();
    const calls = stubHealthStore();
    usersByUid.nomail = { displayname: 'No Mail' };
    const r = await sync.applyUserCreated(MIRROR_ALL, 'nomail');
    await settle();
    assert.deepEqual(r, { action: 'skip', reason: 'no_email' });
    assert.deepEqual(state.creates, []);
    assert.equal(calls.upsert.length, 1);
    const p = calls.upsert[0];
    assert.equal(p.code, 'auth.missing_email');
    assert.equal(p.organizationId, 'org-1');
    assert.equal(p.subjectKey, 'org-1');
    assert.equal(p.source, 'ncSync');
    assert.deepEqual(p.meta, { sub: 'nomail', reason: 'sync_no_email' });
});

test('the health event is raised once per user, however often the sync meets that user', async () => {
    resetSightings();
    const calls = stubHealthStore();
    usersByUid.nomail = { displayname: 'No Mail' };
    usersByUid.other = { displayname: 'Other', email: '' };
    ncUserList = ['nomail', 'other', 'alice'];
    await sync.runFullSync(MIRROR_ALL);
    await sync.runFullSync(MIRROR_ALL);
    await sync.applyUserCreated(MIRROR_ALL, 'nomail');
    await settle();
    const raised = calls.upsert.filter(p => p.code === 'auth.missing_email');
    assert.deepEqual(raised.map(p => p.meta.sub), ['nomail', 'other']);
    // The fake store keeps no created rows, so each run creates alice again.
    assert.deepEqual([...new Set(state.creates.map(u => u.ncUid))], ['alice']);
});

test('a user with an e-mail address raises nothing', async () => {
    resetSightings();
    const calls = stubHealthStore();
    await sync.applyUserCreated(MIRROR_ALL, 'alice');
    await settle();
    assert.deepEqual(calls.upsert, []);
});

test('the same uid without an address in a second organisation is reported for that organisation, not this one', async () => {
    resetSightings();
    const calls = stubHealthStore();
    usersByUid.nomail = { displayname: 'No Mail' };
    await sync.applyUserCreated(MIRROR_ALL, 'nomail');
    // A second organisation with its own key and Nextcloud.
    const OTHER = { ...MIRROR_ALL, id: 'org-2', connector_callback_url: 'https://other.example.com/index.php/apps/app_api/proxy/bee_flow' };
    const configStore = require('../stores/configStore.js');
    const usualSecret = configStore.getSecret;
    configStore.getSecret = async (k) => (k === 'connector_tenant_key_org-2' ? 'o'.repeat(64) : usualSecret(k));
    try {
        await sync.applyUserCreated(OTHER, 'nomail');
        await sync.applyUserCreated(OTHER, 'nomail');
    } finally { configStore.getSecret = usualSecret; }
    await settle();
    assert.deepEqual(calls.upsert.map(p => [p.organizationId, p.subjectKey, p.meta.sub]), [
        ['org-1', 'org-1', 'nomail'],
        ['org-2', 'org-2', 'nomail'],
    ]);
});

// ── Synchronisation starts once the sync mode is chosen ─────────────────────
//
// A newly bound organisation holds the column's own 'mirror_all' and nothing
// else: no completed onboarding, no earlier sync, no mirrored users. Its
// administrators exist already; they are provisioned when it is bound.

const NEWLY_BOUND = { ...MIRROR_ALL, nc_onboarding_completed_at: null, nc_last_sync_at: null };
const NOT_CHOSEN = { action: 'skip', reason: 'sync_mode_not_chosen' };

function seedBootstrapAdmin(org) {
    const admin = seedExistingUser({ ncUid: 'admin', status: 'active', orgId: org.id });
    admin.orgRole = 'org_admin';
    return admin;
}

for (const [label, org] of [['the column default', NEWLY_BOUND], ['no stored mode', { ...NEWLY_BOUND, nc_sync_mode: null }]]) {
    test(`a newly bound organisation (${label}) is not synchronised by a full sync, a user event or a group event`, async () => {
        const calls = stubHealthStore();
        seedBootstrapAdmin(org);
        ncUserList = ['admin', 'alice', 'bob'];
        groupsByUid.alice = ['staff'];

        assert.deepEqual(await sync.runFullSync(org), { skipped: 'sync_mode_not_chosen' });
        assert.deepEqual(await sync.applyUserCreated(org, 'alice'), NOT_CHOSEN);
        assert.deepEqual(await sync.applyGroupMemberChange(org, 'alice', 'staff'), NOT_CHOSEN);
        await settle();

        assert.deepEqual(requests, [], 'nothing is asked of Nextcloud');
        assert.deepEqual(state.creates, []);
        assert.deepEqual(state.updates, []);
        assert.deepEqual(calls.upsert, []);
    });
}

test('a newly bound organisation: the administrator provisioned at binding does not count as a mirrored user', async () => {
    seedBootstrapAdmin(NEWLY_BOUND);
    const legacyAdmin = seedExistingUser({ ncUid: 'second', status: 'active' });
    legacyAdmin.orgRole = 'admin';
    ncUserList = ['admin', 'second', 'alice'];
    assert.deepEqual(await sync.runFullSync(NEWLY_BOUND), { skipped: 'sync_mode_not_chosen' });
    assert.deepEqual(state.creates, []);
});

test('an existing organisation without a stored mode keeps synchronising when it has synchronised before', async () => {
    stubHealthStore();
    const org = { ...NEWLY_BOUND, nc_sync_mode: null, nc_last_sync_at: '2026-03-01T06:00:00Z' };
    ncUserList = ['alice'];
    const result = await sync.runFullSync(org);
    assert.equal(result.created, 1);
    assert.equal((await sync.applyUserCreated(org, 'carol')).action, 'create');
    assert.deepEqual(state.creates.map(u => u.ncUid), ['alice', 'carol']);
});

test('an existing organisation without a stored mode keeps synchronising when it has users mirrored from Nextcloud', async () => {
    stubHealthStore();
    const org = { ...NEWLY_BOUND, nc_sync_mode: null };
    seedBootstrapAdmin(org);
    seedExistingUser({ ncUid: 'bob', status: 'active' });
    ncUserList = ['admin', 'bob', 'alice'];
    groupsByUid.dave = ['staff'];

    const result = await sync.runFullSync(org);
    assert.equal(result.created, 1);
    assert.equal((await sync.applyUserCreated(org, 'carol')).action, 'create');
    assert.equal((await sync.applyGroupMemberChange(org, 'dave', 'staff')).action, 'create');
    assert.deepEqual(state.creates.map(u => u.ncUid), ['alice', 'carol', 'dave']);
});

// Bound again to a Nextcloud: what an earlier binding left behind (a last
// sync, mirrored users) does not start the sync for this one.
const BOUND_AGAIN = { ...NEWLY_BOUND, nc_provisioned_at: '2026-11-10T09:00:00Z' };

test('an organisation bound again is not synchronised on the strength of an earlier binding', async () => {
    seedBootstrapAdmin(BOUND_AGAIN);
    seedExistingUser({ ncUid: 'bob', status: 'active' }).createdAt = '2026-03-01';
    seedExistingUser({ ncUid: 'eve', status: 'active' }).createdAt = '2026-11-10'; // the day of the binding itself
    ncUserList = ['admin', 'alice', 'bob'];
    const org = { ...BOUND_AGAIN, nc_last_sync_at: '2026-11-09T06:00:00Z' };

    assert.deepEqual(await sync.runFullSync(org), { skipped: 'sync_mode_not_chosen' });
    assert.deepEqual(await sync.applyUserCreated(org, 'alice'), NOT_CHOSEN);
    assert.deepEqual(await sync.applyGroupMemberChange(org, 'alice', 'staff'), NOT_CHOSEN);
    assert.deepEqual(requests, [], 'nothing is asked of Nextcloud');
    assert.deepEqual(state.creates, []);
});

test('an organisation bound again synchronises once its mode is chosen, has synchronised since, or has users mirrored since', async () => {
    stubHealthStore();
    ncUserList = ['alice'];
    assert.equal((await sync.runFullSync({ ...BOUND_AGAIN, nc_onboarding_completed_at: '2026-11-10T10:00:00Z' })).created, 1);
    assert.equal((await sync.runFullSync({ ...BOUND_AGAIN, nc_last_sync_at: '2026-11-10T12:00:00Z' })).created, 1);
    assert.equal((await sync.runFullSync({ ...BOUND_AGAIN, nc_last_sync_at: new Date('2026-11-10T09:00:00Z') })).created, 1, 'a Date from the database');
    seedExistingUser({ ncUid: 'bob', status: 'active' }).createdAt = '2026-11-11';
    ncUserList = ['bob', 'carol'];
    assert.equal((await sync.runFullSync(BOUND_AGAIN)).created, 1);
});

test('mirrored users of another organisation do not start this one', async () => {
    seedExistingUser({ ncUid: 'bob', status: 'active', orgId: 'org-2' });
    ncUserList = ['alice'];
    assert.deepEqual(await sync.runFullSync(NEWLY_BOUND), { skipped: 'sync_mode_not_chosen' });
    assert.deepEqual(await sync.applyUserCreated(NEWLY_BOUND, 'alice'), NOT_CHOSEN);
    assert.deepEqual(state.creates, []);
});

test('choosing a mode starts the sync: completed onboarding, or a stored mode other than the column default', async () => {
    stubHealthStore();
    ncUserList = ['alice'];
    groupsByUid.alice = ['staff'];
    assert.deepEqual(await sync.runFullSync(NEWLY_BOUND), { skipped: 'sync_mode_not_chosen' });

    const onboarded = { ...NEWLY_BOUND, nc_onboarding_completed_at: '2026-11-10T10:00:00Z' };
    assert.equal((await sync.runFullSync(onboarded)).created, 1);

    const selective = { ...NEWLY_BOUND, nc_sync_mode: 'selective_groups', ncSyncGroups: ['staff'] };
    assert.equal((await sync.runFullSync(selective)).created, 1);
    assert.equal((await sync.applyUserCreated(selective, 'alice')).action, 'create');
});

test('manual mode still holds the full sync, chosen or not', async () => {
    assert.deepEqual(await sync.runFullSync({ ...ORG, nc_sync_mode: 'manual' }), { skipped: 'manual_mode' });
    assert.deepEqual(await sync.runFullSync({ ...NEWLY_BOUND, nc_sync_mode: 'manual' }), { skipped: 'manual_mode' });
    assert.deepEqual(requests, []);
});

test('a lookup of mirrored users that fails counts as not chosen', async () => {
    const userStore = require('../stores/userStore.js');
    const usual = userStore.hasMirroredNcUsers;
    userStore.hasMirroredNcUsers = async () => { throw new Error('db down'); };
    try {
        seedExistingUser({ ncUid: 'bob', status: 'active' });
        assert.deepEqual(await sync.runFullSync(NEWLY_BOUND), { skipped: 'sync_mode_not_chosen' });
    } finally { userStore.hasMirroredNcUsers = usual; }
});

test('a user deleted in Nextcloud is deactivated whether or not the mode is chosen', async () => {
    const admin = seedBootstrapAdmin(NEWLY_BOUND);
    assert.deepEqual(await sync.applyUserDeleted(NEWLY_BOUND, 'admin'), { action: 'deactivate', userId: admin.id });
});
