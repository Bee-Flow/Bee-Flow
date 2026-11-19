/**
 * 2BA sign-in (twobaAuth.mts), the transport's retry (twobaTransport.mts) and
 * the 401 retry of an API call (twobaApi.mts). The transport is scripted and
 * the stores are injected: no network, no database.
 *
 * Run: node --test integrations/twobaAuth.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { twobaTransport, TwobaError, retryDelayMs, MAX_DELAY_MS, errorForStatus } = require('./twobaTransport.mts');
const auth = require('./twobaAuth.mts');
const { twobaApi } = require('./twobaApi.mts');

let now = 1_000_000;
let secrets = {};
let vault = {};
let order = [];
auth.authDeps.now = () => now;
auth.authDeps.configStore = () => ({ getSecret: async (k) => secrets[k] ?? null });
auth.authDeps.credentials = () => ({
    getCredential: async (userId) => (vault[userId] ? { ...vault[userId] } : null),
    upsertCredential: async (row) => { order.push('upsert'); vault[row.userId] = { ...vault[row.userId], ...row, status: 'active' }; },
    markNeedsReauth: async (userId) => { order.push('reauth'); vault[userId].status = 'needs_reauth'; },
});

let calls = [];
const json = (status, body, headers = {}) => ({
    ok: status >= 200 && status < 300, status,
    headers: { get: (n) => headers[n.toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});
/** `answer(call)` gives the response for each request. */
function script(answer) {
    calls = [];
    twobaTransport.fetch = async (url, init) => {
        const call = { url, init, form: typeof init.body === 'string' && url.includes('/connect/') ? Object.fromEntries(new URLSearchParams(init.body)) : null };
        calls.push(call);
        order.push(url.includes('/connect/token') ? 'token' : 'api');
        return answer(call, calls.length);
    };
}
const sleeps = [];
twobaTransport.sleep = async (ms) => { sleeps.push(ms); };

function usePassword(user = 'u1') {
    Object.assign(secrets, {
        [`twoba_client_id_user_${user}`]: 'client-1', [`twoba_client_secret_user_${user}`]: 'client-secret-1',
        [`twoba_auth_mode_user_${user}`]: 'password', [`twoba_username_user_${user}`]: 'buyer', [`twoba_password_user_${user}`]: 'pw 1',
    });
}
function useCode(user = 'u1') {
    Object.assign(secrets, {
        [`twoba_client_id_user_${user}`]: 'client-1', [`twoba_client_secret_user_${user}`]: 'client-secret-1',
        [`twoba_auth_mode_user_${user}`]: 'authorization_code',
    });
}

test.beforeEach(() => {
    secrets = {}; vault = {}; order = []; sleeps.length = 0; now += 10_000_000;
    delete process.env.TWOBA_MAX_RETRIES;
    for (const u of ['u1', 'u2', 'u3']) auth.forgetToken(u);
});

test('password grant: the form carries the grant, the client and the account, the token is reused until 10 s before expiry', async () => {
    usePassword();
    let n = 0;
    script(() => json(200, { access_token: `tok-${++n}`, expires_in: 120 }));
    const cfg = await auth.configFor('u1');
    assert.equal(cfg.mode, 'password');
    assert.equal(await auth.accessTokenFor('u1', cfg), 'tok-1');
    assert.deepEqual(calls[0].form, { grant_type: 'password', username: 'buyer', password: 'pw 1', client_id: 'client-1', client_secret: 'client-secret-1' });
    assert.equal(calls[0].url, 'https://authorize.2ba.nl/connect/token');
    assert.equal(calls[0].init.redirect, 'error');
    assert.equal(await auth.accessTokenFor('u1', cfg), 'tok-1');
    now += 109_000;
    assert.equal(await auth.accessTokenFor('u1', cfg), 'tok-1');
    now += 2_000;
    assert.equal(await auth.accessTokenFor('u1', cfg), 'tok-2');
    assert.equal(calls.length, 2);
    // Another password: a new token, not the cached one.
    secrets.twoba_password_user_u1 = 'pw 2';
    assert.equal(await auth.accessTokenFor('u1', await auth.configFor('u1')), 'tok-3');
});

test('concurrent calls share one token request', async () => {
    usePassword();
    let release;
    const gate = new Promise((r) => { release = r; });
    script(async () => { await gate; return json(200, { access_token: 'tok', expires_in: 120 }); });
    const cfg = await auth.configFor('u1');
    const all = Promise.all([1, 2, 3, 4, 5].map(() => auth.accessTokenFor('u1', cfg)));
    release();
    assert.deepEqual(await all, ['tok', 'tok', 'tok', 'tok', 'tok']);
    assert.equal(calls.length, 1);
});

test('a refused password is a 401 for the caller, a refused client too', async () => {
    usePassword();
    script(() => json(400, { error: 'invalid_grant' }));
    await assert.rejects(auth.accessTokenFor('u1', await auth.configFor('u1')), (e) => e instanceof TwobaError && e.status === 401 && e.code === 'twoba_credentials_refused');
    script(() => json(400, { error: 'invalid_client' }));
    await assert.rejects(auth.accessTokenFor('u1', await auth.configFor('u1')), (e) => e.code === 'twoba_client_refused' && e.status === 401);
    script(() => json(500, {}));
    await assert.rejects(auth.accessTokenFor('u1', await auth.configFor('u1')), (e) => e.status === 503);
});

test('not configured: a 400, no request', async () => {
    script(() => json(200, {}));
    await assert.rejects(auth.accessTokenFor('u3', await auth.configFor('u3')), (e) => e.status === 400 && e.code === 'twoba_not_configured');
    assert.equal(calls.length, 0);
});

test('code mode: a fresh vault token is used; an expiring one is refreshed once, the rotated refresh token stored first', async () => {
    useCode();
    vault.u1 = { userId: 'u1', orgId: 'o1', accessToken: 'a1', refreshToken: 'r1', expiresAt: now + 60_000, status: 'active' };
    script(() => json(200, { access_token: 'a2', refresh_token: 'r2', expires_in: 120 }));
    const cfg = await auth.configFor('u1');
    assert.equal(await auth.accessTokenFor('u1', cfg), 'a1');
    assert.equal(calls.length, 0);
    now += 55_000;
    const tokens = await Promise.all([1, 2, 3].map(() => auth.accessTokenFor('u1', cfg)));
    assert.deepEqual(tokens, ['a2', 'a2', 'a2']);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].form, { grant_type: 'refresh_token', refresh_token: 'r1', client_id: 'client-1', client_secret: 'client-secret-1' });
    assert.equal(vault.u1.refreshToken, 'r2');
    assert.deepEqual(order, ['token', 'upsert']);
});

test('code mode: a refused refresh marks the connection for sign-in (401), unless another server just rotated it', async () => {
    useCode();
    vault.u1 = { userId: 'u1', orgId: 'o1', accessToken: 'a1', refreshToken: 'r1', expiresAt: now - 1, status: 'active' };
    script(() => json(400, { error: 'invalid_grant' }));
    await assert.rejects(auth.accessTokenFor('u1', await auth.configFor('u1')), (e) => e.status === 401 && e.code === 'twoba_sign_in_required');
    assert.equal(vault.u1.status, 'needs_reauth');
    await assert.rejects(auth.accessTokenFor('u1', await auth.configFor('u1')), (e) => e.code === 'twoba_sign_in_required');

    vault.u1 = { userId: 'u1', orgId: 'o1', accessToken: 'a1', refreshToken: 'r1', expiresAt: now - 1, status: 'active' };
    script(() => {
        vault.u1 = { ...vault.u1, accessToken: 'a9', refreshToken: 'r9', expiresAt: now + 120_000 };
        return json(400, { error: 'invalid_grant' });
    });
    assert.equal(await auth.accessTokenFor('u1', await auth.configFor('u1')), 'a9');
    assert.equal(vault.u1.status, 'active');
});

test('code mode without a sign-in: a 401 that says so', async () => {
    useCode();
    script(() => json(200, {}));
    await assert.rejects(auth.accessTokenFor('u1', await auth.configFor('u1')), (e) => e.status === 401 && e.code === 'twoba_not_signed_in');
});

test('authorise URL: PKCE S256, the scopes, the state; the state check is single-user and time-bound', () => {
    const attempt = auth.newConnectAttempt('u1', 'https://bee.example/api/integrations/twoba/callback');
    const url = new URL(auth.authorizeUrl('client-1', attempt));
    assert.equal(`${url.origin}${url.pathname}`, 'https://authorize.2ba.nl/connect/authorize');
    assert.equal(url.searchParams.get('scope'), 'openid offline_access');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('code_challenge'), auth.codeChallenge(attempt.verifier));
    assert.equal(url.searchParams.get('client_secret'), null);
    assert.equal(auth.attemptMatches(attempt, attempt.state, 'u1'), true);
    assert.equal(auth.attemptMatches(attempt, attempt.state, 'u2'), false);
    assert.equal(auth.attemptMatches(attempt, 'x', 'u1'), false);
    now += auth.CONNECT_TTL_MS + 1;
    assert.equal(auth.attemptMatches(attempt, attempt.state, 'u1'), false);
});

test('transport: 429 and 503 are retried with capped back-off, then reported as 503', async () => {
    usePassword();
    let n = 0;
    script((call) => {
        if (call.url.includes('/connect/token')) return json(200, { access_token: 'tok', expires_in: 120 });
        n += 1;
        return n === 1 ? json(429, {}, { 'retry-after': '2' }) : n === 2 ? json(503, {}, { 'retry-after': '999' }) : json(200, { ok: 1 });
    });
    const conn = { userId: 'u1', cfg: await auth.configFor('u1') };
    assert.deepEqual(await twobaApi(conn, 'GET', '/CompanyConditions/databases'), { ok: 1 });
    assert.deepEqual(sleeps, [2000, MAX_DELAY_MS]);

    process.env.TWOBA_MAX_RETRIES = '1';
    script((call) => (call.url.includes('/connect/token') ? json(200, { access_token: 'tok', expires_in: 120 }) : json(503, {})));
    await assert.rejects(twobaApi(conn, 'GET', '/CompanyConditions/databases'), (e) => e.status === 503 && e.code === 'twoba_unavailable');
    assert.equal(calls.filter((c) => !c.url.includes('/connect/')).length, 2);
    assert.equal(retryDelayMs(json(429, {}), 3), 4000);
});

test('API: a 401 is retried once with a new token; the bearer goes in the header only', async () => {
    usePassword();
    let tokens = 0;
    let apiCalls = 0;
    script((call) => {
        if (call.url.includes('/connect/token')) return json(200, { access_token: `tok-${++tokens}`, expires_in: 120 });
        apiCalls += 1;
        return apiCalls === 1 ? json(401, {}) : json(200, [{ Id: 1 }]);
    });
    const conn = { userId: 'u1', cfg: await auth.configFor('u1') };
    assert.deepEqual(await twobaApi(conn, 'GET', '/CompanyConditions/databases'), [{ Id: 1 }]);
    const api = calls.filter((c) => !c.url.includes('/connect/'));
    assert.deepEqual(api.map((c) => c.init.headers.Authorization), ['Bearer tok-1', 'Bearer tok-2']);
    assert.ok(api.every((c) => !c.url.includes('tok-')));
});

test('errors: our sentence per status, 2BA\'s own message on a 4xx, a network failure is a 502', async () => {
    const e400 = errorForStatus(400, JSON.stringify({ Message: '<b>Invalid</b> GLN' }));
    assert.equal(e400.status, 400);
    assert.match(e400.message, /did not accept the request: Invalid GLN/);
    assert.equal(errorForStatus(500, 'boom').status, 502);
    assert.equal(errorForStatus(429, '').status, 503);
    usePassword();
    twobaTransport.fetch = async () => { throw new TypeError('fetch failed'); };
    await assert.rejects(auth.accessTokenFor('u1', await auth.configFor('u1')), (e) => e.status === 502 && e.code === 'twoba_unreachable');
});
