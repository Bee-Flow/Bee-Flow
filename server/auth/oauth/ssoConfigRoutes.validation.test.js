/**
 * What the SSO provider configuration accepts, and what it says when it
 * refuses (auth/oauth/ssoConfigRoutes.js).
 *
 * `PUT /providers/:provider` branches on the provider and reads a DIFFERENT
 * set of keys in each branch, and nothing refused a key the branch did not
 * read — so the value was accepted, answered "<provider> configuration saved",
 * and dropped.
 *
 * On Microsoft that is not cosmetic. `tenantId` is what pins SSO to ONE
 * directory; without it the configuration keeps `common`, the multi-tenant
 * endpoint that accepts a sign-in from ANY Microsoft tenant. So a mis-typed
 * `tenantID` left the installation open to every directory in the world, on a
 * form where the administrator had just restricted it to their own and been
 * told it was saved. What this file pins:
 *
 *   - the 400 NAMES what is wrong, not just "invalid request";
 *   - a key that belongs to another provider is refused by name;
 *   - the config is never written, so a refused save changes nothing.
 *
 * Run: cd server && node --test --test-force-exit auth/oauth/ssoConfigRoutes.validation.test.js
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

const MOCKS = {
    '../permissions': {
        requireSuperAdmin: pass,
        loadConfig: async () => ({ oauth: { nextcloudUrl: 'https://nc.test', clientId: 'cid' }, providers: { microsoft: { tenantId: 'common' } } }),
        saveConfig: (cfg) => { touched.push({ what: 'saveConfig', args: [cfg] }); return true; },
        OAUTH_PROVIDERS: { google: {}, microsoft: {}, nextcloud: {} },
    },
    '../../telemetry/log': { info() {}, warn() {}, error() {}, debug() {} },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:sso-config-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /oauth[\\/]ssoConfigRoutes\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./ssoConfigRoutes');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ method, url, body = {}, session }) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search)) query[k] = v;
        const req = {
            method, url, originalUrl: url, path: pathname, body, query, headers: {},
            session: session || { user: { id: 'root' }, isAdmin: true }, get() { return undefined; },
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
    assert.ok(res.body.details ? res.body.details.some((d) => d.path === field) : true,
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the store');
}

test('a mis-typed Microsoft tenant is refused instead of leaving SSO on "common"', async () => {
    // `common` accepts a sign-in from ANY Microsoft directory. The whole point
    // of the field is to stop that.
    const res = await dispatch({
        method: 'PUT', url: '/providers/microsoft',
        body: { clientId: 'cid', tenantID: '11111111-1111-1111-1111-111111111111' },
    });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body'), 'the refusal names the body that carried the unknown key');
    assert.match(res.body.error, /tenantID/);
    assert.deepStrictEqual(touched, [], 'nothing may be saved when the tenant was not understood');
});

test('a Nextcloud-only field on the Google provider is refused by name', async () => {
    const res = await dispatch({
        method: 'PUT', url: '/providers/google',
        body: { clientId: 'cid', url: 'https://evil.test' },
    });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /google has no setting called url/);
    assert.deepStrictEqual(touched, []);
});

test('a key no provider has is refused before the branch is even chosen', async () => {
    await refuses({ method: 'PUT', url: '/providers/microsoft', body: { clientsecret: 'x' } }, 'body');
});

test('a real tenant id still reaches the configuration', async () => {
    const res = await dispatch({
        method: 'PUT', url: '/providers/microsoft',
        body: { clientId: 'cid', tenantId: ' 11111111-1111-1111-1111-111111111111 ' },
    });
    assert.strictEqual(res.statusCode, 200);
    const saved = touched.find((t) => t.what === 'saveConfig').args[0];
    assert.strictEqual(saved.providers.microsoft.tenantId, '11111111-1111-1111-1111-111111111111');
});

test('a misspelled key on the instance OAuth config is refused too', async () => {
    await refuses({ method: 'PUT', url: '/oauth-config', body: { clientSecrett: 'x' } }, 'body');
});
