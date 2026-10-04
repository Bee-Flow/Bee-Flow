/**
 * What /resend-verification accepts, and what it says when it refuses
 * (auth/login/emailVerificationRoutes.js).
 *
 * Same shape as /forgot-password, and the same silent answer: a body naming no
 * address was answered `{success:true}` with no mail attempted, so somebody
 * stuck on "check your inbox" pressed Resend and was told it had been sent.
 * What this file pins:
 *
 *   - the 400 NAMES the field (`body.email`), not just "invalid request";
 *   - the message is a sentence;
 *   - the CONSTANT-200 contract survives for a well-formed request;
 *   - the store is never reached, so a refused request changes nothing.
 *
 * Run: cd server && node --test --test-force-exit auth/login/emailVerificationRoutes.validation.test.js
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
        getUserByEmailVerificationToken: async () => null,
        updateUser: hit('updateUser'),
        getOrganization: async () => null,
        logAccessAudit: async () => {},
        claimNotification: async () => false,
    },
    '../loginThrottle': { recordFanOut: async () => ({ delayMs: 0 }), sleep: async () => {} },
    '../authRateLimits': { resendVerificationIpLimiter: pass, resendVerificationTargetLimiter: pass },
    '../../utils/emailService': { sendVerificationEmail: async () => {}, sendWelcomeEmail: async () => {} },
    '../../utils/appPaths': { clientHost: () => 'https://example.test', legacyLoginPath: (q) => `/login?${q}` },
    '../../telemetry/log': { info() {}, warn() {}, error() {}, debug() {} },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:email-verification-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /login[\\/]emailVerificationRoutes\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./emailVerificationRoutes');
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

test('a resend naming no address is refused in words, not answered "success"', async () => {
    const res = await dispatch({ method: 'POST', url: '/resend-verification', body: {} });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Enter the e-mail address you signed up with.');
    assert.ok(res.body.details.some((d) => d.path === 'body.email'));
    assert.deepStrictEqual(touched, []);
});

test('a misspelled key is refused rather than promising a mail nothing will send', async () => {
    await refuses({ method: 'POST', url: '/resend-verification', body: { emai: 'a@b.test' } }, 'body');
});

test('an address with no account still gets the same answer as one that has', async () => {
    const res = await dispatch({ method: 'POST', url: '/resend-verification', body: { email: ' nobody@b.test ' } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { success: true });
    assert.strictEqual(touched.find((t) => t.what === 'getUserByEmail').args[0], 'nobody@b.test');
});
