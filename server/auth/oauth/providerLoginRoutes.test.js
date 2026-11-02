/**
 * GET /login/:provider starts a sign-in from THIS request's parameters
 * (auth/oauth/providerLoginRoutes.js).
 *
 * The popup, pickup and native-app flags were set when asked for and never
 * cleared at the start of the next attempt; the callback clears them only
 * after a successful popup login. An attempt abandoned in the embedded popup
 * or the Android Custom Tab therefore left them on the session, and the next
 * ordinary sign-in in that browser was answered as a popup: the close page
 * with no opener, or a 302 to the app's scheme, with a session token parked
 * under a pickup id nobody was waiting on any more.
 *
 * This route is navigated to, so it has no request schema (see its header);
 * what is pinned here is the session it leaves for the callback.
 *
 * Run: cd server && node --test auth/oauth/providerLoginRoutes.test.js
 */
'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const MOCKS = {
    '../../telemetry/log': { info() {}, warn() {}, error() {}, debug() {} },
    '../permissions': {
        loadConfig: async () => ({
            providers: {
                google: { clientId: 'client-1' },
                microsoft: {
                    clientId: 'ms-primary', clientSecret: 'ms-primary-secret', tenantId: 'common',
                    connections: [
                        { id: 'sub', label: 'Subsidiary', logo: '', clientId: 'ms-sub', clientSecret: 'ms-sub-secret', tenantId: '22222222-2222-2222-2222-222222222222' },
                        { id: 'draft', label: 'Draft', logo: '', clientId: 'ms-draft', tenantId: 'common' },
                    ],
                },
            },
            oauth: {},
        }),
        OAUTH_PROVIDERS: {
            google: { authUrl: 'https://accounts.example/auth', scopes: ['openid', 'email'] },
            microsoft: { authUrl: (tenantId) => `https://login.example/${tenantId}/authorize`, scopes: ['openid'] },
        },
    },
    './shared': {
        getReturnUrl: () => 'https://app.example',
        popupRedirect: (res, url) => { res.popupPage = true; res.send(url); },
        resolveNativeAppRedirect: (key) => (key === 'beeflow' ? 'beeflow://oauth' : null),
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:provider-login:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /oauth[\\/]providerLoginRoutes\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./providerLoginRoutes');
test.after(() => { Module._resolveFilename = originalResolve; });

/** One browser: the same session object across requests, as a cookie would. */
function newSession() {
    return { save(cb) { if (cb) cb(); } };
}

function navigate(url, session, headers = {}) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search)) query[k] = v;
        const req = {
            method: 'GET', url, originalUrl: url, path: pathname, query, headers: {}, session,
            sessionID: 'sid-1', protocol: 'https',
            get(name) {
                const key = String(name).toLowerCase();
                if (key === 'host') return 'bee.example';
                return Object.prototype.hasOwnProperty.call(headers, key) ? headers[key] : undefined;
            },
        };
        const res = {
            statusCode: 200, headersSent: false,
            setHeader() {},
            redirect(location) { this.statusCode = 302; this.location = location; resolve(this); },
            send(body) { this.body = body; resolve(this); return this; },
        };
        router(req, res, (err) => reject(err || new Error(`fell through: GET ${url}`)));
    });
}

test('an abandoned popup attempt does not turn the next ordinary sign-in into one', async () => {
    const session = newSession();
    // The Custom Tab (or embedded popup) is opened, and then closed without
    // finishing: the callback never runs, so nothing clears what it stashed.
    await navigate('/login/google?popup=1&pickup=abandoned-pickup&pickup_challenge=Q2hhbGxlbmdlLWNoYWxsZW5nZS1jaGFsbGVuZ2UtY2hhbGw&app=beeflow', session);

    // Later, in the same browser, a plain sign-in.
    const res = await navigate('/login/google', session);
    assert.strictEqual(session.oauthPopup, undefined, 'not a popup: the callback must redirect, not render the close page');
    assert.strictEqual(session.oauthPickupId, undefined, 'no session token may be deposited under the old pickup id');
    assert.strictEqual(session.oauthAppRedirect, undefined, 'the callback must not 302 a web sign-in to beeflow://');
    assert.strictEqual(res.statusCode, 302);
    assert.ok(res.location.startsWith('https://accounts.example/auth?'), 'a plain redirect to the provider');
    assert.ok(!res.popupPage);
});

test('a popup attempt still records its own mode, pickup and app handoff', async () => {
    const session = newSession();
    const res = await navigate('/login/google?popup=1&pickup=p-123&pickup_challenge=Q2hhbGxlbmdlLWNoYWxsZW5nZS1jaGFsbGVuZ2UtY2hhbGw&app=beeflow', session);
    assert.strictEqual(session.oauthPopup, true);
    assert.strictEqual(session.oauthPickupId, 'p-123');
    assert.strictEqual(session.oauthAppRedirect, 'beeflow://oauth');
    assert.ok(res.popupPage, 'the popup gets the referrer-cleaning intermediate page');
});

test('a second popup attempt replaces the first one\'s pickup rather than keeping it', async () => {
    const session = newSession();
    await navigate('/login/google?popup=1&pickup=first&pickup_challenge=Q2hhbGxlbmdlLWNoYWxsZW5nZS1jaGFsbGVuZ2UtY2hhbGw&app=beeflow', session);
    await navigate('/login/google?popup=1&pickup=second&pickup_challenge=Q2hhbGxlbmdlLWNoYWxsZW5nZS1jaGFsbGVuZ2UtY2hhbGw', session);
    assert.strictEqual(session.oauthPickupId, 'second');
    assert.strictEqual(session.oauthAppRedirect, undefined, 'this attempt named no app');
});

test('a Microsoft sign-in without ?connection= uses the primary app, as before connections existed', async () => {
    const session = newSession();
    const res = await navigate('/login/microsoft', session);
    const url = new URL(res.location);
    assert.strictEqual(url.pathname, '/common/authorize');
    assert.strictEqual(url.searchParams.get('client_id'), 'ms-primary');
    assert.strictEqual(session.oauthConnectionId, undefined, 'the callback exchanges with the primary credentials');
});

test('a Microsoft sign-in through an additional tenant uses that connection\'s app and tenant, and remembers it', async () => {
    const session = newSession();
    const res = await navigate('/login/microsoft?connection=sub', session);
    const url = new URL(res.location);
    assert.strictEqual(url.pathname, '/22222222-2222-2222-2222-222222222222/authorize');
    assert.strictEqual(url.searchParams.get('client_id'), 'ms-sub');
    assert.strictEqual(session.oauthConnectionId, 'sub');

    // The next attempt from the same browser starts from no connection.
    const plain = await navigate('/login/microsoft', session);
    assert.strictEqual(new URL(plain.location).searchParams.get('client_id'), 'ms-primary');
    assert.strictEqual(session.oauthConnectionId, undefined);
});

test('an unknown or half-configured connection is refused, never silently the primary', async () => {
    for (const id of ['nope', 'draft', 'default-ish']) {
        const session = newSession();
        const res = await navigate(`/login/microsoft?connection=${id}`, session);
        assert.strictEqual(res.location, 'https://app.example?error=microsoft_not_configured', id);
        assert.strictEqual(session.oauthConnectionId, undefined, id);
    }
});

test('a popup attempt records the pickup challenge next to the id, for the callback to file with the deposit', async () => {
    const session = newSession();
    const challenge = 'Q2hhbGxlbmdlLWNoYWxsZW5nZS1jaGFsbGVuZ2UtY2hhbGw';
    await navigate(`/login/google?popup=1&pickup=p-123&pickup_challenge=${challenge}`, session);
    assert.strictEqual(session.oauthPickupId, 'p-123');
    assert.strictEqual(session.oauthPickupChallenge, challenge);
});

test('a missing or malformed challenge sets up no pickup at all', async () => {
    for (const q of ['', '&pickup_challenge=short', '&pickup_challenge=not%20base64url', `&pickup_challenge=${'x'.repeat(129)}`]) {
        const session = newSession();
        await navigate(`/login/google?popup=1&pickup=p-123${q}`, session);
        assert.strictEqual(session.oauthPopup, true, q);
        assert.strictEqual(session.oauthPickupId, undefined, q);
        assert.strictEqual(session.oauthPickupChallenge, undefined, q);
    }
});

test('the next attempt starts from no pickup, like the other handoff keys', async () => {
    const session = newSession();
    await navigate('/login/google?popup=1&pickup=first&pickup_challenge=Q2hhbGxlbmdlLWNoYWxsZW5nZS1jaGFsbGVuZ2UtY2hhbGw', session);
    await navigate('/login/google?popup=1&pickup=second', session);
    assert.strictEqual(session.oauthPickupId, undefined, 'this attempt sent no challenge');
    assert.strictEqual(session.oauthPickupChallenge, undefined);
});

// ── Where the provider sends the browser back ──────────────────────────
// Without SERVER_PUBLIC_HOST the redirect_uri is built from the request. The
// Referer is a fine guess on a developer's machine and, in production, a
// target the sender chose.
const redirectUriOf = (res) => new URL(res.location).searchParams.get('redirect_uri');

test('outside production the Referer still decides the redirect_uri when no public host is configured', async () => {
    delete process.env.SERVER_PUBLIC_HOST;
    const res = await navigate('/login/google', newSession(), { referer: 'http://localhost:5276/login' });
    assert.strictEqual(redirectUriOf(res), 'http://localhost:5276/auth/callback/google');
});

test('in production the Referer is ignored: the redirect_uri is this server\'s own host', async () => {
    delete process.env.SERVER_PUBLIC_HOST;
    process.env.NODE_ENV = 'production';
    try {
        const res = await navigate('/login/google', newSession(), { referer: 'https://attacker.example/x' });
        assert.strictEqual(redirectUriOf(res), 'https://bee.example/auth/callback/google');
    } finally { process.env.NODE_ENV = 'test'; }
});

test('in production X-Forwarded-Host is ignored as well: the redirect_uri is this server\'s own host', async () => {
    delete process.env.SERVER_PUBLIC_HOST;
    process.env.NODE_ENV = 'production';
    try {
        const res = await navigate('/login/google', newSession(), { 'x-forwarded-host': 'attacker.example' });
        assert.strictEqual(redirectUriOf(res), 'https://bee.example/auth/callback/google');
    } finally { process.env.NODE_ENV = 'test'; }
});

test('a configured public host wins everywhere', async () => {
    process.env.SERVER_PUBLIC_HOST = 'hub.example';
    try {
        const res = await navigate('/login/google', newSession(), { referer: 'https://attacker.example/x' });
        assert.strictEqual(redirectUriOf(res), 'https://hub.example/auth/callback/google');
    } finally { delete process.env.SERVER_PUBLIC_HOST; }
});

// ── ?intent=link: the signed-in account links a provider ─────────────────
const signedIn = (extra = {}) => ({ ...newSession(), isAuthenticated: true, user: { id: 'alice' }, authenticatedAt: Date.now(), ...extra });

test('a link start remembers the signed-in account and goes to the provider without popup or pickup', async () => {
    const session = signedIn();
    const res = await navigate('/login/google?intent=link&popup=1&pickup=p-1&pickup_challenge=Q2hhbGxlbmdlLWNoYWxsZW5nZS1jaGFsbGVuZ2UtY2hhbGw&app=beeflow', session);
    assert.strictEqual(session.oauthLinkUserId, 'alice');
    assert.strictEqual(session.oauthPopup, undefined);
    assert.strictEqual(session.oauthPickupId, undefined);
    assert.strictEqual(session.oauthAppRedirect, undefined);
    assert.ok(res.location.startsWith('https://accounts.example/auth?'));
    assert.strictEqual(session.returnTo, 'https://app.example/app/settings/security',
        'the callback of a link returns to the settings page that holds the link action');
});

test('a link start needs a signed-in session with a recent sign-in', async () => {
    let res = await navigate('/login/google?intent=link', newSession());
    assert.strictEqual(res.location, 'https://app.example/app/settings/security?error=reauth_required');
    const stale = signedIn({ authenticatedAt: Date.now() - 60 * 60 * 1000 });
    res = await navigate('/login/google?intent=link', stale);
    assert.strictEqual(res.location, 'https://app.example/app/settings/security?error=reauth_required');
    assert.strictEqual(stale.oauthLinkUserId, undefined);
});

test('Microsoft is not linked this way, and an ordinary sign-in clears a pending link', async () => {
    const session = signedIn();
    const res = await navigate('/login/microsoft?intent=link', session);
    assert.strictEqual(res.location, 'https://app.example/app/settings/security?error=sso_link_unsupported');
    await navigate('/login/google?intent=link', session);
    assert.strictEqual(session.oauthLinkUserId, 'alice');
    await navigate('/login/google', session);
    assert.strictEqual(session.oauthLinkUserId, undefined);
    assert.strictEqual(session.returnTo, 'https://app.example', 'an ordinary sign-in returns to the site root');
});
