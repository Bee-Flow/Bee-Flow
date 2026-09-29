/**
 * GET /login on the legacy Nextcloud flow starts a sign-in from THIS request
 * (auth/oauth/nextcloudLegacyRoutes.js).
 *
 * Two things it did that its modern sibling, /login/:provider, no longer does:
 *
 *   - The popup and pickup flags were set when asked for and never cleared.
 *     The callback clears them only after a successful popup sign-in, so an
 *     attempt abandoned in the embedded popup left them on the session and the
 *     next ordinary sign-in in that browser was answered as a popup, with a
 *     live session token parked under a pickup id nobody waited on any more.
 *   - The return address came from the Referer alone, so a link from any site
 *     to /auth/login sent the person back to that site after signing in, even
 *     on an install that names its own client host.
 *
 * This route is navigated to, so it has no request schema (see its header);
 * what is pinned here is the session it leaves for the callback.
 *
 * Run: cd server && node --test auth/oauth/nextcloudLegacyRoutes.test.js
 */
'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const CONFIGURED = { oauth: { nextcloudUrl: 'https://cloud.example', clientId: 'client-1' } };
let config = CONFIGURED;

// The real shared.js is used, so getReturnUrl and popupRedirect are the ones
// production runs; only what they and the route reach into is replaced.
const MOCKS = {
    '../../telemetry/log': quiet,
    '../permissions': {
        loadConfig: async () => config,
    },
    '../encryption': { getOrCreateSSOUserDEKCompat: async () => ({}) },
    '../establishSession': { establishSession: async () => {} },
    '../accountStatusGate': { isLoginBlockedAccount: () => false, REFUSAL: { status: 403, body: {} } },
    '../../stores/userStore': { getUser: async () => null, getAppPassword: async () => null },
    '../../stores/encryptionAvailability': { isEncryptionEnabledForUser: async () => false },
    '../../stores/routineCredentialStore': { upsertCredential: async () => {} },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:nextcloud-legacy-login:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /oauth[\\/](nextcloudLegacyRoutes|shared)\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./nextcloudLegacyRoutes');
const savedClientHost = process.env.CLIENT_PUBLIC_HOST;
const savedClientProtocol = process.env.CLIENT_PROTOCOL;
test.after(() => {
    Module._resolveFilename = originalResolve;
    if (savedClientHost === undefined) delete process.env.CLIENT_PUBLIC_HOST;
    else process.env.CLIENT_PUBLIC_HOST = savedClientHost;
    if (savedClientProtocol === undefined) delete process.env.CLIENT_PROTOCOL;
    else process.env.CLIENT_PROTOCOL = savedClientProtocol;
});
test.beforeEach(() => {
    config = CONFIGURED;
    delete process.env.CLIENT_PUBLIC_HOST;
    delete process.env.CLIENT_PROTOCOL;
});

/** One browser: the same session object across requests, as a cookie would. */
function newSession() {
    return { save(cb) { if (cb) cb(); } };
}

function navigate(url, session, { referer } = {}) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search)) query[k] = v;
        const headers = { host: 'bee.example', ...(referer ? { referer } : {}) };
        const req = {
            method: 'GET', url, originalUrl: url, path: pathname, query, headers, session,
            protocol: 'https',
            get(name) { return headers[String(name).toLowerCase()]; },
        };
        const res = {
            statusCode: 200,
            setHeader() {},
            redirect(location) { this.statusCode = 302; this.location = location; resolve(this); },
            send(body) { this.body = body; resolve(this); return this; },
        };
        router(req, res, (err) => reject(err || new Error(`fell through: GET ${url}`)));
    });
}

test('an abandoned popup attempt does not turn the next ordinary sign-in into one', async () => {
    const session = newSession();
    // Opened in the embedded popup, then closed without finishing: the
    // callback never runs, so nothing clears what /login stashed.
    await navigate('/login?popup=1&pickup=abandoned-pickup', session);
    session.oauthAppRedirect = 'beeflow://oauth'; // and one left by a Custom Tab attempt

    const res = await navigate('/login', session);
    assert.strictEqual(session.oauthPopup, undefined, 'not a popup: the callback must redirect, not render the close page');
    assert.strictEqual(session.oauthPickupId, undefined, 'no session token may be deposited under the old pickup id');
    assert.strictEqual(session.oauthAppRedirect, undefined);
    assert.strictEqual(res.statusCode, 302, 'a plain redirect, not the intermediate popup page');
    assert.ok(res.location.startsWith('https://cloud.example/apps/oauth2/authorize?'));
});

test('a popup attempt still records its own mode and pickup', async () => {
    const session = newSession();
    const res = await navigate('/login?popup=1&pickup=p-123', session);
    assert.strictEqual(session.oauthPopup, true);
    assert.strictEqual(session.oauthPickupId, 'p-123');
    assert.strictEqual(res.statusCode, 200, 'the popup gets the referrer-cleaning intermediate page');
    assert.match(res.body, /cloud\.example\/apps\/oauth2\/authorize/);
});

test('a configured client host is where the person returns, not the site that linked here', async () => {
    process.env.CLIENT_PUBLIC_HOST = 'app.bee.example';
    const session = newSession();
    await navigate('/login', session, { referer: 'https://evil.example/landing' });
    assert.strictEqual(session.returnTo, 'https://app.bee.example');
});

test('the not-configured answer goes to the configured host too', async () => {
    process.env.CLIENT_PUBLIC_HOST = 'app.bee.example';
    config = { oauth: {} };
    const res = await navigate('/login', newSession(), { referer: 'https://evil.example/landing' });
    assert.strictEqual(res.location, 'https://app.bee.example?error=oauth_not_configured');
});

test('without a configured client host the Referer still decides, as before', async () => {
    const session = newSession();
    await navigate('/login', session, { referer: 'https://nc.customer.example/apps/beeflow' });
    assert.strictEqual(session.returnTo, 'https://nc.customer.example');
});
