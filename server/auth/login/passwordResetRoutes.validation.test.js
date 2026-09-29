/**
 * What the self-service reset routes accept, and what they say when they
 * refuse (auth/login/passwordResetRoutes.js).
 *
 * `/forgot-password` answered `{success:true}` to a body that named no address
 * at all — so a client that mis-spelled `email` was told the mail was on its
 * way while nothing had been asked to send one, and the person waited on an
 * inbox that was never going to fill. What this file pins:
 *
 *   - the 400 NAMES the field (`body.email`), not just "invalid request";
 *   - the message is a sentence, including for a field simply left out;
 *   - the CONSTANT-200 contract survives: a well-formed request for an address
 *     that has no account still answers exactly like one that does;
 *   - the store is never reached, so a refused request changes nothing.
 *
 * Run: cd server && node --test --test-force-exit auth/login/passwordResetRoutes.validation.test.js
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
    '../../stores/userStore': {
        getUserByEmail: async (e) => { touched.push({ what: 'getUserByEmail', args: [e] }); return null; },
        getUserByPasswordResetToken: async (h) => { touched.push({ what: 'getUserByPasswordResetToken', args: [h] }); return null; },
        updateUser: hit('updateUser'),
    },
    '../passwordPolicy': { validatePasswordAsync: async () => ({ ok: true }) },
    '../loginThrottle': {
        recordFanOut: async () => ({ delayMs: 0 }),
        sleep: async () => {},
        clearIdentifier: async () => {},
    },
    '../authRateLimits': {
        forgotPasswordIpLimiter: pass, resetPasswordIpLimiter: pass, forgotPasswordTargetLimiter: pass,
    },
    '../../utils/emailService': { sendPasswordResetEmail: async () => { touched.push({ what: 'sendPasswordResetEmail', args: [] }); } },
    '../../utils/appPaths': { clientHost: () => 'https://example.test', legacyLoginPath: (q) => `/login?${q}` },
    '../../telemetry/log': { info() {}, warn() {}, error() {}, debug() {} },
    'bcryptjs': { hash: async () => 'hash' },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:password-reset-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /login[\\/]passwordResetRoutes\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./passwordResetRoutes');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ method, url, body = {}, session }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, query: {}, headers: {},
            session: session || { user: null }, get() { return undefined; },
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

test('a reset request naming no address is refused in words, not answered "success"', async () => {
    const res = await dispatch({ method: 'POST', url: '/forgot-password', body: {} });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Enter the e-mail address of the account you want to reset.');
    assert.ok(res.body.details.some((d) => d.path === 'body.email'));
    assert.deepStrictEqual(touched, []);
});

test('a misspelled key is refused rather than promising a mail nothing will send', async () => {
    await refuses({ method: 'POST', url: '/forgot-password', body: { emial: 'a@b.test' } }, 'body');
});

test('an address with no account still gets the same answer as one that has', async () => {
    // The constant-200 contract is the anti-enumeration control; only a
    // request that names NO address at all is refused.
    const res = await dispatch({ method: 'POST', url: '/forgot-password', body: { email: '  nobody@b.test ' } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { success: true });
    // Trimmed once, by the schema, on its way to the lookup.
    assert.strictEqual(touched.find((t) => t.what === 'getUserByEmail').args[0], 'nobody@b.test');
});

test('a reset with no new password is refused by name', async () => {
    await refuses({ method: 'POST', url: '/reset-password', body: { token: 'tok' } }, 'body.newPassword');
});

test('a misspelled new-password key is refused rather than read as absent', async () => {
    await refuses({ method: 'POST', url: '/reset-password', body: { token: 'tok', newPasword: 'x' } }, 'body');
});

test('a numeric token is refused by name instead of being stringified into a hash', async () => {
    await refuses({ method: 'POST', url: '/reset-password', body: { token: 12345, newPassword: 'x' } }, 'body.token');
});
