/**
 * BFSF-255 — Google Workspace connector route tests.
 *
 * Pins the decoupled connect flow: auth-url (offline access + PKCE + state),
 * callback (tokens → encrypted vault, session hydration tagged 'connector',
 * never clobbering a foreign SSO session, per-user vault scope for org-less
 * consumers), status (vault + session fallback), disconnect (shared revoke
 * helper + session cleanup).
 *
 * Deps are stubbed via the Module resolve hook; global.fetch is stubbed for
 * the token exchange + userinfo calls.
 *
 * Run: cd server && node --test routes/integrations/googleWorkspace.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// ── Mutable fixtures ─────────────────────────────────────────────────
const fx = {
    clientId: 'gid',
    clientSecret: 'gsecret',
    user: { id: 'u1', organizationId: 'orgA', email: 'tom@example.com' },
    upserts: [],            // routineCredentialStore.upsertCredential spy
    cred: null,             // getCredential fixture
    configSets: [],         // configStore.setConfig spy
    revokes: [],            // revokeProviderCredential spy
    connections: [],        // integrationConnectionStore.createConnection spy
    tokenResponse: { access_token: 'at_1', refresh_token: 'rt_1', expires_in: 3600, scope: 's' },
    userinfo: { email: 'tom@gmail.example' },
};

const MOCKS = {
    '../../stores/configStore': {
        setConfig: async (k, v) => { fx.configSets.push({ k, v }); },
        getConfig: async (k) => (k.startsWith('google_workspace_email_user_') ? 'stored@example.com' : null),
        deleteConfig: async () => {},
    },
    '../../stores/routineCredentialStore': {
        upsertCredential: async (row) => { fx.upserts.push(row); },
        getCredential: async () => fx.cred,
    },
    '../../auth/permissions': {
        OAUTH_PROVIDERS: {
            google: {
                authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
                tokenUrl: 'https://oauth2.googleapis.com/token',
                userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
                scopes: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.modify'],
            },
        },
        loadConfig: async () => ({ providers: { google: { clientId: fx.clientId, clientSecret: fx.clientSecret } } }),
        // Mirrors the real gate closely enough for these routes: 401 without a
        // session user, pass through otherwise.
        requireAuth: (req, res, next) => {
            if (!req.session?.user?.id) return res.status(401).json({ error: 'Not authenticated' });
            next();
        },
    },
    '../../stores/userStore': { getUser: async () => fx.user },
    '../../stores/integrationConnectionStore': {
        // The connector upserts (one Google identity per user) — a plain
        // create would stack a duplicate row on every reconnect.
        upsertOAuthConnection: async (row) => { fx.connections.push(row); return { id: 'c1' }; },
    },
    '../../stores/aiTaskStore': { resumeNeedsReauthForUser: async () => 0 },
    '../../stores/coworkStore': { resumeNeedsReauthForUser: async () => 0 },
    '../../auth/oauthRoutes': {
        revokeProviderCredential: async (userId, provider) => { fx.revokes.push({ userId, provider }); return { found: true, deleted: true }; },
    },
    // Faithful mini-implementation (the real derivation is pinned in
    // gmeetNotesSettings.test.js) — the real module drags in configStore/db.
    '../../core/meetingNotes/gmeetNotesSettings': {
        hasMeetScopes: (scope) => String(scope || '').split(/\s+/).includes('https://www.googleapis.com/auth/meetings.space.readonly'),
    },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:gws:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /integrations[\\/]googleWorkspace\.js$/.test(parent.filename) && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

// fetch stub — token exchange + userinfo.
const realFetch = global.fetch;
global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com/token')) {
        return { ok: true, json: async () => fx.tokenResponse, text: async () => '' };
    }
    if (u.includes('userinfo')) {
        return { ok: true, json: async () => fx.userinfo };
    }
    throw new Error(`unexpected fetch ${u}`);
};

const router = require('./googleWorkspace');

test.after(() => {
    Module._resolveFilename = originalResolve;
    global.fetch = realFetch;
});

function resetFx() {
    fx.clientId = 'gid';
    fx.user = { id: 'u1', organizationId: 'orgA', email: 'tom@example.com' };
    fx.upserts.length = 0;
    fx.cred = null;
    fx.configSets.length = 0;
    fx.revokes.length = 0;
    fx.connections.length = 0;
}

function makeSession(extra = {}) {
    return { user: { id: 'u1', email: 'tom@example.com' }, save(cb) { if (cb) cb(); }, ...extra };
}

function dispatch({ method = 'GET', url, body = {}, session, query = {} }) {
    return new Promise((resolve, reject) => {
        const qs = new URLSearchParams(query).toString();
        const request = {
            method,
            url: qs ? `${url}?${qs}` : url,
            body,
            query,
            headers: { host: 'app.example' },
            protocol: 'https',
            session,
            get(name) { return this.headers[String(name).toLowerCase()]; },
        };
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(request, res, (err) => reject(err || new Error(`fell through router: ${method} ${url}`)));
    });
}

// ═══ auth-url ═══════════════════════════════════════════════════════

test('auth-url: offline access + consent + PKCE, state stashed in session', async () => {
    resetFx();
    const session = makeSession();
    const res = await dispatch({ url: '/auth-url', session });
    assert.strictEqual(res.statusCode, 200);
    const url = new URL(res.body.url);
    assert.strictEqual(url.searchParams.get('access_type'), 'offline', 'offline → refresh token for the vault');
    assert.strictEqual(url.searchParams.get('prompt'), 'consent');
    assert.ok(url.searchParams.get('code_challenge'), 'PKCE challenge present');
    assert.strictEqual(url.searchParams.get('state'), session.googleConnectState, 'CSRF state stashed');
    assert.ok(url.searchParams.get('redirect_uri').endsWith('/api/integrations/google/callback'));
});

test('auth-url: 400 google_not_configured without a client id; 401 unauthenticated', async () => {
    resetFx();
    fx.clientId = '';
    let res = await dispatch({ url: '/auth-url', session: makeSession() });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'google_not_configured');

    resetFx();
    res = await dispatch({ url: '/auth-url', session: {} });
    assert.strictEqual(res.statusCode, 401);
});

// ═══ callback ═══════════════════════════════════════════════════════

test('callback: tokens land in the vault, session hydrated with connector tag', async () => {
    resetFx();
    const session = makeSession({ googleConnectState: 'st1', googleConnectVerifier: 'v1', googleConnectRedirectUri: 'https://app.example/api/integrations/google/callback' });
    const res = await dispatch({ url: '/callback', session, query: { code: 'c1', state: 'st1' } });
    assert.ok(String(res.body).includes('google-callback'), 'popup postMessage HTML');
    assert.ok(String(res.body).includes('success: true'));

    assert.strictEqual(fx.upserts.length, 1, 'vault upsert');
    assert.deepStrictEqual(
        { userId: fx.upserts[0].userId, orgId: fx.upserts[0].orgId, provider: fx.upserts[0].provider, refreshToken: fx.upserts[0].refreshToken },
        { userId: 'u1', orgId: 'orgA', provider: 'google', refreshToken: 'rt_1' }
    );
    assert.strictEqual(session.oauthProvider, 'google', 'live session hydrated');
    assert.strictEqual(session.oauthTokenSource, 'connector', 'tagged as connector — NOT SSO (forced-MFA gate)');
    assert.strictEqual(session.googleConnectState, undefined, 'state cleaned up');
    assert.strictEqual(fx.connections.length, 1, 'metadata connection row created immediately');
    assert.ok(fx.configSets.some(s => s.k === 'google_workspace_email_user_u1' && s.v === 'tom@gmail.example'));
});

test('callback: NEVER clobbers a foreign SSO session (Microsoft stays Microsoft)', async () => {
    resetFx();
    const session = makeSession({
        googleConnectState: 'st1', googleConnectVerifier: 'v1',
        oauthProvider: 'microsoft', accessToken: 'ms_at', oauthTokenSource: undefined,
    });
    await dispatch({ url: '/callback', session, query: { code: 'c1', state: 'st1' } });
    assert.strictEqual(session.oauthProvider, 'microsoft', 'session identity untouched');
    assert.strictEqual(session.accessToken, 'ms_at', 'Microsoft token untouched');
    assert.strictEqual(fx.upserts.length, 1, 'vault still gets the Google tokens (routines work)');
});

test('callback: org-less consumers get a per-user vault scope (write never skipped)', async () => {
    resetFx();
    fx.user = { id: 'u1', organizationId: null, email: 'tom@example.com' };
    const session = makeSession({ googleConnectState: 'st1', googleConnectVerifier: 'v1' });
    await dispatch({ url: '/callback', session, query: { code: 'c1', state: 'st1' } });
    assert.strictEqual(fx.upserts.length, 1);
    assert.strictEqual(fx.upserts[0].orgId, 'user:u1', 'per-user encryption scope');
});

test('callback: state mismatch is rejected before any token exchange', async () => {
    resetFx();
    const session = makeSession({ googleConnectState: 'expected' });
    const res = await dispatch({ url: '/callback', session, query: { code: 'c1', state: 'WRONG' } });
    assert.ok(String(res.body).includes('Invalid state'), 'CSRF rejection');
    assert.strictEqual(fx.upserts.length, 0, 'nothing persisted');
});

// ═══ status ═════════════════════════════════════════════════════════

test('status: active vault credential → connected with stored email', async () => {
    resetFx();
    fx.cred = { status: 'active' };
    const res = await dispatch({ url: '/status', session: makeSession() });
    assert.deepStrictEqual(
        { configured: res.body.configured, connected: res.body.connected, needsReauth: res.body.needsReauth, email: res.body.email },
        { configured: true, connected: true, needsReauth: false, email: 'stored@example.com' }
    );
});

test('status: needs_reauth credential → reconnect state; no credential + SSO session → connected', async () => {
    resetFx();
    fx.cred = { status: 'needs_reauth' };
    let res = await dispatch({ url: '/status', session: makeSession() });
    assert.strictEqual(res.body.connected, false);
    assert.strictEqual(res.body.needsReauth, true);

    resetFx();
    fx.cred = null; // org-less Google-SSO consumer: no vault row, live session only
    res = await dispatch({ url: '/status', session: makeSession({ oauthProvider: 'google', accessToken: 'at' }) });
    assert.strictEqual(res.body.connected, true, 'session fallback counts as connected');
});

test('status: meetScopesGranted pins on the stored credential scope (both ways)', async () => {
    resetFx();
    fx.cred = { status: 'active', scope: 'openid email https://www.googleapis.com/auth/meetings.space.readonly' };
    let res = await dispatch({ url: '/status', session: makeSession() });
    assert.strictEqual(res.body.meetScopesGranted, true, 'Meet readonly scope in the vault → granted');

    resetFx();
    fx.cred = { status: 'active', scope: 'openid email https://www.googleapis.com/auth/gmail.modify' };
    res = await dispatch({ url: '/status', session: makeSession() });
    assert.strictEqual(res.body.meetScopesGranted, false, 'pre-Meet-scope credential → reconnect CTA');

    resetFx();
    fx.cred = null; // live-session-only user: scope unknown → false (hint reconnect)
    res = await dispatch({ url: '/status', session: makeSession({ oauthProvider: 'google', accessToken: 'at' }) });
    assert.strictEqual(res.body.connected, true);
    assert.strictEqual(res.body.meetScopesGranted, false, 'unknown scope reported as not granted');
});

// ═══ disconnect ═════════════════════════════════════════════════════

test('disconnect: shared revoke helper + Google session tokens cleared', async () => {
    resetFx();
    const session = makeSession({ oauthProvider: 'google', accessToken: 'at', refreshToken: 'rt', oauthTokenSource: 'connector' });
    const res = await dispatch({ method: 'POST', url: '/disconnect', session });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(fx.revokes, [{ userId: 'u1', provider: 'google' }]);
    assert.strictEqual(session.oauthProvider, undefined, 'session google identity cleared');
    assert.strictEqual(session.accessToken, undefined);
});

test('disconnect: a Microsoft SSO session is left untouched', async () => {
    resetFx();
    const session = makeSession({ oauthProvider: 'microsoft', accessToken: 'ms_at' });
    await dispatch({ method: 'POST', url: '/disconnect', session });
    assert.strictEqual(session.oauthProvider, 'microsoft');
    assert.strictEqual(session.accessToken, 'ms_at');
});
