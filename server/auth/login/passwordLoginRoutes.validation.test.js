/**
 * What /admin-login accepts, and what it says when it refuses
 * (auth/login/passwordLoginRoutes.js).
 *
 * The hand-written check here ran AFTER loadConfig() and after the SSO-only
 * decision, and answered one generic sentence. The schema runs before any of
 * that, so a malformed request costs no config read and no throttle entry, and
 * `details` names the field that is wrong. What this file pins:
 *
 *   - the 400 NAMES the field (`body.password`), not just "invalid request";
 *   - the message stays ONE sentence for both fields — it must not tell a
 *     caller which half of the credentials it recognised;
 *   - the identifier is NOT trimmed: it is the throttle's key and the
 *     operator-name comparison, so " admin" must stay a different string;
 *   - the store and the throttle are never reached, so a refused request
 *     leaves no failure counted against anybody.
 *
 * Run: cd server && node --test --test-force-exit auth/login/passwordLoginRoutes.validation.test.js
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
        getUser: async (id) => { touched.push({ what: 'getUser', args: [id] }); return null; },
        getUserByEmail: async (e) => { touched.push({ what: 'getUserByEmail', args: [e] }); return null; },
    },
    '../permissions': { loadConfig: async () => ({ admin: { username: 'admin', passwordHash: null }, oauth: {} }) },
    '../../telemetry/metrics': { recordAuthEvent() {} },
    '../loginThrottle': {
        checkLoginAllowed: async (req, id) => { touched.push({ what: 'checkLoginAllowed', args: [id] }); return { allowed: true }; },
        recordLoginFailure: async (req, id) => { touched.push({ what: 'recordLoginFailure', args: [id] }); return { delayMs: 0, locked: false }; },
        recordLoginSuccess: hit('recordLoginSuccess'),
        denyLogin: (res) => res.status(429).json({ error: 'too many' }),
        padFailureResponse: async () => {},
        sleep: async () => {},
    },
    '../loginAudit': { auditLoginFailure: async () => {}, auditLoginBlocked: async () => {} },
    '../authRateLimits': { loginIpLimiter: pass },
    './finalizeLogin': { finalizeLogin: async (req, res) => res.json({ success: true }) },
    '../../telemetry/log': { info() {}, warn() {}, error() {}, debug() {} },
    'bcryptjs': { compare: async () => false, hash: async () => 'hash' },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:password-login-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /login[\\/]passwordLoginRoutes\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./passwordLoginRoutes');
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

test('a sign-in with no password is refused in words, not with "Required"', async () => {
    const res = await dispatch({ method: 'POST', url: '/admin-login', body: { username: 'bob' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Username and password are required');
    assert.ok(res.body.details.some((d) => d.path === 'body.password'));
    assert.deepStrictEqual(touched, []);
});

test('a missing username is refused with the SAME sentence as a missing password', async () => {
    // The wording must not separate "you left out a field" from "no such
    // account"; only `details` says which field, which is about the request.
    const a = await dispatch({ method: 'POST', url: '/admin-login', body: { password: 'x' } });
    const b = await dispatch({ method: 'POST', url: '/admin-login', body: { username: 'bob' } });
    assert.strictEqual(a.body.error, b.body.error);
});

test('a numeric username is refused by name instead of throwing on .includes', async () => {
    await refuses({ method: 'POST', url: '/admin-login', body: { username: 42, password: 'x' } }, 'body.username');
});

test('a misspelled key is refused rather than read as a missing credential', async () => {
    await refuses({ method: 'POST', url: '/admin-login', body: { username: 'bob', passsword: 'x' } }, 'body');
});

test('the identifier reaches the throttle exactly as it was typed', async () => {
    // Trimming here would give " admin" its own failure counter and its own
    // way around the lockout on `admin`.
    await dispatch({ method: 'POST', url: '/admin-login', body: { username: ' admin ', password: 'x' } });
    const gate = touched.find((t) => t.what === 'checkLoginAllowed');
    assert.strictEqual(gate.args[0], ' admin ');
});
