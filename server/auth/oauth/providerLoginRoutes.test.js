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
        loadConfig: async () => ({ providers: { google: { clientId: 'client-1' } }, oauth: {} }),
        OAUTH_PROVIDERS: { google: { authUrl: 'https://accounts.example/auth', scopes: ['openid', 'email'] } },
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

function navigate(url, session) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search)) query[k] = v;
        const req = {
            method: 'GET', url, originalUrl: url, path: pathname, query, headers: {}, session,
            sessionID: 'sid-1', protocol: 'https',
            get(name) { return String(name).toLowerCase() === 'host' ? 'bee.example' : undefined; },
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
    await navigate('/login/google?popup=1&pickup=abandoned-pickup&app=beeflow', session);

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
    const res = await navigate('/login/google?popup=1&pickup=p-123&app=beeflow', session);
    assert.strictEqual(session.oauthPopup, true);
    assert.strictEqual(session.oauthPickupId, 'p-123');
    assert.strictEqual(session.oauthAppRedirect, 'beeflow://oauth');
    assert.ok(res.popupPage, 'the popup gets the referrer-cleaning intermediate page');
});

test('a second popup attempt replaces the first one\'s pickup rather than keeping it', async () => {
    const session = newSession();
    await navigate('/login/google?popup=1&pickup=first&app=beeflow', session);
    await navigate('/login/google?popup=1&pickup=second', session);
    assert.strictEqual(session.oauthPickupId, 'second');
    assert.strictEqual(session.oauthAppRedirect, undefined, 'this attempt named no app');
});
