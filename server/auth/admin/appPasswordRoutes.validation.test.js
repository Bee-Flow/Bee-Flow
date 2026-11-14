/**
 * What /save-app-password accepts, and what it says when it refuses
 * (auth/admin/appPasswordRoutes.js).
 *
 * `url` is optional — blank means "resolve against the org-wide Nextcloud" —
 * but the KEY was open, so a mis-spelled `url` was answered 200 with the app
 * password filed against the ORGANISATION's Nextcloud instead of the host the
 * person named, and nothing on screen said so. What this file pins:
 *
 *   - the 400 NAMES the field (`body.password`), not just "invalid request";
 *   - the message is a sentence, including for a field simply left out;
 *   - the store is never reached, so a refused save keeps no credential.
 *
 * Run: cd server && node --test --test-force-exit auth/admin/appPasswordRoutes.validation.test.js
 */
'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store and side-effect call lands in `touched`. A refused request must
// leave it empty.
const touched = [];
const pass = (req, res, next) => next();
const hit = (what) => (...args) => { touched.push({ what, args }); };

// When set, Nextcloud's getapppassword answers with this app password.
let mintedAppPassword = null;

const MOCKS = {
    '../permissions': { requireAuth: pass, loadConfig: async () => ({ oauth: { nextcloudUrl: 'https://nc.example.test' } }) },
    '../../stores/userStore': {
        getAppPassword: async () => null,
        storeAppPassword: (userId, username, password, url) => { touched.push({ what: 'storeAppPassword', args: [userId, username, url] }); return true; },
        deleteAppPassword: hit('deleteAppPassword'),
    },
    '../../integrations/nextcloudTarget': {
        MAX_URL_LENGTH: 2048,
        assertAllowedNextcloudHost: () => {},
        nextcloudFetch: async () => (mintedAppPassword
            ? { ok: true, status: 200, json: async () => ({ ocs: { data: { apppassword: mintedAppPassword } } }) }
            : { ok: false, status: 500 }),
    },
    '../../telemetry/log': { info() {}, warn() {}, error() {}, debug() {} },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:app-password-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /admin[\\/]appPasswordRoutes\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./appPasswordRoutes');
test.after(() => { Module._resolveFilename = originalResolve; });

const { dispatcher } = require('../../testUtils/routeHarness');

const dispatch = dispatcher(router, { session: () => ({ user: { id: 'u1' }, oauthProvider: 'nextcloud', accessToken: 'tok' }) });

test.beforeEach(() => { touched.length = 0; });

/** Assert: refused with 400, the named field is in `details`, nothing touched. */
async function refuses(request, field) {
    const res = await dispatch(request);
    const what = `${request.method} ${request.url} ${JSON.stringify(request.body)}`;
    assert.strictEqual(res.statusCode, 400, what);
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the store');
}

test('a save with no password is refused in words, not with "Required"', async () => {
    const res = await dispatch({ method: 'POST', url: '/save-app-password', body: { username: 'bob' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Username and password are required');
    assert.ok(res.body.details.some((d) => d.path === 'body.password'));
    assert.deepStrictEqual(touched, []);
});

test('a misspelled url is refused instead of silently using the org host', async () => {
    await refuses({
        method: 'POST', url: '/save-app-password',
        body: { username: 'bob', password: 'app-pw', urls: 'https://mine.example.test' },
    }, 'body');
});

test('a named host still reaches the store, trimmed once by the schema', async () => {
    const res = await dispatch({
        method: 'POST', url: '/save-app-password',
        body: { username: 'bob', password: 'app-pw', url: ' https://mine.example.test ' },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'storeAppPassword').args[2], 'https://mine.example.test');
});

// ── /create-app-password files the password under the Nextcloud uid ──────────
//
// The stored username is what WebDAV paths and Basic auth are built from
// (/remote.php/dav/files/<uid>/). The route used `session.user.id`, which after
// an OAuth sign-in is the Bee Flow account id (or the `nextcloud-<uid>` SSO id),
// never the raw uid, so every later file call went to a user that does not
// exist. The raw uid is kept on the session as `nextcloudUid`.

/** POST /create-app-password with `session`; returns what reached the store. */
async function createWith(session) {
    mintedAppPassword = 'app-pw';
    try {
        const res = await dispatcher(router, { session: () => session })({ method: 'POST', url: '/create-app-password', body: {} });
        assert.strictEqual(res.statusCode, 200);
        return touched.filter((t) => t.what === 'storeAppPassword').map((t) => t.args.slice(0, 2));
    } finally {
        mintedAppPassword = null;
    }
}

test('the minted app password is stored under the raw Nextcloud uid, not the Bee Flow account id', async () => {
    const stored = await createWith({ user: { id: 'nextcloud-alice', 'display-name': 'Alice A.' }, nextcloudUid: 'alice', oauthProvider: 'nextcloud', accessToken: 'tok' });
    assert.deepStrictEqual(stored, [['nextcloud-alice', 'alice']]);
});

test('a session from before the uid was kept still falls back to the account id', async () => {
    const stored = await createWith({ user: { id: 'alice' }, oauthProvider: 'nextcloud', accessToken: 'tok' });
    assert.deepStrictEqual(stored, [['alice', 'alice']]);
});

test('creating an app password takes no fields: one sent is refused by name and nothing is minted', async () => {
    const res = await dispatch({ method: 'POST', url: '/create-app-password', body: { password: 'mine' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.match(res.body.error, /does not take "password"/);
    assert.deepStrictEqual(touched, []);
});
