/**
 * What /pending-signup accepts, and what it says when it refuses
 * (auth/login/signupIntakeRoutes.js).
 *
 * `signupType` decides the ACCOUNT TYPE, and the branch was
 * `if (signupType === 'consumer')` with everything else falling through to the
 * organisation path — so a mis-typed 'consumr' built an org signup, and the
 * consent row the OAuth callback writes recorded accountType `org_admin` for
 * somebody who asked for a personal account. `authMethod` defaulted to
 * 'google' for every value the caller could name, and it becomes the
 * organisation's WRITE-ONCE authMethod column, which no later edit can
 * correct. What this file pins:
 *
 *   - the 400 NAMES the field (`body.signupType`), not just "invalid request";
 *   - the message is a sentence;
 *   - the session is never written, so a refused request stashes nothing.
 *
 * Run: cd server && node --test --test-force-exit auth/login/signupIntakeRoutes.validation.test.js
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
    '../../stores/userStore': { getAllOrganizations: async () => [] },
    '../../stores/configStore': { getConfig: async () => true },
    '../signupGuards': { checkWebSignupAllowed: async () => ({ ok: true }) },
    '../signupCaptcha': { verifyCaptcha: async () => ({ ok: true }) },
    '../loginThrottle': { recordFanOut: async () => ({ delayMs: 0 }), sleep: async () => {} },
    '../authRateLimits': { signupIpLimiter: pass },
    '../../telemetry/log': { info() {}, warn() {}, error() {}, debug() {} },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:signup-intake-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /login[\\/]signupIntakeRoutes\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./signupIntakeRoutes');
test.after(() => { Module._resolveFilename = originalResolve; });

const { dispatcher } = require('../../core/http/routeHarness');

const dispatch = dispatcher(router, { session: () => ({ save(cb) { touched.push({ what: 'sessionSave', args: [this.pendingSignup] }); cb(); } }) });

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

test('a misspelled account type is refused instead of becoming an org signup', async () => {
    const res = await dispatch({ method: 'POST', url: '/pending-signup', body: { signupType: 'consumr' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'signupType is one of consumer, org.');
    assert.ok(res.body.details.some((d) => d.path === 'body.signupType'));
    assert.deepStrictEqual(touched, []);
});

test('an unknown sign-in method is refused instead of silently becoming google', async () => {
    // It becomes the organisation's write-once authMethod column; no later
    // edit can put it right.
    await refuses({
        method: 'POST', url: '/pending-signup',
        body: { signupType: 'consumer', authMethod: 'gogle' },
    }, 'body.authMethod');
});

test('a misspelled key is refused rather than dropped from the stashed blob', async () => {
    await refuses({ method: 'POST', url: '/pending-signup', body: { newOrgName: 'Acme', orgDetials: {} } }, 'body');
});

test('a consumer signup still stashes the method the caller chose', async () => {
    const res = await dispatch({
        method: 'POST', url: '/pending-signup',
        body: { signupType: 'consumer', authMethod: 'microsoft' },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'sessionSave').args[0].authMethod, 'microsoft');
});

test('an org signup with no type still takes the organisation path', async () => {
    const res = await dispatch({ method: 'POST', url: '/pending-signup', body: { newOrgName: ' Acme ' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'sessionSave').args[0].newOrgName, 'Acme');
});
