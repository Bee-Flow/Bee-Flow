/**
 * NMBRS OAuth (nmbrsOAuth.mts): the authorise URL, the state check, the token calls
 * and the access-token resolver behind the REST tools. The transport is scripted and
 * the stores are injected; nothing touches the network or a database.
 */

const test = require('node:test');
const assert = require('node:assert');

const { nmbrsTransport } = require('./nmbrsTransport.mts');
const oauth = require('./nmbrsOAuth.mts');

const SECRETS = {
    nmbrs_client_id_user_u1: '7xr7NV9yqcUz*r2C$ey6',
    nmbrs_client_secret_user_u1: 'client-secret-value',
    nmbrs_subscription_key_user_u1: 'sub-key',
};
let vault = {};
let reauthMarked = [];
let now = 1_000_000;
oauth.oauthDeps.configStore = () => ({ getSecret: async (k) => SECRETS[k] ?? null });
oauth.oauthDeps.now = () => now;
oauth.oauthDeps.credentials = () => ({
    getCredential: async (userId) => vault[userId] || null,
    upsertCredential: async (row) => { vault[row.userId] = { ...vault[row.userId], ...row, status: 'active' }; },
    markNeedsReauth: async (userId, _p, reason) => { reauthMarked.push({ userId, reason }); vault[userId].status = 'needs_reauth'; },
});

let calls = [];
function script(responses) {
    calls = [];
    nmbrsTransport.fetch = async (url, opts) => {
        calls.push({ url, opts });
        const r = typeof responses === 'function' ? await responses(calls.length) : responses[calls.length - 1];
        if (r === undefined) throw new Error(`Unexpected request #${calls.length}: ${url}`);
        return { ok: r.ok !== false, status: r.status || 200, json: async () => r.json, text: async () => JSON.stringify(r.json ?? {}) };
    };
}
const client = { clientId: SECRETS.nmbrs_client_id_user_u1, clientSecret: SECRETS.nmbrs_client_secret_user_u1 };
const BASIC = `Basic ${Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`).toString('base64')}`;

test('the authorise URL: documented endpoint, read scopes + offline_access, PKCE S256, no secret', () => {
    const attempt = oauth.newConnectAttempt('u1', 'https://app.example/api/integrations/nmbrs/callback');
    const url = new URL(oauth.authorizeUrl(client.clientId, attempt));
    assert.strictEqual(`${url.origin}${url.pathname}`, 'https://identityservice.nmbrs.com/connect/authorize');
    assert.strictEqual(url.searchParams.get('response_type'), 'code');
    assert.strictEqual(url.searchParams.get('client_id'), client.clientId);
    assert.strictEqual(url.searchParams.get('state'), attempt.state);
    assert.strictEqual(url.searchParams.get('code_challenge_method'), 'S256');
    assert.strictEqual(url.searchParams.get('code_challenge'), oauth.codeChallenge(attempt.verifier));
    assert.notStrictEqual(url.searchParams.get('code_challenge'), attempt.verifier);
    const scopes = url.searchParams.get('scope').split(' ');
    assert.ok(scopes.includes('offline_access') && scopes.every((s) => s === 'offline_access' || s.endsWith('.read')), scopes.join(' '));
    assert.ok(!url.href.includes(client.clientSecret) && !url.href.includes(attempt.verifier));
});

test('the state check: equal, same user, fresh; anything else fails', () => {
    const attempt = oauth.newConnectAttempt('u1', 'https://x/cb');
    assert.strictEqual(oauth.attemptMatches(attempt, attempt.state, 'u1'), true);
    assert.strictEqual(oauth.attemptMatches(attempt, attempt.state, 'u2'), false, 'another user');
    const other = `${attempt.state[0] === 'a' ? 'b' : 'a'}${attempt.state.slice(1)}`;
    assert.strictEqual(oauth.attemptMatches(attempt, other, 'u1'), false, 'another state of the same length');
    assert.strictEqual(oauth.attemptMatches(attempt, '', 'u1'), false);
    assert.strictEqual(oauth.attemptMatches(undefined, attempt.state, 'u1'), false, 'no attempt in the session');
    now += oauth.CONNECT_TTL_MS + 1;
    assert.strictEqual(oauth.attemptMatches(attempt, attempt.state, 'u1'), false, 'expired');
});

test('the code exchange: Basic client auth, form body with the PKCE verifier', async () => {
    const attempt = oauth.newConnectAttempt('u1', 'https://x/cb');
    script([{ json: { access_token: 'at1', refresh_token: 'rt1', expires_in: 3600, token_type: 'Bearer', scope: 'company.info.read offline_access' } }]);
    const tokens = await oauth.exchangeCode(client, 'the-code', attempt);
    assert.strictEqual(calls[0].url, 'https://identityservice.nmbrs.com/connect/token');
    assert.strictEqual(calls[0].opts.method, 'POST');
    assert.strictEqual(calls[0].opts.redirect, 'error');
    assert.strictEqual(calls[0].opts.headers.Authorization, BASIC);
    const form = new URLSearchParams(calls[0].opts.body);
    assert.deepStrictEqual(Object.fromEntries(form), { grant_type: 'authorization_code', code: 'the-code', redirect_uri: 'https://x/cb', code_verifier: attempt.verifier });
    assert.ok(!calls[0].opts.body.includes(client.clientSecret), 'the secret is in the header only');
    assert.deepStrictEqual(tokens, { accessToken: 'at1', refreshToken: 'rt1', expiresAt: now + 3600_000, scope: 'company.info.read offline_access' });
});

test('a refused grant is a reauth error; other failures are not, and no body text leaks', async () => {
    script([{ ok: false, status: 400, json: { error: 'invalid_grant', error_description: 'echo of rt-secret' } }]);
    await assert.rejects(oauth.refreshTokens(client, 'rt'), (e) => e instanceof oauth.NmbrsReauthError && !e.message.includes('rt-secret'));
    script([{ ok: false, status: 503, json: {} }]);
    await assert.rejects(oauth.refreshTokens(client, 'rt'), (e) => !(e instanceof oauth.NmbrsReauthError) && /http_503/.test(e.message));
});

test('a fresh token is used as is; a nearly expired one is refreshed once, and the new refresh token is kept', async () => {
    vault = { u1: { userId: 'u1', orgId: 'o1', accessToken: 'at-old', refreshToken: 'rt-old', expiresAt: now + 3600_000, scope: null, status: 'active' } };
    script([]);
    assert.deepStrictEqual(await oauth.accessTokenFor('u1'), { token: 'at-old' });
    assert.strictEqual(calls.length, 0);

    vault.u1.expiresAt = now + 60_000; // inside the refresh margin
    script(async () => ({ json: { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600 } }));
    const [a, b] = await Promise.all([oauth.accessTokenFor('u1'), oauth.accessTokenFor('u1')]);
    assert.deepStrictEqual([a, b], [{ token: 'at-new' }, { token: 'at-new' }]);
    assert.strictEqual(calls.length, 1, 'one refresh for two concurrent calls: a refresh token is single use');
    assert.strictEqual(new URLSearchParams(calls[0].opts.body).get('refresh_token'), 'rt-old');
    assert.strictEqual(vault.u1.refreshToken, 'rt-new');
});

test('a dead grant marks the vault row and says reconnect; a transient failure says try again', async () => {
    vault = { u1: { userId: 'u1', orgId: 'o1', accessToken: 'at', refreshToken: 'rt', expiresAt: now - 1, scope: null, status: 'active' } };
    script([{ ok: false, status: 503, json: {} }]);
    assert.match((await oauth.accessTokenFor('u1')).error, /Try again/);
    assert.strictEqual(vault.u1.status, 'active');

    reauthMarked = [];
    script([{ ok: false, status: 400, json: { error: 'invalid_grant' } }]);
    assert.match((await oauth.accessTokenFor('u1')).error, /Reconnect NMBRS/);
    assert.strictEqual(reauthMarked.length, 1);
    script([]);
    assert.match((await oauth.accessTokenFor('u1')).error, /Reconnect NMBRS/, 'needs_reauth stays reconnect, no new request');
    assert.strictEqual(calls.length, 0);
    assert.match((await oauth.accessTokenFor('nobody')).error, /not connected/);
});

test('revocation: both tokens, Basic auth, RFC 7009 form; nothing without client config', async () => {
    script([{ status: 200, json: {} }, { status: 200, json: {} }]);
    assert.strictEqual(await oauth.revokeAtNmbrs(client, { refreshToken: 'rt', accessToken: 'at' }), true);
    assert.deepStrictEqual(calls.map((c) => c.url), ['https://identityservice.nmbrs.com/connect/revocation', 'https://identityservice.nmbrs.com/connect/revocation']);
    assert.deepStrictEqual(Object.fromEntries(new URLSearchParams(calls[0].opts.body)), { token: 'rt', token_type_hint: 'refresh_token' });
    assert.strictEqual(calls[1].opts.headers.Authorization, BASIC);
    script([]);
    assert.strictEqual(await oauth.revokeAtNmbrs({ clientId: '', clientSecret: '' }, { refreshToken: 'rt', accessToken: 'at' }), false);
    assert.strictEqual(calls.length, 0);
});
