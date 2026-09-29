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
        nextcloudFetch: async () => ({ ok: false, status: 500 }),
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

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ method, url, body = {}, session }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, query: {}, headers: {},
            session: session || { user: { id: 'u1' }, oauthProvider: 'nextcloud', accessToken: 'tok' }, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            set() { return this; }, setHeader() {},
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: ${method} ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

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
