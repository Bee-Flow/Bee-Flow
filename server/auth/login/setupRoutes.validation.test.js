/**
 * What the one-shot /setup accepts, and what it says when it refuses
 * (auth/login/setupRoutes.js).
 *
 * This mints the operator account — the first credential on the installation.
 * `password` was read straight off the body and handed to the policy check and
 * then to three regexes, none of which means anything for a number or an
 * array. What this file pins:
 *
 *   - the 400 NAMES the field (`body.password`), not just "invalid request";
 *   - the message is a sentence, including for a field simply left out;
 *   - nothing is written, so a refused setup leaves the installation unclaimed.
 *
 * Run: cd server && node --test --test-force-exit auth/login/setupRoutes.validation.test.js
 */
'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store and side-effect call lands in `touched`. A refused request must
// leave it empty.
const touched = [];
const hit = (what) => (...args) => { touched.push({ what, args }); };

const MOCKS = {
    '../permissions': {
        loadConfig: async () => ({ admin: { username: 'admin', passwordHash: null }, oauth: {}, providers: {} }),
        saveConfig: (cfg) => { touched.push({ what: 'saveConfig', args: [cfg] }); return true; },
    },
    '../passwordPolicy': { MIN_PASSWORD_LENGTH: 12, validatePasswordAsync: async () => ({ ok: true }) },
    '../signupCaptcha': { publicConfig: () => ({ enabled: false }), announce() {} },
    '../encryption': { createUserDEK: async () => ({ dek: Buffer.alloc(32), recoveryKey: 'RK' }), secureClear() {} },
    '../../stores/userStore': {
        getUser: async () => null,
        createUser: hit('createUser'),
        updateUser: hit('updateUser'),
        getAllOrganizations: async () => [],
    },
    '../../stores/configStore': { getConfig: async () => null },
    '../../stores/languageStore': { getAvailableLocales: async () => [] },
    '../../telemetry/log': { info() {}, warn() {}, error() {}, debug() {} },
    'bcryptjs': { hash: async () => 'hash' },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:setup-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /login[\\/]setupRoutes\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./setupRoutes');
test.after(() => { Module._resolveFilename = originalResolve; });

const { dispatcher } = require('../../core/http/routeHarness');

const dispatch = dispatcher(router, { session: () => ({ user: null }) });

test.beforeEach(() => { touched.length = 0; });

/** Assert: refused with 400, the named field is in `details`, nothing touched. */
async function refuses(request, field) {
    const res = await dispatch(request);
    const what = `${request.method} ${request.url} ${JSON.stringify(request.body)}`;
    assert.strictEqual(res.statusCode, 400, what);
    assert.strictEqual(res.body.code, 'invalid_request', what);
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the store');
}

test('a setup with no password is refused in words, not with "Required"', async () => {
    const res = await dispatch({ method: 'POST', url: '/setup', body: {} });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Choose a password for the operator account.');
    assert.ok(res.body.details.some((d) => d.path === 'body.password'));
    assert.deepStrictEqual(touched, []);
});

test('a numeric password is refused by name instead of reaching three regexes', async () => {
    await refuses({ method: 'POST', url: '/setup', body: { password: 12345678 } }, 'body.password');
});

test('a misspelled key is refused rather than read as a missing password', async () => {
    await refuses({ method: 'POST', url: '/setup', body: { passwrod: 'Password1' } }, 'body');
});

test('a well-formed password still claims the installation', async () => {
    const res = await dispatch({ method: 'POST', url: '/setup', body: { password: 'Password1' } });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(touched.some((t) => t.what === 'saveConfig'));
});
