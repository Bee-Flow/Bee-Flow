/**
 * What the SSO encryption-PIN routes accept, and what they say when they
 * refuse (auth/login/ssoEncryptionRoutes.js).
 *
 * The minimum-length gate was `!pin || pin.length < 6`, and `.length` is
 * `undefined` on anything that is not a string or an array — so the JSON TYPE
 * was enough to step over it. `pin: 5` passed both this check and
 * validateEncryptionPin() and died inside Argon2 as a 500 on the user's own
 * key setup; `pin: ["a","b","c","d","e","f"]` passed everything, and Buffer
 * coercion turns every non-numeric element into a zero byte, so two different
 * six-element arrays derive the SAME key. What this file pins:
 *
 *   - the 400 NAMES the field (`body.pin`), not just "invalid request";
 *   - the message is a sentence;
 *   - a PIN is never trimmed — the bytes the user typed are the bytes that
 *     have to unwrap the key tomorrow;
 *   - encryption is never reached, so a refused request re-wraps nothing.
 *
 * Run: cd server && node --test --test-force-exit auth/login/ssoEncryptionRoutes.validation.test.js
 */
'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store and side-effect call lands in `touched`. A refused request must
// leave it empty.
const touched = [];

const MOCKS = {
    '../encryption': {
        setupSSOUserDEK: async (userId, p) => { touched.push({ what: 'setupSSOUserDEK', args: [userId, p] }); return { dek: Buffer.alloc(32), recoveryKey: 'RK' }; },
        unlockSSOUserDEK: async (userId, p) => { touched.push({ what: 'unlockSSOUserDEK', args: [userId, p] }); return { dek: Buffer.alloc(32) }; },
        unlockWithRecoveryKey: async (userId, k) => { touched.push({ what: 'unlockWithRecoveryKey', args: [userId, k] }); return Buffer.alloc(32); },
        secureClear() {},
    },
    '../../telemetry/log': { info() {}, warn() {}, error() {}, debug() {} },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:sso-encryption-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /login[\\/]ssoEncryptionRoutes\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./ssoEncryptionRoutes');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ method, url, body = {}, session }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, query: {}, headers: {},
            session: session || { isAuthenticated: true, user: { id: 'u1' }, save(cb) { cb(); } }, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            set() { return this; }, setHeader() {}, cookie() { return this; },
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
    assert.strictEqual(res.body.code, 'invalid_request', what);
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the store');
}

test('a numeric PIN no longer steps over the six-character minimum', async () => {
    // `(5).length` is undefined and `undefined < 6` is false, so this used to
    // reach Argon2 and surface as a 500 on the user's own key setup.
    await refuses({ method: 'POST', url: '/sso-encryption-setup', body: { pin: 5 } }, 'body.pin');
});

test('an array PIN is refused instead of collapsing to six zero bytes', async () => {
    await refuses({ method: 'POST', url: '/sso-encryption-setup', body: { pin: ['a', 'b', 'c', 'd', 'e', 'f'] } }, 'body.pin');
});

test('a short PIN is refused in words, not with "Required"', async () => {
    const res = await dispatch({ method: 'POST', url: '/sso-encryption-setup', body: { pin: '12345' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Encryption PIN must be at least 6 characters');
    assert.deepStrictEqual(touched, []);
});

test('a PIN reaches key derivation exactly as it was typed', async () => {
    const res = await dispatch({ method: 'POST', url: '/sso-encryption-setup', body: { pin: ' 123456 ' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'setupSSOUserDEK').args[1], ' 123456 ');
});

test('unlock still accepts a PIN shorter than the minimum set today', async () => {
    // An account set up before the rule holds one; refusing it here would lock
    // its owner out of the very screen that lets them change it.
    const res = await dispatch({ method: 'POST', url: '/sso-encryption-unlock', body: { pin: '1234' } });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(touched.some((t) => t.what === 'unlockSSOUserDEK'));
});

test('a PIN change with a weak new PIN is refused by name', async () => {
    await refuses({ method: 'POST', url: '/sso-change-pin', body: { oldPin: 'old-one', newPin: 'abc' } }, 'body.newPin');
});

test('a recovery with a misspelled key is refused rather than read as absent', async () => {
    await refuses({ method: 'POST', url: '/sso-recovery', body: { recoveryKey: 'RK', newPINN: 'abcdef' } }, 'body');
});
