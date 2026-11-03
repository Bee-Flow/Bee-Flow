/**
 * NMBRS REST connector routes (routes/integrations/nmbrs.js). The handlers are called
 * straight from the router (requireAuth is pinned by the route contract, not here);
 * stores are injected through `routeDeps` and `oauthDeps`, the transport is scripted.
 *
 * Run: cd server && node --test routes/integrations/nmbrs.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const router = require('./nmbrs');
const oauth = require('../../integrations/nmbrsOAuth.mts');
const { nmbrsTransport } = require('../../integrations/nmbrsTransport.mts');

const SECRETS = {};
const stored = [];
const revokedLocal = [];
let vaultRow = null;
oauth.oauthDeps.configStore = () => ({ getSecret: async (k) => SECRETS[k] ?? null });
router.routeDeps.vault = () => ({
    getCredential: async () => vaultRow,
    upsertCredential: async (row) => { stored.push(row); },
});
router.routeDeps.getUser = async () => ({ organizationId: 'orgA' });
router.routeDeps.revokeLocal = async (userId, provider) => { revokedLocal.push({ userId, provider }); return { found: !!vaultRow }; };

let calls = [];
function script(responses) {
    calls = [];
    nmbrsTransport.fetch = async (url, opts) => {
        calls.push({ url, opts });
        const r = responses[calls.length - 1];
        if (r === undefined) throw new Error(`Unexpected request #${calls.length}: ${url}`);
        return { ok: r.ok !== false, status: r.status || 200, json: async () => r.json, text: async () => JSON.stringify(r.json ?? {}) };
    };
}

/** The last handler on a route (after requireAuth). */
function handler(method, path) {
    const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
    assert.ok(layer, `${method} ${path} exists`);
    const stack = layer.route.stack;
    return stack[stack.length - 1].handle;
}

async function call(method, path, { session, query = {} } = {}) {
    const req = { session, query, headers: { host: 'app.example', 'x-forwarded-proto': 'https' }, protocol: 'http' };
    const res = {
        statusCode: 200, body: undefined, html: undefined,
        status(c) { this.statusCode = c; return this; },
        json(b) { this.body = b; return this; },
        send(h) { this.html = h; return this; },
    };
    await handler(method, path)(req, res);
    return res;
}

function session(extra = {}) {
    return { user: { id: 'u1' }, save() {}, ...extra };
}

function configure() {
    SECRETS.nmbrs_client_id_user_u1 = 'client-id';
    SECRETS.nmbrs_client_secret_user_u1 = 'client-secret';
    SECRETS.nmbrs_subscription_key_user_u1 = 'sub-key';
}

test('/auth-url refuses until the REST settings are saved', async () => {
    for (const k of Object.keys(SECRETS)) delete SECRETS[k];
    const res = await call('get', '/auth-url', { session: session() });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'nmbrs_not_configured');
});

test('/auth-url then /callback: tokens go to the vault, the attempt is single use', async () => {
    configure();
    const s = session();
    const start = await call('get', '/auth-url', { session: s });
    assert.strictEqual(start.body.redirectUri, 'https://app.example/api/integrations/nmbrs/callback');
    const state = new URL(start.body.url).searchParams.get('state');
    assert.ok(s.nmbrsConnect && s.nmbrsConnect.state === state);
    assert.ok(!start.body.url.includes('client-secret'));

    script([{ json: { access_token: 'at1', refresh_token: 'rt1', expires_in: 3600, scope: 'offline_access' } }]);
    stored.length = 0;
    const done = await call('get', '/callback', { session: s, query: { code: 'c1', state } });
    assert.match(done.html, /NMBRS connected/);
    assert.strictEqual(s.nmbrsConnect, undefined, 'the attempt is gone');
    assert.strictEqual(stored.length, 1);
    assert.deepStrictEqual({ ...stored[0], expiresAt: null }, { userId: 'u1', orgId: 'orgA', provider: 'nmbrs', accessToken: 'at1', refreshToken: 'rt1', expiresAt: null, scope: 'offline_access' });
    assert.ok(!done.html.includes('at1') && !done.html.includes('rt1'), 'no token in the page');

    // Replaying the same callback fails: nothing is left to match.
    script([]);
    const replay = await call('get', '/callback', { session: s, query: { code: 'c1', state } });
    assert.match(replay.html, /Invalid or expired/);
    assert.strictEqual(calls.length, 0);
});

test('/callback refuses another user, a wrong state, a missing session and a denial', async () => {
    configure();
    script([]);
    const a = session();
    const start = await call('get', '/auth-url', { session: a });
    const state = new URL(start.body.url).searchParams.get('state');
    const other = session({ user: { id: 'u2' }, nmbrsConnect: a.nmbrsConnect });
    assert.match((await call('get', '/callback', { session: other, query: { code: 'c', state } })).html, /Invalid or expired/);
    const wrong = session({ nmbrsConnect: { ...a.nmbrsConnect } });
    assert.match((await call('get', '/callback', { session: wrong, query: { code: 'c', state: 'x'.repeat(32) } })).html, /Invalid or expired/);
    assert.match((await call('get', '/callback', { session: undefined, query: { code: 'c', state } })).html, /Not authenticated/);
    assert.match((await call('get', '/callback', { session: session(), query: { error: 'access_denied' } })).html, /denied/);
    assert.strictEqual(calls.length, 0, 'no token request for any of them');
});

test('/status reports the setup without any secret', async () => {
    configure();
    SECRETS.nmbrs_api_mode_user_u1 = 'soap';
    vaultRow = { status: 'needs_reauth' };
    const res = await call('get', '/status', { session: session() });
    assert.deepStrictEqual(res.body, {
        mode: 'soap', configured: true, hasSubscriptionKey: true, hasClient: true, connected: false, needsReauth: true,
        redirectUri: 'https://app.example/api/integrations/nmbrs/callback', soapSunset: '2027-03-01',
    });
    assert.ok(!JSON.stringify(res.body).includes('secret') && !JSON.stringify(res.body).includes('sub-key'));
});

test('/disconnect revokes at Nmbrs, then deletes locally', async () => {
    configure();
    vaultRow = { status: 'active', refreshToken: 'rt', accessToken: 'at' };
    revokedLocal.length = 0;
    script([{ status: 200, json: {} }, { status: 200, json: {} }]);
    const res = await call('post', '/disconnect', { session: session() });
    assert.deepStrictEqual(res.body, { success: true, hadCredential: true, revokedAtNmbrs: true });
    assert.ok(calls.every((c) => c.url === 'https://identityservice.nmbrs.com/connect/revocation'));
    assert.deepStrictEqual(revokedLocal, [{ userId: 'u1', provider: 'nmbrs' }]);
});
