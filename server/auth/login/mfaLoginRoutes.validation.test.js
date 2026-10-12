/**
 * What /mfa/verify-login accepts, and what it says when it refuses
 * (auth/login/mfaLoginRoutes.js).
 *
 * `code` was read as `req.body?.code` and handed to verifyTotp / the recovery
 * code consumer as `undefined`. Both answer "no", so a body that mis-spelled
 * the key was counted as a WRONG CODE: five of those destroy mfaPending and
 * throw the user back to the password step, having spent the attempt budget on
 * a request that never named a code at all. What this file pins:
 *
 *   - the 400 NAMES the field (`body.code`), not just "invalid request";
 *   - the message is a sentence;
 *   - the store is never reached, so a refused request costs no attempt.
 *
 * Run: cd server && node --test --test-force-exit auth/login/mfaLoginRoutes.validation.test.js
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
        getUser: async (id) => { touched.push({ what: 'getUser', args: [id] }); return { id, mfa_enabled: 1, mfa_secret: 's', mfa_recovery_codes: '[]' }; },
        updateUser: hit('updateUser'),
    },
    '../mfa': {
        MFA_LOGIN_MAX_ATTEMPTS: 5,
        decryptSecret: () => 'secret',
        verifyTotp: (s, code) => { touched.push({ what: 'verifyTotp', args: [code] }); return false; },
        consumeRecoveryCode: async (stored, code) => { touched.push({ what: 'consumeRecoveryCode', args: [code] }); return null; },
    },
    '../../telemetry/metrics': { recordAuthEvent() {} },
    '../loginAudit': { auditLoginFailure: async () => {} },
    '../../utils/perUserRateLimit': { perUserRateLimit: () => pass },
    './finalizeLogin': { finalizeLogin: async (req, res) => res.json({ success: true }) },
    '../../telemetry/log': { info() {}, warn() {}, error() {}, debug() {} },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:mfa-login-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /login[\\/]mfaLoginRoutes\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./mfaLoginRoutes');
test.after(() => { Module._resolveFilename = originalResolve; });

const { dispatcher } = require('../../core/http/routeHarness');

const dispatch = dispatcher(router, { session: () => ({ mfaPending: { userId: 'u1', user: { id: 'u1' }, isAdmin: false, password: 'pw' } }) });

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

test('a body with no code is refused in words, not counted as a wrong code', async () => {
    const res = await dispatch({ method: 'POST', url: '/mfa/verify-login', body: {} });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Enter the code from your authenticator app, or one of your recovery codes.');
    assert.ok(res.body.details.some((d) => d.path === 'body.code'));
    assert.deepStrictEqual(touched, [], 'no attempt may be spent on a request that named no code');
});

test('a misspelled key is refused rather than burning one of the five attempts', async () => {
    await refuses({ method: 'POST', url: '/mfa/verify-login', body: { cod: '123456' } }, 'body');
});

test('a numeric code is refused by name instead of reaching the verifier', async () => {
    await refuses({ method: 'POST', url: '/mfa/verify-login', body: { code: 123456 } }, 'body.code');
});

test('a real code still reaches the verifier, trimmed once by the schema', async () => {
    const res = await dispatch({ method: 'POST', url: '/mfa/verify-login', body: { code: ' 123456 ' } });
    assert.strictEqual(res.statusCode, 401, 'the mock verifier rejects, which is the path being exercised');
    assert.strictEqual(touched.find((t) => t.what === 'verifyTotp').args[0], '123456');
});
