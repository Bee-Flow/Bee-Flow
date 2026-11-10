'use strict';
/**
 * Sign-in through the Nextcloud connector when the uid of the signed token is
 * not the uid stored on the Bee Flow user that the e-mail address finds.
 *
 *   - The stored uid is a live Nextcloud account with that address: it is
 *     another account. The stored uid stays, the sign-in answers 409
 *     nc_uid_conflict and the organisation gets a health event.
 *   - The stored account is gone, disabled or has another address: the stored
 *     uid is replaced by the signed one and the sign-in continues.
 *   - Nextcloud cannot say: as the line above.
 *
 * The middleware, its phases and services/ncStoredUid.mts are the real ones;
 * the stores are stubbed and the Nextcloud answer comes from a fetch stub.
 *
 * Run: cd server && node --test auth/connectorJwt.ncUidConflict.test.js
 */
process.env.NODE_ENV = 'test';
// The proxy call goes through the Nextcloud host gate; with this switch it
// uses the global fetch, which this file stubs.
process.env.NEXTCLOUD_ALLOW_PRIVATE_HOSTS = '1';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const configStore = require('../stores/configStore');
const userStore = require('../stores/userStore');
const encryption = require('./encryption');
const orgHealth = require('../services/orgHealth');
const log = require('../telemetry/log');
const connectorJwtMiddleware = require('./connectorJwt');
const phases = require('./connectorJwtPhases');
const { resetStoredUidCache } = require('../services/ncStoredUid.mts');

const ORG = 'org1';
const OTHER_ORG = 'org2';
const KEYS = { [ORG]: 'tenant-secret-org1', [OTHER_ORG]: 'tenant-secret-org2' };
const CALLBACK = {
    [ORG]: 'https://cloud.one.example/index.php/apps/app_api/proxy/bee_flow',
    [OTHER_ORG]: 'https://cloud.two.example/index.php/apps/app_api/proxy/bee_flow',
};
const EMAIL = 'shared@acme.example';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const NOW = Math.floor(Date.now() / 1000);
function token(payload, org = ORG) {
    const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ exp: NOW + 300, ...payload })}`;
    return `${head}.${crypto.createHmac('sha256', KEYS[org]).update(head).digest('base64url')}`;
}

let rec;
let row;        // the Bee Flow user the address finds
let ncAccounts; // uid -> the record Nextcloud gives its admin; absent = no such account
let ncAnswer;   // optional override: (uid, request) => a fetch response
let seq = 0;
const realFetch = global.fetch;
after(() => { global.fetch = realFetch; });

const json = (body) => ({ ok: true, status: 200, json: async () => body });

beforeEach(() => {
    rec = { problems: [], updates: [], requests: [], warns: [], liveness: [] };
    ncAccounts = {};
    ncAnswer = null;
    delete process.env.NEXTCLOUD_UID_CONFLICT_CACHE_SECONDS;
    delete process.env.NEXTCLOUD_UID_CONFLICT_WAIT_MS;
    resetStoredUidCache();
    connectorJwtMiddleware.invalidateTenantKeyCache();
    // A new user id per test: the encryption-key cache is process-wide.
    row = { id: `u${++seq}`, email: EMAIL, organizationId: ORG, nc_uid: 'first', provider: 'nextcloud_connector', role: 'user' };
    Object.assign(configStore, {
        listKeysWithPrefix: async () => Object.keys(KEYS).map((o) => `connector_tenant_key_${o}`),
        getSecret: async (k) => KEYS[String(k).replace('connector_tenant_key_', '')] || null,
        getSecretFresh: async (k) => KEYS[String(k).replace('connector_tenant_key_', '')] || null,
    });
    Object.assign(userStore, {
        getUser: async () => null,
        getUserByEmail: async () => row,
        getUserByNcUid: async () => null,
        getOrganization: async (id) => ({ id, nc_instance_id: `nc-${id}`, nc_onboarding_completed_at: 1, nc_admin_uid: 'root', connector_callback_url: CALLBACK[id] }),
        updateUser: async (id, updates) => { rec.updates.push({ id, updates }); return {}; },
    });
    Object.assign(encryption, {
        getOrCreateSSOUserDEKCompat: async () => ({ encryptionKey: 'sso-key' }),
        getFallbackEncryptionKey: () => 'fallback-key',
    });
    orgHealth.problem = (code, opts) => { rec.problems.push({ code, opts }); };
    orgHealth.event = () => {};
    orgHealth.touchLiveness = (...a) => { rec.liveness.push(a); };
    log.warn = (m) => { rec.warns.push(String(m)); };
    log.info = () => {};
    global.fetch = async (url, options = {}) => {
        const u = new URL(url);
        const request = { host: u.host, path: u.pathname, headers: options.headers || {} };
        rec.requests.push(request);
        const m = u.pathname.match(/\/cloud\/users\/([^/]+)$/);
        const uid = m ? decodeURIComponent(m[1]) : null;
        if (ncAnswer) return ncAnswer(uid, request);
        if (uid && ncAccounts[uid]) return json({ ocs: { data: { id: uid, ...ncAccounts[uid] } } });
        return { ok: false, status: 404, json: async () => ({}) };
    };
});

async function signIn(sub, { org = ORG, email = EMAIL } = {}) {
    const req = {
        method: 'GET', url: '/x', ip: '9.9.9.9',
        headers: { 'x-beeflow-source': 'nextcloud-connector', authorization: `Bearer ${token({ email, sub }, org)}` },
        session: { regenerate: (cb) => cb() },
    };
    const out = { status: undefined, body: undefined, next: 0, nextArgs: null };
    const res = { status(n) { out.status = n; return res; }, json(b) { out.body = b; return res; }, setHeader() { return res; } };
    req.res = res;
    await connectorJwtMiddleware(req, res, (...a) => { out.next += 1; out.nextArgs = a; });
    return { ...out, req };
}

const CONFLICT_BODY = {
    error: 'Your e-mail address is already linked to another Nextcloud account in Bee Flow. Ask your Nextcloud administrator to give each account its own e-mail address.',
    code: 'nc_uid_conflict',
};
function assertRefused(out) {
    assert.equal(out.status, 409);
    assert.deepEqual(out.body, CONFLICT_BODY);
    assert.equal(out.next, 0);
    assert.notEqual(out.req.session.isAuthenticated, true);
    assert.equal(out.req.connectorAuth, undefined);
    assert.deepEqual(rec.updates, [], 'the stored uid is not rewritten');
    assert.equal(row.nc_uid, 'first');
}
function assertHealed(out, sub = 'second') {
    assert.equal(out.status, undefined);
    assert.equal(out.next, 1);
    assert.deepEqual(out.nextArgs, []);
    assert.deepEqual(rec.updates, [{ id: row.id, updates: { ncUid: sub } }]);
    assert.equal(out.req.session.connectorNcUid, sub);
    assert.deepEqual(rec.problems, []);
}

// ── Two live accounts with one address ──────────────────────────────────────

test('the stored uid is a live account with the same address: 409 nc_uid_conflict, the stored uid stays, a health event', async () => {
    ncAccounts.first = { enabled: true, email: EMAIL };
    const out = await signIn('second');
    assertRefused(out);
    assert.deepEqual(rec.problems.map((p) => p.code), ['auth.blocked_nc_uid_conflict']);
    assert.equal(rec.problems[0].opts.orgId, ORG);
    assert.equal(rec.problems[0].opts.source, 'connectorJwt');
    assert.deepEqual(rec.problems[0].opts.meta, { lastUserId: row.id, sub: 'second', reason: 'stored_uid_live_with_same_email' });
    assert.deepEqual(rec.liveness, []);
});

test('the two accounts taking turns: the stored one signs in every time, the other is refused every time, nothing is rewritten', async () => {
    ncAccounts.first = { enabled: true, email: EMAIL };
    ncAccounts.second = { enabled: true, email: EMAIL };
    for (let i = 0; i < 3; i++) {
        const mine = await signIn('first');
        assert.equal(mine.next, 1);
        assert.equal(mine.req.session.connectorNcUid, 'first');
        assertRefused(await signIn('second'));
    }
    assert.deepEqual(rec.updates, []);
});

test('the address is compared without regard to case, on both sides', async () => {
    ncAccounts.first = { enabled: true, email: 'Shared@Acme.Example' };
    assertRefused(await signIn('second'));
    resetStoredUidCache();
    row.email = 'SHARED@acme.example';
    assertRefused(await signIn('second'));
});

test('the enabled flag as the text "true" counts as enabled', async () => {
    ncAccounts.first = { enabled: 'true', email: EMAIL };
    assertRefused(await signIn('second'));
});

// ── A uid that really changed ───────────────────────────────────────────────

test('the stored account is gone: the stored uid is replaced and the sign-in continues', async () => {
    ncAccounts.second = { enabled: true, email: EMAIL };
    assertHealed(await signIn('second'));
    assert.ok(rec.warns.some((m) => m.includes(`Repaired stale nc_uid for user ${row.id}`)));
});

test('the stored account is disabled: replaced', async () => {
    ncAccounts.first = { enabled: false, email: EMAIL };
    assertHealed(await signIn('second'));
});

test('the stored account is live but has another address (or none): replaced', async () => {
    ncAccounts.first = { enabled: true, email: 'someone.else@acme.example' };
    assertHealed(await signIn('second'));
    rec.updates.length = 0; row.nc_uid = 'first'; row.id = `u${++seq}`;
    ncAccounts.first = { enabled: true };
    assertHealed(await signIn('second'));
});

test('after the replacement the new uid signs in without a question to Nextcloud', async () => {
    assertHealed(await signIn('second'));
    const asked = rec.requests.length;
    const again = await signIn('second');
    assert.equal(again.next, 1);
    assert.equal(rec.requests.length, asked);
});

// ── Nextcloud cannot say ────────────────────────────────────────────────────

const CANNOT_SAY = {
    'HTTP 500': () => ({ ok: false, status: 500, json: async () => ({}) }),
    'HTTP 401': () => ({ ok: false, status: 401, json: async () => ({}) }),
    'HTTP 503': () => ({ ok: false, status: 503, json: async () => ({}) }),
    'a thrown request': () => { throw new Error('socket hang up'); },
    'a body that is not JSON': () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } }),
    'an empty answer': () => json({}),
    'a list instead of a record': () => json({ ocs: { data: [] } }),
    'a record about another uid': () => json({ ocs: { data: { id: 'someone', enabled: true, email: EMAIL } } }),
    'a record without an id': () => json({ ocs: { data: { enabled: true, email: EMAIL } } }),
    'a record without the enabled flag': () => json({ ocs: { data: { id: 'first', email: EMAIL } } }),
    'an enabled flag that is not a yes or no': () => json({ ocs: { data: { id: 'first', enabled: 1, email: EMAIL } } }),
};
for (const [name, answer] of Object.entries(CANNOT_SAY)) {
    test(`the read answers ${name}: the stored uid is replaced and the sign-in continues`, async () => {
        ncAnswer = answer;
        assertHealed(await signIn('second'));
    });
}

test('a read that takes longer than the wait: the sign-in continues, the stored uid is replaced', async () => {
    process.env.NEXTCLOUD_UID_CONFLICT_WAIT_MS = '20';
    let release;
    ncAnswer = () => new Promise((resolve) => { release = () => resolve(json({ ocs: { data: { id: 'first', enabled: true, email: EMAIL } } })); });
    const out = await signIn('second');
    assertHealed(out);
    release();
});

test('an organisation without a stored Nextcloud admin: no read, replaced', async () => {
    userStore.getOrganization = async (id) => ({ id, nc_instance_id: 'nc1', nc_onboarding_completed_at: 1, connector_callback_url: CALLBACK[id] });
    assertHealed(await signIn('second'));
    assert.deepEqual(rec.requests, []);
});

test('the organisation row cannot be read: replaced', async () => {
    const usual = userStore.getOrganization;
    userStore.getOrganization = async () => { throw new Error('db down'); };
    try { assertHealed(await signIn('second')); } finally { userStore.getOrganization = usual; }
    assert.deepEqual(rec.requests, []);
});

// ── When the question is asked at all ───────────────────────────────────────

test('the signed uid is the stored uid: no question to Nextcloud', async () => {
    const out = await signIn('first');
    assert.equal(out.next, 1);
    assert.deepEqual(rec.requests, []);
    assert.deepEqual(rec.updates, []);
});

test('a signed uid that differs from the stored one only in case is the same account: no question, no refusal', async () => {
    ncAccounts.first = { enabled: true, email: EMAIL };
    const out = await signIn('First');
    assert.equal(out.next, 1);
    assert.deepEqual(rec.requests, []);
    assert.deepEqual(rec.problems, []);
});

test('a user without a stored uid is bound to the signed one without a question to Nextcloud', async () => {
    row.nc_uid = null;
    const out = await signIn('second');
    assert.equal(out.next, 1);
    assert.deepEqual(rec.requests, []);
    assert.deepEqual(rec.updates, [{ id: row.id, updates: { ncUid: 'second' } }]);
});

test('a refusal is remembered for the cache time; 0 asks Nextcloud every time', async () => {
    ncAccounts.first = { enabled: true, email: EMAIL };
    assertRefused(await signIn('second'));
    assertRefused(await signIn('second'));
    assert.equal(rec.requests.length, 1);

    resetStoredUidCache();
    rec.requests.length = 0;
    process.env.NEXTCLOUD_UID_CONFLICT_CACHE_SECONDS = '0';
    assertRefused(await signIn('second'));
    assertRefused(await signIn('second'));
    assert.equal(rec.requests.length, 2);
});

test('only a refusal is remembered: an account that could not be read is asked about again', async () => {
    ncAnswer = () => ({ ok: false, status: 503, json: async () => ({}) });
    assertHealed(await signIn('second'));
    rec.updates.length = 0; row.nc_uid = 'first';
    ncAnswer = null;
    ncAccounts.first = { enabled: true, email: EMAIL };
    assertRefused(await signIn('second'));
});

// ── One organisation ────────────────────────────────────────────────────────

test('the read goes to the token\'s own Nextcloud, as that organisation\'s stored admin, about the stored uid', async () => {
    ncAccounts.first = { enabled: true, email: EMAIL };
    await signIn('second');
    assert.equal(rec.requests.length, 1);
    const r = rec.requests[0];
    assert.equal(r.host, 'cloud.one.example');
    assert.ok(r.path.endsWith('/nc/ocs/v2.php/cloud/users/first'), r.path);
    assert.equal(r.headers['X-Beeflow-NC-Uid'], 'root');
});

test('a user of another organisation is refused as an organisation mismatch, with no read and no write', async () => {
    row.organizationId = OTHER_ORG;
    ncAccounts.first = { enabled: true, email: EMAIL };
    const out = await signIn('second');
    assert.equal(out.status, 403);
    assert.equal(out.body.code, 'NC_ORG_MISMATCH');
    assert.deepEqual(rec.requests, []);
    assert.deepEqual(rec.updates, []);
    assert.deepEqual(rec.problems.map((p) => p.code), ['auth.blocked_org_mismatch']);
});

test('the gate itself asks nothing about a user outside the token\'s organisation', async () => {
    ncAccounts.first = { enabled: true, email: EMAIL };
    const outcome = await phases.ncUidConflictGate({}, { ...row, organizationId: OTHER_ORG }, ORG, { sub: 'second', email: EMAIL });
    assert.equal(outcome, null);
    assert.deepEqual(rec.requests, []);
    assert.deepEqual(rec.problems, []);
});

test('the same pair of uids in a second organisation is answered by that organisation\'s Nextcloud only', async () => {
    // org1: the stored uid is live with the address. org2: it is gone.
    ncAnswer = (uid, request) => (request.host === 'cloud.one.example' && uid === 'first'
        ? json({ ocs: { data: { id: 'first', enabled: true, email: EMAIL } } })
        : { ok: false, status: 404, json: async () => ({}) });
    assertRefused(await signIn('second'));

    const theirs = { id: `u${++seq}`, email: EMAIL, organizationId: OTHER_ORG, nc_uid: 'first', provider: 'nextcloud_connector', role: 'user' };
    row = theirs;
    rec.problems.length = 0;
    const out = await signIn('second', { org: OTHER_ORG });
    assert.equal(out.next, 1, 'the refusal remembered for org1 does not apply to org2');
    assert.deepEqual(rec.updates, [{ id: theirs.id, updates: { ncUid: 'second' } }]);
    assert.deepEqual(rec.requests.map((r) => r.host), ['cloud.one.example', 'cloud.two.example']);
    assert.deepEqual(rec.problems, []);
});
