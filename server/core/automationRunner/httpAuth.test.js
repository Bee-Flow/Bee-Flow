/**
 * Unit tests for httpAuth — HTTP-credential resolution for the http_request
 * step (Feature C). Store + ssrfGuard are pre-mocked via the require cache
 * (same approach as execHttpRequest.test.js); renderAuthValue is the REAL
 * implementation from customIntegrationRunner so the header rendering paths
 * (incl. Basic base64) are exercised end-to-end.
 *
 * Run: node --test core/automationRunner/httpAuth.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

function mock(relPath, exports) {
    const resolved = require.resolve(relPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const storeState = {
    authz: null,
    full: null,
    needsReauth: [],
    touched: [],
    lastAuthzArgs: null,
};
mock('../../stores/integrationConnectionStore', {
    authorizeConnectionUse: async (args) => { storeState.lastAuthzArgs = args; return storeState.authz; },
    getConnectionWithSecret: async () => storeState.full,
    markNeedsReauth: async (id, reason) => { storeState.needsReauth.push({ id, reason }); },
    touchLastUsed: async (id) => { storeState.touched.push(id); },
});

const safeFetchCalls = [];
let safeFetchImpl = null;
class FakePrivateAddressError extends Error {
    constructor() { super('Refused: private'); this.code = 'EPRIVATEADDRESS'; }
}
mock('../../utils/ssrfGuard', {
    safeFetch: async (url, opts) => { safeFetchCalls.push({ url, opts }); return safeFetchImpl(url, opts); },
    isPrivateAddressError: (e) => e && e.code === 'EPRIVATEADDRESS',
});

const httpAuth = require('./httpAuth');
const { resolveHttpAuthHeaders, evictToken, MASK_VALUES, _internals } = httpAuth;

const ctx = { userId: 'u1', orgId: 'orgA', userGroupIds: ['g1'] };

function conn(id, kind, secretMeta = {}, over = {}) {
    return { id, provider: 'http', label: `Cred ${id}`, kind, status: 'active', secretMeta, updatedAt: '2026-07-24T10:00:00Z', ...over };
}
function grantAccess(connection, secret, mode = 'own') {
    storeState.authz = { ok: true, mode, connection };
    storeState.full = { ...connection, secret };
}
function tokenResponse({ status = 200, body }) {
    return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) };
}

test('MASK_VALUES is the shared Symbol.for key', () => {
    assert.strictEqual(MASK_VALUES, Symbol.for('beeflow.automation.maskValues'));
});

test('bearer: renders Authorization + masks both raw token and derived header', async () => {
    grantAccess(conn('cid-bearer', 'bearer'), { token: 'tok-raw-1' });
    const r = await resolveHttpAuthHeaders({ connectionId: 'cid-bearer' }, ctx);
    assert.deepStrictEqual(r.headers, { Authorization: 'Bearer tok-raw-1' });
    assert.ok(r.maskValues.includes('tok-raw-1'));
    assert.ok(r.maskValues.includes('Bearer tok-raw-1'));
    assert.strictEqual(r.accessMode, 'own');
    assert.strictEqual(storeState.touched.at(-1), 'cid-bearer');
    // ctx is forwarded to the store's own-or-grant check
    assert.strictEqual(storeState.lastAuthzArgs.runningUserId, 'u1');
    assert.strictEqual(storeState.lastAuthzArgs.runningUserOrgId, 'orgA');
    assert.deepStrictEqual(storeState.lastAuthzArgs.runningUserGroups, ['g1']);
});

test('api_key: renders the custom header from secretMeta.headerName', async () => {
    grantAccess(conn('cid-apikey', 'api_key', { headerName: 'X-API-Key' }), { token: 'key-raw-2' }, 'delegated');
    const r = await resolveHttpAuthHeaders({ connectionId: 'cid-apikey' }, ctx);
    assert.deepStrictEqual(r.headers, { 'X-API-Key': 'key-raw-2' });
    assert.ok(r.maskValues.includes('key-raw-2'));
    assert.strictEqual(r.accessMode, 'delegated');
});

test('api_key: a malformed header name in meta is rejected without leaking the token', async () => {
    grantAccess(conn('cid-badheader', 'api_key', { headerName: 'X Bad Header' }), { token: 'key-raw-3' });
    await assert.rejects(
        () => resolveHttpAuthHeaders({ connectionId: 'cid-badheader' }, ctx),
        (e) => /invalid header name/.test(e.message) && !e.message.includes('key-raw-3'),
    );
});

test('basic: renders the Basic base64 pair via the shared renderAuthValue', async () => {
    grantAccess(conn('cid-basic', 'basic', { username: 'ada' }), { username: 'ada', password: 'pw-raw-4' });
    const r = await resolveHttpAuthHeaders({ connectionId: 'cid-basic' }, ctx);
    const expected = 'Basic ' + Buffer.from('ada:pw-raw-4', 'utf8').toString('base64');
    assert.deepStrictEqual(r.headers, { Authorization: expected });
    assert.ok(r.maskValues.includes(expected), 'derived Basic value must be maskable');
    assert.ok(r.maskValues.includes('pw-raw-4'));
});

test('a NON-http provider connection is rejected (cross-provider exfiltration guard)', async () => {
    grantAccess(conn('cid-gh', 'api_key', { headerName: 'X-K' }, { provider: 'github' }), { token: 'gh-tok-5' });
    await assert.rejects(
        () => resolveHttpAuthHeaders({ connectionId: 'cid-gh' }, ctx),
        (e) => /not available to this automation's owner/.test(e.message) && !e.message.includes('gh-tok-5'),
    );
});

test('not_found and forbidden share one opaque user-safe error', async () => {
    storeState.authz = { ok: false, reason: 'not_found' };
    await assert.rejects(() => resolveHttpAuthHeaders({ connectionId: 'x' }, ctx), /not available to this automation's owner/);
    storeState.authz = { ok: false, reason: 'forbidden' };
    await assert.rejects(() => resolveHttpAuthHeaders({ connectionId: 'x' }, ctx), /not available to this automation's owner/);
});

test('needs_reauth surfaces the label + status with a settings pointer', async () => {
    storeState.authz = { ok: false, reason: 'needs_reauth', connection: { label: 'Billing API' } };
    await assert.rejects(
        () => resolveHttpAuthHeaders({ connectionId: 'x' }, ctx),
        /HTTP credential "Billing API" needs attention \(needs_reauth\)/,
    );
});

test('null decrypted secret → clear re-enter error', async () => {
    grantAccess(conn('cid-null', 'bearer'), null);
    storeState.full = { secret: null };
    await assert.rejects(() => resolveHttpAuthHeaders({ connectionId: 'cid-null' }, ctx), /could not be decrypted/);
});

// ── oauth2_cc ───────────────────────────────────────────────────────

const OAUTH_META = { tokenUrl: 'https://auth.example.com/token', scope: 'read', tokenAuthMethod: 'client_secret_post' };
const OAUTH_SECRET = { client_id: 'cid-raw-6', client_secret: 'csec-raw-6' };

test('oauth2_cc: fetches a token (client_secret_post), renders Bearer, masks token + secrets', async () => {
    grantAccess(conn('cid-oauth-1', 'oauth2_cc', OAUTH_META), OAUTH_SECRET);
    const calls = [];
    const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return tokenResponse({ body: { access_token: 'at-raw-7', expires_in: 3600 } }); };
    const r = await resolveHttpAuthHeaders({ connectionId: 'cid-oauth-1' }, ctx, { fetchImpl });
    assert.deepStrictEqual(r.headers, { Authorization: 'Bearer at-raw-7' });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, 'https://auth.example.com/token');
    assert.strictEqual(calls[0].opts.method, 'POST');
    const body = new URLSearchParams(calls[0].opts.body);
    assert.strictEqual(body.get('grant_type'), 'client_credentials');
    assert.strictEqual(body.get('scope'), 'read');
    assert.strictEqual(body.get('client_id'), 'cid-raw-6');
    assert.strictEqual(body.get('client_secret'), 'csec-raw-6');
    for (const v of ['at-raw-7', 'cid-raw-6', 'csec-raw-6']) assert.ok(r.maskValues.includes(v), `mask includes ${v}`);
    assert.ok(r.maskValues.includes('Bearer at-raw-7'));
});

test('oauth2_cc: token is cached — a second resolve does not refetch', async () => {
    grantAccess(conn('cid-oauth-1', 'oauth2_cc', OAUTH_META), OAUTH_SECRET);
    let calls = 0;
    const fetchImpl = async () => { calls++; return tokenResponse({ body: { access_token: 'at-other', expires_in: 3600 } }); };
    const r = await resolveHttpAuthHeaders({ connectionId: 'cid-oauth-1' }, ctx, { fetchImpl });
    assert.strictEqual(calls, 0, 'served from cache');
    assert.deepStrictEqual(r.headers, { Authorization: 'Bearer at-raw-7' });
});

test('oauth2_cc: refresh margin — a token within 60s of expiry is refetched', async () => {
    const c = conn('cid-oauth-margin', 'oauth2_cc', OAUTH_META);
    grantAccess(c, OAUTH_SECRET);
    let calls = 0;
    let t = 0;
    const deps = { now: () => t, fetchImpl: async () => { calls++; return tokenResponse({ body: { access_token: `at-m-${calls}`, expires_in: 3600 } }); } };
    await resolveHttpAuthHeaders({ connectionId: 'cid-oauth-margin' }, ctx, deps);
    assert.strictEqual(calls, 1);
    t = 3600_000 - 61_000; // 61s margin left → still cached
    let r = await resolveHttpAuthHeaders({ connectionId: 'cid-oauth-margin' }, ctx, deps);
    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(r.headers, { Authorization: 'Bearer at-m-1' });
    t = 3600_000 - 55_000; // inside the 60s margin → refetch
    r = await resolveHttpAuthHeaders({ connectionId: 'cid-oauth-margin' }, ctx, deps);
    assert.strictEqual(calls, 2);
    assert.deepStrictEqual(r.headers, { Authorization: 'Bearer at-m-2' });
});

test('oauth2_cc: a secret rotation (updatedAt bump) busts the cache key', async () => {
    const c = conn('cid-oauth-rotate', 'oauth2_cc', OAUTH_META);
    grantAccess(c, OAUTH_SECRET);
    let calls = 0;
    const fetchImpl = async () => { calls++; return tokenResponse({ body: { access_token: `at-r-${calls}`, expires_in: 3600 } }); };
    await resolveHttpAuthHeaders({ connectionId: 'cid-oauth-rotate' }, ctx, { fetchImpl });
    assert.strictEqual(calls, 1);
    grantAccess({ ...c, updatedAt: '2026-07-24T11:00:00Z' }, OAUTH_SECRET); // rotated
    const r = await resolveHttpAuthHeaders({ connectionId: 'cid-oauth-rotate' }, ctx, { fetchImpl });
    assert.strictEqual(calls, 2, 'rotation must invalidate the cached token');
    assert.deepStrictEqual(r.headers, { Authorization: 'Bearer at-r-2' });
});

test('oauth2_cc: single-flight — two concurrent resolves share ONE fetch', async () => {
    grantAccess(conn('cid-oauth-sf', 'oauth2_cc', OAUTH_META), OAUTH_SECRET);
    let calls = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const fetchImpl = async () => { calls++; await gate; return tokenResponse({ body: { access_token: 'at-sf', expires_in: 3600 } }); };
    const p1 = resolveHttpAuthHeaders({ connectionId: 'cid-oauth-sf' }, ctx, { fetchImpl });
    const p2 = resolveHttpAuthHeaders({ connectionId: 'cid-oauth-sf' }, ctx, { fetchImpl });
    await new Promise((r) => setImmediate(r)); // let both reach the token step
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.strictEqual(calls, 1, 'concurrent steps must share one token fetch');
    assert.deepStrictEqual(r1.headers, r2.headers);
});

test('oauth2_cc: client_secret_basic puts creds in the Authorization header, NOT the body', async () => {
    grantAccess(conn('cid-oauth-basic', 'oauth2_cc', { ...OAUTH_META, tokenAuthMethod: 'client_secret_basic' }), OAUTH_SECRET);
    const calls = [];
    const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return tokenResponse({ body: { access_token: 'at-b', expires_in: 3600 } }); };
    await resolveHttpAuthHeaders({ connectionId: 'cid-oauth-basic' }, ctx, { fetchImpl });
    const expected = 'Basic ' + Buffer.from('cid-raw-6:csec-raw-6', 'utf8').toString('base64');
    assert.strictEqual(calls[0].opts.headers.Authorization, expected);
    const body = new URLSearchParams(calls[0].opts.body);
    assert.strictEqual(body.get('client_secret'), null, 'secret must not also travel in the body');
});

test('oauth2_cc: endpoint 401 → markNeedsReauth + sanitized error (no body, no secrets)', async () => {
    grantAccess(conn('cid-oauth-401', 'oauth2_cc', OAUTH_META), OAUTH_SECRET);
    const fetchImpl = async () => ({
        status: 401, ok: false,
        text: async () => JSON.stringify({ error: 'invalid_client', error_description: 'client csec-raw-6 leaked here' }),
    });
    await assert.rejects(
        () => resolveHttpAuthHeaders({ connectionId: 'cid-oauth-401' }, ctx, { fetchImpl }),
        (e) => /token endpoint returned 401/.test(e.message)
            && /invalid_client/.test(e.message)          // well-formed OAuth code may pass
            && !e.message.includes('csec-raw-6')          // never the body / secrets
            && !e.message.includes('leaked here'),
    );
    const flagged = storeState.needsReauth.find(n => n.id === 'cid-oauth-401');
    assert.ok(flagged, 'connection flagged needs_reauth');
    assert.ok(!flagged.reason.includes('csec-raw-6'), 'reason carries no secret');
});

test('oauth2_cc: missing access_token in the response is a clear sanitized error', async () => {
    grantAccess(conn('cid-oauth-noat', 'oauth2_cc', OAUTH_META), OAUTH_SECRET);
    const fetchImpl = async () => tokenResponse({ body: { token_type: 'bearer' } });
    await assert.rejects(
        () => resolveHttpAuthHeaders({ connectionId: 'cid-oauth-noat' }, ctx, { fetchImpl }),
        /did not return an access_token/,
    );
});

test('oauth2_cc: without an injected fetchImpl, safeFetch is used iff blockPrivateTargets', async () => {
    grantAccess(conn('cid-oauth-ssrf', 'oauth2_cc', OAUTH_META), OAUTH_SECRET);
    safeFetchCalls.length = 0;
    safeFetchImpl = async () => tokenResponse({ body: { access_token: 'at-ssrf', expires_in: 3600 } });
    await resolveHttpAuthHeaders({ connectionId: 'cid-oauth-ssrf' }, ctx);
    assert.strictEqual(safeFetchCalls.length, 1, 'default (block on) must go through ssrfGuard.safeFetch');

    grantAccess(conn('cid-oauth-open', 'oauth2_cc', OAUTH_META), OAUTH_SECRET);
    const originalFetch = global.fetch;
    let bare = 0;
    global.fetch = async () => { bare++; return tokenResponse({ body: { access_token: 'at-open', expires_in: 3600 } }); };
    try {
        await resolveHttpAuthHeaders({ connectionId: 'cid-oauth-open', blockPrivateTargets: false }, ctx);
        assert.strictEqual(bare, 1, 'explicit opt-out uses a bare fetch');
        assert.strictEqual(safeFetchCalls.length, 1, 'safeFetch not used when the step opted out');
    } finally {
        global.fetch = originalFetch;
    }
});

test('oauth2_cc: a private-address refusal from safeFetch surfaces the friendly message', async () => {
    grantAccess(conn('cid-oauth-priv', 'oauth2_cc', { ...OAUTH_META, tokenUrl: 'http://169.254.169.254/token' }), OAUTH_SECRET);
    safeFetchImpl = async () => { throw new FakePrivateAddressError(); };
    await assert.rejects(
        () => resolveHttpAuthHeaders({ connectionId: 'cid-oauth-priv' }, ctx),
        /private\/internal address/,
    );
});

test('evictToken drops the cache so the next resolve refetches', async () => {
    grantAccess(conn('cid-oauth-evict', 'oauth2_cc', OAUTH_META), OAUTH_SECRET);
    let calls = 0;
    const fetchImpl = async () => { calls++; return tokenResponse({ body: { access_token: `at-e-${calls}`, expires_in: 3600 } }); };
    await resolveHttpAuthHeaders({ connectionId: 'cid-oauth-evict' }, ctx, { fetchImpl });
    assert.strictEqual(calls, 1);
    evictToken('cid-oauth-evict');
    const r = await resolveHttpAuthHeaders({ connectionId: 'cid-oauth-evict' }, ctx, { fetchImpl });
    assert.strictEqual(calls, 2, 'evicted token must be refetched');
    assert.deepStrictEqual(r.headers, { Authorization: 'Bearer at-e-2' });
});

test('invalid tokenUrl in meta fails fast without leaking secrets', async () => {
    grantAccess(conn('cid-oauth-badurl', 'oauth2_cc', { tokenUrl: 'not a url' }), OAUTH_SECRET);
    await assert.rejects(
        () => resolveHttpAuthHeaders({ connectionId: 'cid-oauth-badurl' }, ctx),
        (e) => /invalid OAuth2 token URL/.test(e.message) && !e.message.includes('csec-raw-6'),
    );
});

// ── the cache fingerprint ───────────────────────────────────────────────────
//
// The response cache puts this in its key INSTEAD of the header value. That is
// the whole point: memoKeyParts builds a PLAINTEXT identity string before
// hashing it, so a live bearer token that reached it would be cache-key
// material sitting in process memory.

test('the fingerprint identifies the credential and never contains the secret', async () => {
    grantAccess(conn('cid-fp', 'bearer'), { token: 'tok-super-secret' });
    const r = await resolveHttpAuthHeaders({ connectionId: 'cid-fp' }, ctx);
    assert.ok(typeof r.fingerprint === 'string' && r.fingerprint);
    assert.ok(r.fingerprint.startsWith('cid-fp:'));
    assert.ok(!r.fingerprint.includes('tok-super-secret'),
        'a fingerprint that carried the token would put it straight into the cache key');
    for (const mask of r.maskValues) {
        assert.ok(!r.fingerprint.includes(mask), `the fingerprint must not contain ${mask}`);
    }
});

test('a secret rotation changes the fingerprint, so the stored answer is invalidated', async () => {
    grantAccess(conn('cid-rot', 'bearer'), { token: 'tok-1' });
    const before = (await resolveHttpAuthHeaders({ connectionId: 'cid-rot' }, ctx)).fingerprint;
    // Re-saving a credential bumps updated_at — the same fact the oauth2_cc
    // token cache already keys on.
    grantAccess(conn('cid-rot', 'bearer', {}, { updatedAt: '2026-09-01T10:00:00Z' }), { token: 'tok-2' });
    const after = (await resolveHttpAuthHeaders({ connectionId: 'cid-rot' }, ctx)).fingerprint;
    assert.notStrictEqual(before, after);
});

test('the same credential unchanged keeps the same fingerprint', async () => {
    grantAccess(conn('cid-same', 'bearer'), { token: 'tok-1' });
    const a = (await resolveHttpAuthHeaders({ connectionId: 'cid-same' }, ctx)).fingerprint;
    const b = (await resolveHttpAuthHeaders({ connectionId: 'cid-same' }, ctx)).fingerprint;
    assert.strictEqual(a, b);
});

test('own use and a lend of ONE connection do not share a fingerprint', async () => {
    grantAccess(conn('cid-mode', 'bearer'), { token: 'tok-1' }, 'own');
    const own = (await resolveHttpAuthHeaders({ connectionId: 'cid-mode' }, ctx)).fingerprint;
    grantAccess(conn('cid-mode', 'bearer'), { token: 'tok-1' }, 'delegated');
    const lent = (await resolveHttpAuthHeaders({ connectionId: 'cid-mode' }, ctx)).fingerprint;
    assert.notStrictEqual(own, lent);
});

test('the grant id rides back out, so two lends of one connection cannot share an answer', async () => {
    grantAccess(conn('cid-grant', 'bearer'), { token: 'tok-1' }, 'delegated');
    storeState.authz = { ...storeState.authz, grantId: 'grant-7' };
    const r = await resolveHttpAuthHeaders({ connectionId: 'cid-grant' }, ctx);
    assert.strictEqual(r.grantId, 'grant-7');
});

test('own use reports no grant rather than a stale one', async () => {
    grantAccess(conn('cid-own', 'bearer'), { token: 'tok-1' }, 'own');
    const r = await resolveHttpAuthHeaders({ connectionId: 'cid-own' }, ctx);
    assert.strictEqual(r.grantId, null);
});
