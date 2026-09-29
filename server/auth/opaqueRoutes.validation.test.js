/**
 * What the OPAQUE routes accept, and what they say when they refuse
 * (auth/opaqueRoutes.js).
 *
 * These bodies carry the protocol messages AND the key envelopes the client
 * built — the wrapping that is the only thing standing between this
 * installation and the user's data. A key the server silently drops here is a
 * key envelope the client believes it stored. What this file pins:
 *
 *   - the 400 NAMES the field (`body.wrappedDEK`), not just "invalid request";
 *   - the message is a sentence, including for a field simply left out;
 *   - an envelope is an OBJECT, which is what every shipped client sends and
 *     what the handler reads field by field (iv / authTag / data);
 *   - `username` on the registration steps is ACCEPTED AND IGNORED, because a
 *     shipped client still sends it and the server deliberately takes the
 *     account from the session — that substitution is the fix for the takeover
 *     this route used to allow;
 *   - the store is never reached, so a refused request re-wraps nothing.
 *
 * Run: cd server && node --test --test-force-exit auth/opaqueRoutes.validation.test.js
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
    './permissions': { requireAuth: pass },
    '../stores/userStore': {
        getUser: async (id) => ({ id, username: id, wrappedDEK: null, opaqueRecord: 'rec' }),
        updateUser: (...args) => { touched.push({ what: 'updateUser', args }); return true; },
    },
    '../utils/perUserRateLimit': { perUserRateLimit: () => pass },
    './loginThrottle': {
        checkLoginAllowed: async () => ({ allowed: true }),
        recordLoginFailure: async () => ({ delayMs: 0, locked: false }),
        recordLoginSuccess: async () => {},
        denyLogin: (res) => res.status(429).json({ error: 'too many' }),
        padFailureResponse: async () => {},
        sleep: async () => {},
    },
    './loginAudit': { auditLoginFailure: async () => {}, auditLoginBlocked: async () => {} },
    './establishSession': { establishSession: async () => {} },
    './accountStatusGate': { isLoginBlockedAccount: () => null, REFUSAL: {} },
    '../telemetry/metrics': { recordAuthEvent() {} },
    '../telemetry/log': { info() {}, warn() {}, error() {}, debug() {} },
    '../db': { getRedis: () => null },
    '@serenity-kit/opaque': {
        ready: Promise.resolve(),
        server: {
            createRegistrationResponse: () => { touched.push({ what: 'createRegistrationResponse', args: [] }); return { registrationResponse: 'resp' }; },
            startLogin: () => ({ serverLoginState: 's', loginResponse: 'resp' }),
            finishLogin: () => ({ sessionKey: 'k' }),
            createSetup: () => 'setup',
        },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:opaque-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /auth[\\/]opaqueRoutes\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./opaqueRoutes');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

function dispatch({ method, url, body = {}, session }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, query: {}, headers: {},
            session: session || { user: { id: 'u1' }, save(cb) { cb(); } }, get() { return undefined; },
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
    assert.strictEqual(res.body.code, 'invalid_request', what);
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the store');
}

const ENVELOPE = { iv: 'aa', authTag: 'bb', data: 'cc' };

test('a registration finish with no wrapped key is refused by name', async () => {
    await refuses({
        method: 'POST', url: '/register/finish',
        body: { registrationRecord: 'rec' },
    }, 'body.wrappedDEK');
});

test('a wrapped key sent as text is refused instead of stored as a string', async () => {
    // The handler reads iv / authTag / data off this object; a string would
    // round-trip through JSON.stringify and come back unusable.
    await refuses({
        method: 'POST', url: '/register/finish',
        body: { registrationRecord: 'rec', wrappedDEK: 'not-an-envelope' },
    }, 'body.wrappedDEK');
});

test('a misspelled recovery envelope is refused, not dropped on the floor', async () => {
    // Dropping it silently costs the user the only other way back to their data.
    await refuses({
        method: 'POST', url: '/register/finish',
        body: { registrationRecord: 'rec', wrappedDEK: ENVELOPE, recoveryWrapedDEK: ENVELOPE },
    }, 'body');
});

test('the username the shipped client still sends is accepted, and ignored', async () => {
    const res = await dispatch({
        method: 'POST', url: '/register/start',
        body: { username: 'someone-else', registrationRequest: 'req' },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(touched.some((t) => t.what === 'createRegistrationResponse'));
});

test('a login start with no identifier is refused in words, not with "Required"', async () => {
    const res = await dispatch({ method: 'POST', url: '/login/start', body: { startLoginRequest: 'req' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'username and startLoginRequest required');
    assert.ok(res.body.details.some((d) => d.path === 'body.username'));
    assert.deepStrictEqual(touched, []);
});

test('a misspelled loginId on finish is refused rather than read as absent', async () => {
    await refuses({
        method: 'POST', url: '/login/finish',
        body: { loginID: 'x', finishLoginRequest: 'req' },
    }, 'body');
});

test('a login with no DEK to hand over may still say so with null', async () => {
    const res = await dispatch({
        method: 'POST', url: '/login/finish',
        body: { loginId: 'missing', finishLoginRequest: 'req', encryptedDEK: null },
    });
    assert.strictEqual(res.statusCode, 400, 'the pending login is gone, which is the path past the schema');
    assert.match(res.body.error, /expired or invalid/);
});
