/**
 * Microsoft 365 connector route tests.
 *
 * Pins the flow that makes Outlook usable without a Microsoft-SSO login:
 * auth-url (PKCE + state + the shared-mailbox scopes), callback (tokens →
 * encrypted vault with the GRANTED scope recorded, session hydration that never
 * clobbers a foreign SSO session, per-user vault scope for org-less accounts,
 * admin-consent detection), status, disconnect.
 *
 * Run: cd server && node --test routes/integrations/microsoft365.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const fx = {
    clientId: 'mid',
    clientSecret: 'msecret',
    tenantId: 'common',
    user: { id: 'u1', organizationId: 'orgA', email: 'tom@example.com' },
    upserts: [],
    cred: null,
    configSets: [],
    revokes: [],
    connections: [],
    tokenOk: true,
    tokenErrorText: '',
    tokenResponse: {
        access_token: 'at_1',
        refresh_token: 'rt_1',
        expires_in: 3600,
        scope: 'openid profile email Mail.Read Mail.Send Mail.Read.Shared Mail.Send.Shared offline_access',
    },
    me: { mail: 'Tom@Example.com', userPrincipalName: 'tom@example.com' },
};

const MOCKS = {
    '../../stores/configStore': {
        setConfig: async (k, v) => { fx.configSets.push({ k, v }); },
        getConfig: async (k) => (k.startsWith('microsoft365_email_user_') ? 'stored@example.com' : null),
        deleteConfig: async () => {},
    },
    '../../stores/automationCredentialStore': {
        upsertCredential: async (row) => { fx.upserts.push(row); },
        getCredential: async () => fx.cred,
    },
    '../../auth/permissions': {
        OAUTH_PROVIDERS: {
            microsoft: {
                authUrl: (t) => `https://login.microsoftonline.com/${t}/oauth2/v2.0/authorize`,
                tokenUrl: (t) => `https://login.microsoftonline.com/${t}/oauth2/v2.0/token`,
                userInfoUrl: 'https://graph.microsoft.com/v1.0/me',
            },
        },
        MICROSOFT_SCOPES: ['openid', 'email', 'profile', 'User.Read', 'Mail.Read', 'Mail.Send', 'offline_access'],
        loadConfig: async () => ({
            providers: { microsoft: { clientId: fx.clientId, clientSecret: fx.clientSecret, tenantId: fx.tenantId } },
        }),
        requireAuth: (req, res, next) => {
            if (!req.session?.user?.id) return res.status(401).json({ error: 'Not authenticated' });
            next();
        },
    },
    '../../stores/userStore': { getUser: async () => fx.user },
    '../../stores/integrationConnectionStore': {
        upsertOAuthConnection: async (row) => { fx.connections.push(row); return { id: 'c1' }; },
    },
    '../../stores/aiTaskStore': { resumeNeedsReauthForUser: async () => 0 },
    '../../stores/coworkStore': { resumeNeedsReauthForUser: async () => 0 },
    '../../auth/oauthRoutes': {
        revokeProviderCredential: async (userId, provider) => {
            fx.revokes.push({ userId, provider });
            return { found: true, deleted: true };
        },
    },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:ms365:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /integrations[\\/]microsoft365\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const realFetch = global.fetch;
global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/oauth2/v2.0/token')) {
        return {
            ok: fx.tokenOk,
            json: async () => fx.tokenResponse,
            text: async () => fx.tokenErrorText,
        };
    }
    if (u.includes('graph.microsoft.com/v1.0/me')) {
        return { ok: true, json: async () => fx.me };
    }
    throw new Error(`unexpected fetch ${u}`);
};

const router = require('./microsoft365');

test.after(() => {
    Module._resolveFilename = originalResolve;
    global.fetch = realFetch;
});

function resetFx() {
    fx.clientId = 'mid';
    fx.user = { id: 'u1', organizationId: 'orgA', email: 'tom@example.com' };
    fx.upserts.length = 0;
    fx.cred = null;
    fx.configSets.length = 0;
    fx.revokes.length = 0;
    fx.connections.length = 0;
    fx.tokenOk = true;
    fx.tokenErrorText = '';
    fx.tokenResponse = {
        access_token: 'at_1',
        refresh_token: 'rt_1',
        expires_in: 3600,
        scope: 'openid profile email Mail.Read Mail.Send Mail.Read.Shared Mail.Send.Shared offline_access',
    };
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

// ═══ scopes ═════════════════════════════════════════════════════════

test('the connect scope set adds shared-mailbox access but NOT Mail.ReadWrite', () => {
    // Least privilege: the send layer uses Graph's single-call `reply`, which
    // needs only Mail.Send(.Shared). Asking for mailbox write access to send one
    // message is what gets an app blocked by tenant policy.
    assert.ok(router.MS_CONNECT_SCOPES.includes('Mail.Read.Shared'));
    assert.ok(router.MS_CONNECT_SCOPES.includes('Mail.Send.Shared'));
    assert.ok(!router.MS_CONNECT_SCOPES.includes('Mail.ReadWrite'));
    assert.ok(router.MS_CONNECT_SCOPES.includes('offline_access'));
});

test('hasSharedMailboxScopes needs BOTH shared scopes', () => {
    assert.strictEqual(router.hasSharedMailboxScopes('Mail.Read.Shared Mail.Send.Shared'), true);
    assert.strictEqual(router.hasSharedMailboxScopes('Mail.Read.Shared'), false);
    assert.strictEqual(router.hasSharedMailboxScopes('Mail.Read Mail.Send'), false);
    assert.strictEqual(router.hasSharedMailboxScopes(''), false);
    assert.strictEqual(router.hasSharedMailboxScopes(null), false);
});

// ═══ auth-url ═══════════════════════════════════════════════════════

test('auth-url: PKCE + state + tenant + shared scopes', async () => {
    resetFx();
    const session = makeSession();
    const res = await dispatch({ url: '/auth-url', session });

    assert.strictEqual(res.statusCode, 200);
    const url = new URL(res.body.url);
    assert.strictEqual(url.origin + url.pathname, 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    assert.strictEqual(url.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(url.searchParams.get('code_challenge'));
    assert.strictEqual(url.searchParams.get('prompt'), 'consent', 'the wider scopes need a fresh consent screen');
    assert.match(url.searchParams.get('scope'), /Mail\.Read\.Shared/);
    assert.strictEqual(url.searchParams.get('state'), session.microsoftConnectState);
    assert.ok(session.microsoftConnectVerifier, 'the verifier is stashed for the callback');
});

test('auth-url: honours a custom tenant', async () => {
    resetFx();
    fx.tenantId = 'contoso.onmicrosoft.com';
    const res = await dispatch({ url: '/auth-url', session: makeSession() });
    assert.match(res.body.url, /login\.microsoftonline\.com\/contoso\.onmicrosoft\.com\//);
    fx.tenantId = 'common';
});

test('auth-url: 400 when Microsoft is not configured, 401 without a session', async () => {
    resetFx();
    fx.clientId = '';
    const unconfigured = await dispatch({ url: '/auth-url', session: makeSession() });
    assert.strictEqual(unconfigured.statusCode, 400);
    assert.strictEqual(unconfigured.body.code, 'microsoft_not_configured');

    resetFx();
    const anon = await dispatch({ url: '/auth-url', session: { save() {} } });
    assert.strictEqual(anon.statusCode, 401);
});

// ═══ callback ═══════════════════════════════════════════════════════

test('callback: stores the GRANTED scope in the vault', async () => {
    // This is what keeps a refresh from narrowing the grant back to login scopes.
    resetFx();
    const session = makeSession({ microsoftConnectState: 'st', microsoftConnectVerifier: 'v' });
    const res = await dispatch({ url: '/callback', session, query: { code: 'c', state: 'st' } });

    assert.match(res.body, /Connected as tom@example\.com/);
    assert.strictEqual(fx.upserts.length, 1);
    assert.strictEqual(fx.upserts[0].provider, 'microsoft');
    assert.strictEqual(fx.upserts[0].orgId, 'orgA');
    assert.strictEqual(fx.upserts[0].refreshToken, 'rt_1');
    assert.match(fx.upserts[0].scope, /Mail\.Read\.Shared/);
});

test('callback: org-less accounts still get a durable credential', async () => {
    // The SSO path skips the vault write entirely for these users, which is
    // exactly why their connectors died with the session.
    resetFx();
    fx.user = { id: 'u1', organizationId: null };
    const session = makeSession({ microsoftConnectState: 'st', microsoftConnectVerifier: 'v' });
    await dispatch({ url: '/callback', session, query: { code: 'c', state: 'st' } });

    assert.strictEqual(fx.upserts[0].orgId, 'user:u1');
});

test('callback: hydrates a bare session but never clobbers a Google SSO session', async () => {
    resetFx();
    const bare = makeSession({ microsoftConnectState: 'st', microsoftConnectVerifier: 'v' });
    await dispatch({ url: '/callback', session: bare, query: { code: 'c', state: 'st' } });
    assert.strictEqual(bare.oauthProvider, 'microsoft');
    assert.strictEqual(bare.oauthTokenSource, 'connector');
    assert.match(bare.oauthScope, /Mail\.Send\.Shared/);

    resetFx();
    const google = makeSession({
        microsoftConnectState: 'st', microsoftConnectVerifier: 'v',
        oauthProvider: 'google', accessToken: 'google-at',
    });
    await dispatch({ url: '/callback', session: google, query: { code: 'c', state: 'st' } });
    assert.strictEqual(google.oauthProvider, 'google', 'a live Google identity must survive');
    assert.strictEqual(google.accessToken, 'google-at');
    assert.strictEqual(fx.upserts.length, 1, 'the vault write still happens');
});

test('callback: a bad state is rejected and the one-shot pair is cleared', async () => {
    resetFx();
    const session = makeSession({ microsoftConnectState: 'st', microsoftConnectVerifier: 'v' });
    const res = await dispatch({ url: '/callback', session, query: { code: 'c', state: 'WRONG' } });

    assert.match(res.body, /Invalid state parameter/);
    assert.strictEqual(fx.upserts.length, 0);
    assert.strictEqual(session.microsoftConnectState, undefined);
    assert.strictEqual(session.microsoftConnectVerifier, undefined, 'a failed attempt must not leave a replayable pair');
});

test('callback: admin-consent failures say so instead of "try again"', async () => {
    // AADSTS65001 is not something the user can fix by retrying.
    resetFx();
    const denied = await dispatch({
        url: '/callback',
        session: makeSession({ microsoftConnectState: 'st' }),
        query: { error: 'consent_required', error_description: 'AADSTS65001: The user or administrator has not consented' },
    });
    assert.match(denied.body, /administrator must approve/i);

    resetFx();
    fx.tokenOk = false;
    fx.tokenErrorText = '{"error":"invalid_grant","error_description":"AADSTS65001: no consent"}';
    const exchanged = await dispatch({
        url: '/callback',
        session: makeSession({ microsoftConnectState: 'st', microsoftConnectVerifier: 'v' }),
        query: { code: 'c', state: 'st' },
    });
    assert.match(exchanged.body, /administrator must approve/i);
    assert.strictEqual(fx.upserts.length, 0);
});

test('callback: a grant without a refresh token is refused', async () => {
    // It would appear to work and then die silently within the hour.
    resetFx();
    fx.tokenResponse = { access_token: 'at_1', expires_in: 3600 };
    const res = await dispatch({
        url: '/callback',
        session: makeSession({ microsoftConnectState: 'st', microsoftConnectVerifier: 'v' }),
        query: { code: 'c', state: 'st' },
    });

    assert.match(res.body, /connection failed/i);
    assert.strictEqual(fx.upserts.length, 0);
});

// ═══ status ═════════════════════════════════════════════════════════

test('status: reports the shared-mailbox grant separately from being connected', async () => {
    resetFx();
    fx.cred = { status: 'active', scope: 'Mail.Read Mail.Send' };
    const narrow = await dispatch({ url: '/status', session: makeSession() });
    assert.strictEqual(narrow.body.connected, true);
    assert.strictEqual(narrow.body.sharedMailboxGranted, false,
        'an SSO-only grant can read /me but 403s on /users/{address}');

    fx.cred = { status: 'active', scope: 'Mail.Read Mail.Send Mail.Read.Shared Mail.Send.Shared' };
    const wide = await dispatch({ url: '/status', session: makeSession() });
    assert.strictEqual(wide.body.sharedMailboxGranted, true);
});

test('status: falls back to a live Microsoft SSO session with no vault row', async () => {
    resetFx();
    fx.cred = null;
    const res = await dispatch({
        url: '/status',
        session: makeSession({ oauthProvider: 'microsoft', accessToken: 'at', oauthScope: 'Mail.Read.Shared Mail.Send.Shared' }),
    });
    assert.strictEqual(res.body.connected, true);
    assert.strictEqual(res.body.sharedMailboxGranted, true);
});

test('status: needs_reauth is surfaced, and no email leaks when disconnected', async () => {
    resetFx();
    fx.cred = { status: 'needs_reauth' };
    const reauth = await dispatch({ url: '/status', session: makeSession() });
    assert.strictEqual(reauth.body.connected, false);
    assert.strictEqual(reauth.body.needsReauth, true);

    resetFx();
    fx.cred = null;
    const off = await dispatch({ url: '/status', session: makeSession() });
    assert.strictEqual(off.body.connected, false);
    assert.strictEqual(off.body.email, null);
});

// ═══ disconnect ═════════════════════════════════════════════════════

test('disconnect: clears the vault and the session, and admits it is local only', async () => {
    resetFx();
    const session = makeSession({ oauthProvider: 'microsoft', accessToken: 'at', refreshToken: 'rt', oauthScope: 's' });
    const res = await dispatch({ method: 'POST', url: '/disconnect', session });

    assert.strictEqual(res.body.success, true);
    assert.deepStrictEqual(fx.revokes, [{ userId: 'u1', provider: 'microsoft' }]);
    assert.strictEqual(session.oauthProvider, undefined);
    assert.strictEqual(session.accessToken, undefined);
    assert.strictEqual(session.oauthScope, undefined);
    // Microsoft has no revocation endpoint — claiming otherwise would be a lie
    // to the user about where their data stands.
    assert.strictEqual(res.body.providerRevokeSupported, false);
    assert.match(res.body.revokeHint, /myaccount\.microsoft\.com/);
});

test('disconnect: a Google SSO session keeps its own tokens', async () => {
    resetFx();
    const session = makeSession({ oauthProvider: 'google', accessToken: 'google-at' });
    await dispatch({ method: 'POST', url: '/disconnect', session });
    assert.strictEqual(session.oauthProvider, 'google');
    assert.strictEqual(session.accessToken, 'google-at');
});
