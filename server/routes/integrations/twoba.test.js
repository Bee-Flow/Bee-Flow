/**
 * "Sign in with 2BA" routes (routes/integrations/twoba.mts). The handlers are
 * called straight from the router (requireAuth is pinned by the route
 * contract, not here); stores are injected through `routeDeps` and
 * `authDeps`, the transport is scripted.
 *
 * Run: cd server && node --test routes/integrations/twoba.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeTwobaRouter, routeDeps } = require('./twoba.mts');
const auth = require('../../integrations/twobaAuth.mts');
const { twobaTransport } = require('../../integrations/twobaTransport.mts');

const router = makeTwobaRouter({ requireAuth: (_req, _res, next) => next() });
const SECRETS = {};
const stored = [];
const revokedLocal = [];
let vaultRow = null;
auth.authDeps.configStore = () => ({ getSecret: async (k) => SECRETS[k] ?? null });
routeDeps.vault = () => ({ getCredential: async () => vaultRow, upsertCredential: async (row) => { stored.push(row); } });
routeDeps.getUser = async () => ({ organizationId: 'orgA' });
routeDeps.revokeLocal = async (userId, provider) => { revokedLocal.push({ userId, provider }); return { found: !!vaultRow }; };

const calls = [];
/** 2BA's answers, one per expected request, in order. */
function script(responses) {
    calls.splice(0);
    const queue = [...responses];
    twobaTransport.fetch = async (url, init) => {
        calls.push({ url, init, form: Object.fromEntries(new URLSearchParams(String(init.body || ''))) });
        const next = queue.shift();
        assert.ok(next, `unexpected request to ${url}`);
        const status = next.status || 200;
        return { ok: status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(next.json ?? {}) };
    };
}

/** The handler after the gates of `method path`, called with a bare request and a recording response. */
async function call(method, path, { session, query = {} } = {}) {
    const route = router.stack.map((l) => l.route).find((r) => r && r.path === path && r.methods[method]);
    assert.ok(route, `${method} ${path} exists`);
    const res = { statusCode: 200 };
    res.status = (c) => Object.assign(res, { statusCode: c });
    res.json = (b) => Object.assign(res, { body: b });
    res.send = (h) => Object.assign(res, { html: h });
    await route.stack.at(-1).handle({ session, query, body: {}, protocol: 'http', headers: { host: 'bee.example', 'x-forwarded-proto': 'https' } }, res);
    return res;
}

const session = (extra = {}) => ({ user: { id: 'u1' }, save() {}, ...extra });

function configure(mode = 'authorization_code') {
    Object.assign(SECRETS, { twoba_client_id_user_u1: 'client-1', twoba_client_secret_user_u1: 'client-secret', twoba_auth_mode_user_u1: mode });
}

test.beforeEach(() => {
    for (const k of Object.keys(SECRETS)) delete SECRETS[k];
    stored.length = 0; revokedLocal.length = 0; vaultRow = null;
});

test('/auth-url refuses until the client is saved with "Sign in with 2BA"', async () => {
    const res = await call('get', '/auth-url', { session: session() });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'twoba_not_configured');
    configure('password');
    assert.equal((await call('get', '/auth-url', { session: session() })).statusCode, 400);
});

test('/auth-url stores a single-use attempt and answers the 2BA authorise URL', async () => {
    configure();
    const s = session();
    const res = await call('get', '/auth-url', { session: s });
    assert.ok(s.twobaConnect);
    const url = new URL(res.body.url);
    assert.equal(url.origin, 'https://authorize.2ba.nl');
    assert.equal(url.searchParams.get('state'), s.twobaConnect.state);
    assert.equal(url.searchParams.get('redirect_uri'), 'https://bee.example/api/integrations/twoba/callback');
    assert.ok(!res.body.url.includes('client-secret'));
});

test('/callback: a matching state exchanges the code (PKCE verifier, client in the body) into the vault', async () => {
    configure();
    const s = session();
    await call('get', '/auth-url', { session: s });
    const { state, verifier } = s.twobaConnect;
    script([{ json: { access_token: 'a1', refresh_token: 'r1', expires_in: 120 } }]);
    const res = await call('get', '/callback', { session: s, query: { code: 'the-code', state } });
    assert.match(res.html, /2BA connected!/);
    assert.equal(s.twobaConnect, undefined);
    assert.deepEqual(calls[0].form, {
        grant_type: 'authorization_code', code: 'the-code', redirect_uri: 'https://bee.example/api/integrations/twoba/callback',
        code_verifier: verifier, client_id: 'client-1', client_secret: 'client-secret',
    });
    assert.equal(stored[0].provider, 'twoba');
    assert.equal(stored[0].orgId, 'orgA');
    assert.equal(stored[0].refreshToken, 'r1');
    assert.ok(!res.html.includes('a1') && !res.html.includes('r1'));
});

test('/callback refuses a wrong state, a replay, a denial and a grant without refresh token', async () => {
    configure();
    const s = session();
    await call('get', '/auth-url', { session: s });
    const { state } = s.twobaConnect;
    assert.match((await call('get', '/callback', { session: s, query: { code: 'c', state: 'wrong' } })).html, /Invalid or expired/);
    assert.match((await call('get', '/callback', { session: s, query: { code: 'c', state } })).html, /Invalid or expired/);
    assert.match((await call('get', '/callback', { session: session(), query: { error: 'access_denied' } })).html, /cancelled or refused/);
    const s2 = session();
    await call('get', '/auth-url', { session: s2 });
    script([{ json: { access_token: 'a1', expires_in: 120 } }]);
    assert.match((await call('get', '/callback', { session: s2, query: { code: 'c', state: s2.twobaConnect.state } })).html, /sign-in failed/);
    assert.equal(stored.length, 0);
});

test('/status reports the mode, the sign-in and the redirect address', async () => {
    configure();
    vaultRow = { status: 'needs_reauth' };
    const res = await call('get', '/status', { session: session() });
    assert.deepEqual(res.body, { mode: 'authorization_code', configured: true, connected: false, needsReauth: true, redirectUri: 'https://bee.example/api/integrations/twoba/callback' });
});

test('/disconnect revokes the refresh token at 2BA, then deletes locally', async () => {
    configure();
    vaultRow = { status: 'active', refreshToken: 'r1', accessToken: 'a1' };
    script([{ json: {} }]);
    const res = await call('post', '/disconnect', { session: session() });
    assert.deepEqual(res.body, { success: true, hadCredential: true, revokedAt2ba: true });
    assert.equal(calls[0].url, 'https://authorize.2ba.nl/connect/revocation');
    assert.equal(calls[0].form.token, 'r1');
    assert.deepEqual(revokedLocal, [{ userId: 'u1', provider: 'twoba' }]);
});
