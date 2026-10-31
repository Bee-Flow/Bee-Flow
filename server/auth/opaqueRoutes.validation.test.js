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

/** The account the login and registration finishes look up; the second-factor cases set it. */
let userRow = null;
/** What establishSession was asked to write. */
let established = [];
/** The pending login /login/start would have stored. */
const pendingLogin = { serverLoginState: 's', username: 'ada', absent: false, userId: 'u1' };

const MOCKS = {
    './permissions': { requireAuth: pass },
    '../stores/userStore': {
        getUser: async (id) => userRow || ({ id, username: id, wrappedDEK: null, opaqueRecord: 'rec' }),
        updateUser: (...args) => { touched.push({ what: 'updateUser', args }); return true; },
        listSecurityKeys: async () => [],
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
    './establishSession': {
        establishSession: async (req, opts) => {
            established.push(opts);
            req.session.isAuthenticated = true;
            req.session.user = opts.user;
            for (const [k, val] of Object.entries(opts.extra || {})) req.session[k] = val;
        },
    },
    './accountStatusGate': { isLoginBlockedAccount: () => null, REFUSAL: {} },
    '../telemetry/metrics': { recordAuthEvent() {} },
    '../telemetry/log': { info() {}, warn() {}, error() {}, debug() {} },
    '../db': { getRedis: () => null },
    '@serenity-kit/opaque': {
        ready: Promise.resolve(),
        server: {
            createRegistrationResponse: () => { touched.push({ what: 'createRegistrationResponse', args: [] }); return { registrationResponse: 'resp' }; },
            startLogin: () => ({ serverLoginState: 's', loginResponse: 'resp' }),
            finishLogin: () => ({ sessionKey: Buffer.alloc(32, 1).toString('base64') }),
            createSetup: () => 'setup',
        },
    },
};

// The finalizer modules load their own establishSession and log; point them at the mocks too.
MOCKS['../establishSession'] = MOCKS['./establishSession'];
MOCKS['../../telemetry/log'] = MOCKS['../telemetry/log'];

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:opaque-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    const from = parent && parent.filename ? parent.filename : '';
    const inScope = /auth[\\/]opaque(Routes|SupportRoutes)\.js$/.test(from)
        || /auth[\\/]login[\\/](finalizeOpaqueLogin|pendingMfa|finalizeLogin)\.js$/.test(from);
    if (inScope && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

// The pending-login store, swapped on the support module BEFORE the route
// destructures from it. Loaded under the hook, so its own requires land on
// the mocks above.
const support = require('./opaqueSupportRoutes');
support.getPendingLogin = async (id) => (id === 'l1' ? pendingLogin : null);
support.setPendingLogin = async () => {};
support.deletePendingLogin = async () => {};

const router = require('./opaqueRoutes');
test.after(() => { Module._resolveFilename = originalResolve; });

const { dispatcher } = require('../testUtils/routeHarness');

const dispatch = dispatcher(router, { session: () => ({ user: { id: 'u1' }, save(cb) { cb(); } }) });

test.beforeEach(() => { touched.length = 0; userRow = null; established = []; });

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

// ── The second factor, and replacing a credential ─────────────────────────
//
// /login/finish on an account with mfa_enabled answers `mfaRequired` and
// establishes NO session; the pending blob names the OPAQUE path and holds
// the key the client handed over, never a password. Replacing an existing
// credential (/register/finish, /pin/register/finish) needs a recent proof;
// a first registration does not.

/** One browser session for the cases below. */
let session;
test.beforeEach(() => { session = { save(cb) { if (cb) cb(); } }; });
const updated = () => touched.filter((t) => t.what === 'updateUser');

const ACCOUNT = { id: 'u1', username: 'ada', displayName: 'Ada', role: 'user', organizationId: 'org1', opaqueRecord: 'rec', kdfMode: 'opaque_v1', wrappedDEK: null };
const FINISH = { loginId: 'l1', finishLoginRequest: 'fin' };

test('with a second factor on the account, the protocol proof alone does not sign in', async () => {
    userRow = { ...ACCOUNT, mfa_enabled: true, mfa_secret: 'sealed' };
    const res = await dispatch({ method: 'POST', url: '/login/finish', body: FINISH, session });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body, { mfaRequired: true, mfaMethods: ['totp'] });
    assert.strictEqual(established.length, 0, 'no session before the second factor');
    assert.strictEqual(session.isAuthenticated, undefined);
    assert.ok(session.mfaPending, 'the first factor is parked for /mfa/verify-login');
    assert.strictEqual(session.mfaPending.opaque, true);
    assert.strictEqual(session.mfaPending.userId, 'u1');
    assert.strictEqual(session.mfaPending.password, undefined, 'OPAQUE never had a password to park');
    assert.strictEqual(session.mfaPending.encryptionKey, undefined, 'no key was handed over');
    assert.ok(!('sessionKey' in res.body), 'the client already holds the session key from the protocol');
});

test('the key the client handed over rides along to the second step', async () => {
    userRow = { ...ACCOUNT, mfa_enabled: true, mfa_secret: 'sealed' };
    // Seal a DEK the way the client does: AES-256-GCM under the first 32 bytes
    // of the OPAQUE session key.
    const crypto = require('crypto');
    const aesKey = Buffer.alloc(32, 1);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
    const data = Buffer.concat([cipher.update('dek-base64', 'utf8'), cipher.final()]);
    const encryptedDEK = { iv: iv.toString('hex'), authTag: cipher.getAuthTag().toString('hex'), data: data.toString('hex') };
    const res = await dispatch({ method: 'POST', url: '/login/finish', body: { ...FINISH, encryptedDEK }, session });
    assert.strictEqual(res.body.mfaRequired, true);
    assert.strictEqual(session.mfaPending.encryptionKey, 'dek-base64');
});

test('without a second factor the login completes as before, session key included', async () => {
    userRow = { ...ACCOUNT, mfa_enabled: false };
    const res = await dispatch({ method: 'POST', url: '/login/finish', body: FINISH, session });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
    assert.deepStrictEqual(res.body.user, { id: 'u1', displayName: 'Ada', role: 'user', avatar: null, avatarType: null });
    assert.strictEqual(typeof res.body.sessionKey, 'string');
    assert.strictEqual(established.length, 1);
    assert.strictEqual(established[0].extra.opaqueMode, true);
    assert.strictEqual(typeof established[0].extra.opaqueLoginAt, 'number');
    assert.strictEqual(established[0].audit.method, 'opaque');
    assert.strictEqual(session.mfaPending, undefined);
});

const REGISTER = { registrationRecord: 'rec2', wrappedDEK: { iv: 'aa', authTag: 'bb', data: 'cc' }, confirmReplace: true };

test('replacing an existing OPAQUE credential needs a recent proof', async () => {
    userRow = { ...ACCOUNT, wrappedDEK: '{}' };
    session.user = { id: 'u1' };
    session.authenticatedAt = Date.now() - 60 * 60 * 1000; // signed in an hour ago
    const res = await dispatch({ method: 'POST', url: '/register/finish', body: REGISTER, session });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.code, 'reauth_required');
    assert.deepStrictEqual(updated(), [], 'nothing was written');
});

test('with a recent second factor the replacement goes through', async () => {
    userRow = { ...ACCOUNT, wrappedDEK: '{}' };
    session.user = { id: 'u1' };
    session.authenticatedAt = Date.now() - 60 * 60 * 1000;
    session.mfaVerifiedAt = Date.now() - 30_000;
    const res = await dispatch({ method: 'POST', url: '/register/finish', body: REGISTER, session });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(updated().length, 1);
    assert.strictEqual(updated()[0].args[1].opaqueRecord, 'rec2');
});

test('a first registration (the migration from a legacy password) is not held to it', async () => {
    userRow = { ...ACCOUNT, opaqueRecord: null, kdfMode: 'legacy_argon2', wrappedDEK: null };
    session.user = { id: 'u1' };
    // No proof mark at all on this session.
    const res = await dispatch({ method: 'POST', url: '/register/finish', body: { registrationRecord: 'rec2', wrappedDEK: { iv: 'aa', authTag: 'bb', data: 'cc' } }, session });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(updated().length, 1);
});

test('replacing an existing PIN needs a recent proof too; a PIN unlock is one', async () => {
    userRow = { ...ACCOUNT, wrappedDEK: '{}' };
    session.user = { id: 'u1' };
    session.authenticatedAt = Date.now() - 60 * 60 * 1000;
    const body = { registrationRecord: 'pin2', wrappedDEK: { iv: 'aa', authTag: 'bb', data: 'cc' }, confirmReplace: true };
    const stale = await dispatch({ method: 'POST', url: '/pin/register/finish', body, session });
    assert.strictEqual(stale.statusCode, 403);
    assert.strictEqual(stale.body.code, 'reauth_required');

    session.pinVerifiedAt = Date.now() - 5_000;
    const fresh = await dispatch({ method: 'POST', url: '/pin/register/finish', body, session });
    assert.strictEqual(fresh.statusCode, 200);
    assert.strictEqual(updated().length, 1);
});
