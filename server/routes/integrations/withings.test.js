/**
 * Withings connector route tests.
 *
 * Pins the connect flow and, more importantly, the two things that make
 * Withings different from every other connector here:
 *
 *   • the token exchange is action-dispatched (`action=requesttoken`) and its
 *     refusals arrive as HTTP 200 with a non-zero `status`;
 *   • Withings is NOT an identity — the callback must never hydrate the
 *     session's OAuth slot, or connecting a scale would silently re-brand the
 *     user's login provider.
 *
 * Deps are stubbed via the Module resolve hook; global.fetch is stubbed for the
 * token exchange.
 *
 * Run: cd server && node --test routes/integrations/withings.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// ── Mutable fixtures ─────────────────────────────────────────────────
const fx = {
    clientId: 'wid',
    clientSecret: 'wsecret',
    user: { id: 'u1', organizationId: 'orgA' },
    upserts: [],            // automationCredentialStore.upsertCredential spy
    cred: null,             // getCredential fixture
    configSets: [],         // configStore.setConfig spy
    configDeletes: [],      // configStore.deleteConfig spy
    revokes: [],            // revokeProviderCredential spy
    connections: [],        // upsertOAuthConnection spy
    tokenEnvelope: {
        status: 0,
        body: { userid: '99887', access_token: 'at_1', refresh_token: 'rt_1', expires_in: 10800, scope: 'user.metrics' },
    },
    tokenHttp: { ok: true, status: 200 },
    lastTokenBody: null,
};

const MOCKS = {
    '../../stores/configStore': {
        setConfig: async (k, v) => { fx.configSets.push({ k, v }); },
        getConfig: async (k) => (k.startsWith('withings_userid_user_') ? '99887' : null),
        deleteConfig: async (k) => { fx.configDeletes.push(k); },
    },
    '../../stores/automationCredentialStore': {
        upsertCredential: async (row) => { fx.upserts.push(row); },
        getCredential: async () => fx.cred,
    },
    '../../auth/automationAuth': {
        withingsClientConfig: async () => ({ clientId: fx.clientId, clientSecret: fx.clientSecret }),
        // The real unwrapper, condensed to what these routes rely on.
        readWithingsBody: (data, label) => {
            if (Number(data?.status) === 0 && data.body) return data.body;
            throw new Error(`Withings ${label} refused (status ${data?.status}): ${data?.error || ''}`);
        },
    },
    '../../auth/permissions': {
        OAUTH_PROVIDERS: {
            withings: {
                authUrl: 'https://account.withings.com/oauth2_user/authorize2',
                tokenUrl: 'https://wbsapi.withings.net/v2/oauth2',
                apiBase: 'https://wbsapi.withings.net',
                scopes: ['user.info', 'user.metrics', 'user.activity'],
                ssoLogin: false,
            },
        },
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
        revokeProviderCredential: async (userId, provider) => { fx.revokes.push({ userId, provider }); return { found: true, deleted: true }; },
    },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:withingsRoute:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /integrations[\\/]withings\.js$/.test(parent.filename) && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const realFetch = global.fetch;
global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('wbsapi.withings.net/v2/oauth2')) {
        fx.lastTokenBody = new URLSearchParams(opts.body);
        return {
            ok: fx.tokenHttp.ok,
            status: fx.tokenHttp.status,
            json: async () => fx.tokenEnvelope,
            text: async () => JSON.stringify(fx.tokenEnvelope),
        };
    }
    throw new Error(`unexpected fetch ${u}`);
};

const router = require('./withings');

test.after(() => {
    Module._resolveFilename = originalResolve;
    global.fetch = realFetch;
});

function resetFx() {
    fx.clientId = 'wid';
    fx.clientSecret = 'wsecret';
    fx.user = { id: 'u1', organizationId: 'orgA' };
    fx.upserts.length = 0;
    fx.cred = null;
    fx.configSets.length = 0;
    fx.configDeletes.length = 0;
    fx.revokes.length = 0;
    fx.connections.length = 0;
    fx.tokenHttp = { ok: true, status: 200 };
    fx.tokenEnvelope = {
        status: 0,
        body: { userid: '99887', access_token: 'at_1', refresh_token: 'rt_1', expires_in: 10800, scope: 'user.metrics' },
    };
    fx.lastTokenBody = null;
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

test('auth-url: state stashed in session, scopes comma-joined the way Withings wants', async () => {
    resetFx();
    const session = makeSession();
    const res = await dispatch({ url: '/auth-url', session });

    assert.strictEqual(res.statusCode, 200);
    const url = new URL(res.body.url);
    assert.strictEqual(url.origin + url.pathname, 'https://account.withings.com/oauth2_user/authorize2');
    assert.strictEqual(url.searchParams.get('response_type'), 'code');
    assert.strictEqual(url.searchParams.get('client_id'), 'wid');
    // Withings takes a COMMA-separated scope list, not the space-separated one
    // every other provider here uses.
    assert.strictEqual(url.searchParams.get('scope'), 'user.info,user.metrics,user.activity');
    assert.strictEqual(url.searchParams.get('redirect_uri'), 'https://app.example/api/integrations/withings/callback');
    assert.ok(url.searchParams.get('state'));
    assert.strictEqual(session.withingsConnectState, url.searchParams.get('state'));
    assert.strictEqual(session.withingsConnectRedirectUri, 'https://app.example/api/integrations/withings/callback');
});

test('auth-url: no PKCE challenge is sent (Withings rejects the exchange with one)', async () => {
    resetFx();
    const res = await dispatch({ url: '/auth-url', session: makeSession() });
    const url = new URL(res.body.url);
    assert.strictEqual(url.searchParams.get('code_challenge'), null);
});

test('auth-url: an unconfigured deployment answers 400 with an actionable code', async () => {
    resetFx();
    fx.clientId = '';
    const res = await dispatch({ url: '/auth-url', session: makeSession() });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'withings_not_configured');
});

test('auth-url: an anonymous caller is refused by requireAuth', async () => {
    resetFx();
    const res = await dispatch({ url: '/auth-url', session: { save() {} } });
    assert.strictEqual(res.statusCode, 401);
});

// ═══ callback ═══════════════════════════════════════════════════════

test('callback: exchanges with action=requesttoken and vaults both tokens', async () => {
    resetFx();
    const session = makeSession({ withingsConnectState: 'st', withingsConnectRedirectUri: 'https://app.example/cb' });
    const res = await dispatch({ url: '/callback', session, query: { code: 'auth-code', state: 'st' } });

    assert.strictEqual(res.statusCode, 200);
    assert.match(res.body, /Withings connected/);

    assert.strictEqual(fx.lastTokenBody.get('action'), 'requesttoken');
    assert.strictEqual(fx.lastTokenBody.get('grant_type'), 'authorization_code');
    assert.strictEqual(fx.lastTokenBody.get('code'), 'auth-code');
    // The redirect_uri must be the one the authorize request used, not one
    // rebuilt from this request's headers.
    assert.strictEqual(fx.lastTokenBody.get('redirect_uri'), 'https://app.example/cb');

    assert.strictEqual(fx.upserts.length, 1);
    assert.deepStrictEqual(
        { provider: fx.upserts[0].provider, accessToken: fx.upserts[0].accessToken, refreshToken: fx.upserts[0].refreshToken, orgId: fx.upserts[0].orgId },
        { provider: 'withings', accessToken: 'at_1', refreshToken: 'rt_1', orgId: 'orgA' },
    );
    assert.ok(fx.upserts[0].expiresAt > Date.now());
});

test('callback: the Withings account id is recorded for the status card', async () => {
    resetFx();
    const session = makeSession({ withingsConnectState: 'st' });
    await dispatch({ url: '/callback', session, query: { code: 'c', state: 'st' } });
    assert.deepStrictEqual(fx.configSets, [{ k: 'withings_userid_user_u1', v: '99887' }]);
    assert.strictEqual(fx.connections[0].label, 'Withings 99887');
    assert.strictEqual(fx.connections[0].provider, 'withings');
});

test('callback: NEVER hydrates the session OAuth slot — Withings is not an identity', async () => {
    resetFx();
    const session = makeSession({ withingsConnectState: 'st' });
    await dispatch({ url: '/callback', session, query: { code: 'c', state: 'st' } });
    assert.strictEqual(session.oauthProvider, undefined);
    assert.strictEqual(session.accessToken, undefined);
    assert.strictEqual(session.refreshToken, undefined);
});

test('callback: an org-less consumer gets a per-user vault scope', async () => {
    resetFx();
    fx.user = { id: 'u1', organizationId: null };
    const session = makeSession({ withingsConnectState: 'st' });
    await dispatch({ url: '/callback', session, query: { code: 'c', state: 'st' } });
    // A blank orgId would make upsertCredential skip the write and the
    // connection would last exactly one session.
    assert.strictEqual(fx.upserts[0].orgId, 'user:u1');
});

test('callback: a state mismatch refuses and stores nothing', async () => {
    resetFx();
    const session = makeSession({ withingsConnectState: 'expected' });
    const res = await dispatch({ url: '/callback', session, query: { code: 'c', state: 'attacker' } });
    assert.match(res.body, /Invalid state/);
    assert.strictEqual(fx.upserts.length, 0);
});

test('callback: the state is one-shot — cleared even on a failed attempt', async () => {
    resetFx();
    const session = makeSession({ withingsConnectState: 'expected', withingsConnectRedirectUri: 'https://app.example/cb' });
    await dispatch({ url: '/callback', session, query: { code: 'c', state: 'wrong' } });
    assert.strictEqual(session.withingsConnectState, undefined);
    assert.strictEqual(session.withingsConnectRedirectUri, undefined);
});

test('callback: a 200-with-non-zero-status refusal is treated as a FAILURE', async () => {
    resetFx();
    fx.tokenEnvelope = { status: 503, error: 'Invalid Params' };
    const session = makeSession({ withingsConnectState: 'st' });
    const res = await dispatch({ url: '/callback', session, query: { code: 'c', state: 'st' } });
    // Reading data.access_token off this payload would vault `undefined` and
    // report success; every later API call would then 401 with no explanation.
    assert.match(res.body, /connection failed/i);
    assert.strictEqual(fx.upserts.length, 0);
});

test('callback: a token response missing the refresh token is refused', async () => {
    resetFx();
    fx.tokenEnvelope = { status: 0, body: { access_token: 'at_1', expires_in: 10800 } };
    const session = makeSession({ withingsConnectState: 'st' });
    const res = await dispatch({ url: '/callback', session, query: { code: 'c', state: 'st' } });
    // Without a refresh token the connection dies in three hours and cannot
    // recover unattended — better to fail the connect than to look connected.
    assert.match(res.body, /connection failed/i);
    assert.strictEqual(fx.upserts.length, 0);
});

test('callback: a provider-side denial is reported, not exchanged', async () => {
    resetFx();
    const session = makeSession({ withingsConnectState: 'st' });
    const res = await dispatch({ url: '/callback', session, query: { error: 'access_denied', state: 'st' } });
    assert.match(res.body, /denied/i);
    assert.strictEqual(fx.lastTokenBody, null);
});

test('callback: an anonymous caller gets HTML, never a JSON 401 (it is a browser redirect)', async () => {
    resetFx();
    const res = await dispatch({ url: '/callback', session: { save() {} }, query: { code: 'c', state: 'st' } });
    assert.strictEqual(res.statusCode, 200);
    assert.match(res.body, /Not authenticated/);
});

// ═══ status ═════════════════════════════════════════════════════════

test('status: reports connected from an active vault row', async () => {
    resetFx();
    fx.cred = { status: 'active', scope: 'user.metrics' };
    const res = await dispatch({ url: '/status', session: makeSession() });
    assert.deepStrictEqual(res.body, {
        configured: true, connected: true, needsReauth: false, withingsUserId: '99887', scope: 'user.metrics',
    });
});

test('status: a needs_reauth credential is not "connected"', async () => {
    resetFx();
    fx.cred = { status: 'needs_reauth' };
    const res = await dispatch({ url: '/status', session: makeSession() });
    assert.strictEqual(res.body.connected, false);
    assert.strictEqual(res.body.needsReauth, true);
});

test('status: no credential at all reports neither connected nor needing reauth', async () => {
    resetFx();
    const res = await dispatch({ url: '/status', session: makeSession() });
    assert.strictEqual(res.body.connected, false);
    assert.strictEqual(res.body.needsReauth, false);
    assert.strictEqual(res.body.withingsUserId, null);
});

test('status: an unconfigured deployment says so instead of pretending it can connect', async () => {
    resetFx();
    fx.clientSecret = '';
    const res = await dispatch({ url: '/status', session: makeSession() });
    assert.strictEqual(res.body.configured, false);
});

// ═══ disconnect ═════════════════════════════════════════════════════

test('disconnect: routes through the shared revoke helper and clears the account id', async () => {
    resetFx();
    const res = await dispatch({ method: 'POST', url: '/disconnect', session: makeSession() });
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.hadCredential, true);
    assert.deepStrictEqual(fx.revokes, [{ userId: 'u1', provider: 'withings' }]);
    assert.deepStrictEqual(fx.configDeletes, ['withings_userid_user_u1']);
});

test('disconnect: an anonymous caller is refused', async () => {
    resetFx();
    const res = await dispatch({ method: 'POST', url: '/disconnect', session: { save() {} } });
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(fx.revokes.length, 0);
});
