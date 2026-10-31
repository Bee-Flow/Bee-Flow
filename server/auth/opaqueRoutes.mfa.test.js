/**
 * The OPAQUE login and the second factor (auth/opaqueRoutes.js).
 *
 * The password path has held a verified first factor back behind
 * session.mfaPending since the day MFA shipped; the OPAQUE path established
 * the session straight from the protocol proof. An account with an
 * authenticator app was therefore protected by it on one door and not on the
 * other. What this file pins:
 *
 *   - /login/finish on an account with mfa_enabled answers `mfaRequired` and
 *     establishes NO session; the pending blob names the OPAQUE path and holds
 *     the key the client handed over, never a password;
 *   - /login/finish on an account without MFA still answers success, with the
 *     session key, as before;
 *   - replacing an existing credential (/register/finish, /pin/register/
 *     finish) needs a recent proof; a first registration does not.
 *
 * Run: cd server && node --test auth/opaqueRoutes.mfa.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const pass = (req, res, next) => next();

/** The account /login/finish looks up; tests change it. */
let userRow = null;
/** What establishSession was asked to write; tests read it. */
let established = [];
/** The rows updateUser wrote. */
let updated = [];
/** The pending login /login/start would have stored. */
let pendingLogin = { serverLoginState: 's', username: 'ada', absent: false, userId: 'u1' };

const MOCKS = {
    './permissions': { requireAuth: pass },
    '../stores/userStore': {
        getUser: async () => userRow,
        updateUser: async (id, patch) => { updated.push({ id, patch }); return true; },
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
    './loginAudit': { auditLoginFailure: async () => {}, auditLoginBlocked: async () => {}, auditLoginSuccess: async () => {} },
    './establishSession': {
        establishSession: async (req, opts) => {
            established.push(opts);
            req.session.isAuthenticated = true;
            req.session.user = opts.user;
            for (const [k, v] of Object.entries(opts.extra || {})) req.session[k] = v;
        },
    },
    './accountStatusGate': { isLoginBlockedAccount: () => false, REFUSAL: {} },
    '../telemetry/metrics': { recordAuthEvent() {} },
    '../telemetry/log': { info() {}, warn() {}, error() {}, debug() {} },
    '../db': { getRedis: () => null },
    '@serenity-kit/opaque': {
        ready: Promise.resolve(),
        server: {
            createRegistrationResponse: () => ({ registrationResponse: 'resp' }),
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
    const mockId = `mock:opaque-mfa:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    const from = parent && parent.filename ? parent.filename : '';
    const inScope = /auth[\\/]opaque(Routes|SupportRoutes)\.js$/.test(from)
        || /auth[\\/]login[\\/]finalizeOpaqueLogin\.js$/.test(from)
        || /auth[\\/]login[\\/]pendingMfa\.js$/.test(from);
    if (inScope && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) return MOCK_IDS[request];
    return originalResolve.call(this, request, parent, ...rest);
};

// The support module is real (its zod schemas are what the bodies are checked
// against) and loaded UNDER the hook, so its own requires land on the mocks;
// only its pending-login store is swapped, on the shared module object the
// route destructures from. Loaded by absolute path: Node caches relative
// resolutions per directory and this file sits next to the route.
const support = require(require('path').join(__dirname, 'opaqueSupportRoutes.js'));
support.getPendingLogin = async () => pendingLogin;
support.setPendingLogin = async () => {};
support.deletePendingLogin = async () => {};

const router = require('./opaqueRoutes');
test.after(() => { Module._resolveFilename = originalResolve; });

const { dispatcher } = require('../testUtils/routeHarness');

/** One browser session, shared across the requests of a test. */
let session;
const dispatch = dispatcher(router, { session: () => session });

test.beforeEach(() => {
    established = [];
    updated = [];
    session = { save(cb) { if (cb) cb(); } };
});

const ACCOUNT = { id: 'u1', username: 'ada', displayName: 'Ada', role: 'user', organizationId: 'org1', opaqueRecord: 'rec', kdfMode: 'opaque_v1', wrappedDEK: null };
const FINISH = { loginId: 'l1', finishLoginRequest: 'fin' };

test('with a second factor on the account, the protocol proof alone does not sign in', async () => {
    userRow = { ...ACCOUNT, mfa_enabled: true, mfa_secret: 'sealed' };
    const res = await dispatch({ method: 'POST', url: '/login/finish', body: FINISH });
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
    const res = await dispatch({ method: 'POST', url: '/login/finish', body: { ...FINISH, encryptedDEK } });
    assert.strictEqual(res.body.mfaRequired, true);
    assert.strictEqual(session.mfaPending.encryptionKey, 'dek-base64');
});

test('without a second factor the login completes as before, session key included', async () => {
    userRow = { ...ACCOUNT, mfa_enabled: false };
    const res = await dispatch({ method: 'POST', url: '/login/finish', body: FINISH });
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
    const res = await dispatch({ method: 'POST', url: '/register/finish', body: REGISTER });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.code, 'reauth_required');
    assert.deepStrictEqual(updated, [], 'nothing was written');
});

test('with a recent second factor the replacement goes through', async () => {
    userRow = { ...ACCOUNT, wrappedDEK: '{}' };
    session.user = { id: 'u1' };
    session.authenticatedAt = Date.now() - 60 * 60 * 1000;
    session.mfaVerifiedAt = Date.now() - 30_000;
    const res = await dispatch({ method: 'POST', url: '/register/finish', body: REGISTER });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(updated.length, 1);
    assert.strictEqual(updated[0].patch.opaqueRecord, 'rec2');
});

test('a first registration (the migration from a legacy password) is not held to it', async () => {
    userRow = { ...ACCOUNT, opaqueRecord: null, kdfMode: 'legacy_argon2', wrappedDEK: null };
    session.user = { id: 'u1' };
    // No proof mark at all on this session.
    const res = await dispatch({ method: 'POST', url: '/register/finish', body: { registrationRecord: 'rec2', wrappedDEK: { iv: 'aa', authTag: 'bb', data: 'cc' } } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(updated.length, 1);
});

test('replacing an existing PIN needs a recent proof too; a PIN unlock is one', async () => {
    userRow = { ...ACCOUNT, wrappedDEK: '{}' };
    session.user = { id: 'u1' };
    session.authenticatedAt = Date.now() - 60 * 60 * 1000;
    const body = { registrationRecord: 'pin2', wrappedDEK: { iv: 'aa', authTag: 'bb', data: 'cc' }, confirmReplace: true };
    const stale = await dispatch({ method: 'POST', url: '/pin/register/finish', body });
    assert.strictEqual(stale.statusCode, 403);
    assert.strictEqual(stale.body.code, 'reauth_required');

    session.pinVerifiedAt = Date.now() - 5_000;
    const fresh = await dispatch({ method: 'POST', url: '/pin/register/finish', body });
    assert.strictEqual(fresh.statusCode, 200);
    assert.strictEqual(updated.length, 1);
});
