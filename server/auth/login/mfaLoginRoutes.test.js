/**
 * POST /auth/mfa/verify-login — the success path, behaviourally.
 *
 * REGRESSION (2026-09-11): the handler passed `startedAt` to finalizeLogin but
 * never declared it. Only the SUCCESS branch touched the name, so a WRONG code
 * answered 401 correctly while a CORRECT code threw a ReferenceError that the
 * handler's own catch turned into `500 {"error":"MFA verification failed"}`.
 * Every second factor on the install was unusable, and the symptom read as
 * "MFA rejects my valid codes" — which is why it survived: the failure paths
 * all behaved.
 *
 * The test that would have caught it is the one nobody writes: assert the
 * HAPPY path returns a session, not just that bad input is refused.
 *
 * Mock seams follow currentUserRoutes.mfa.test.js: stub the leaf modules
 * behind Module._resolveFilename, keep the route itself real.
 *
 * Run: cd server && node --test --test-force-exit auth/login/mfaLoginRoutes.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');
const http = require('http');

// ── In-memory stubs ────────────────────────────────────────────────────────
const GOOD_CODE = '123456';
let userRow = null;
let finalizeCalls = [];

const userStoreStub = {
    async getUser() { return userRow; },
    async updateUser() { return true; },
};
const mfaStub = {
    MFA_LOGIN_MAX_ATTEMPTS: 5,
    decryptSecret: (enc) => (enc === 'UNREADABLE' ? null : 'SECRET'),
    verifyTotp: (_secret, code) => code === GOOD_CODE,
    consumeRecoveryCode: async (_codes, code) => (code === 'recovery-1' ? ['left'] : null),
};
const metricsStub = { recordAuthEvent: () => {} };
const auditStub = { auditLoginFailure: async () => {} };
const rateLimitStub = { perUserRateLimit: () => (_req, _res, next) => next() };
// The real finalizeLogin would need a session store, a DEK and a config load.
// What this test pins is that the route REACHES it with well-formed arguments
// — including a numeric startedAt, the field whose absence caused the 500.
const finalizeStub = {
    async finalizeLogin(req, res, args) {
        finalizeCalls.push(args);
        return res.json({ success: true, startedAtType: typeof args.startedAt });
    },
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    const from = parent && parent.filename ? parent.filename : '';
    if (from.endsWith(path.join('auth', 'login', 'mfaLoginRoutes.js'))) {
        if (request === '../../stores/userStore') return path.join(__dirname, '__stub_us_mfalogin__.js');
        if (request === '../mfa') return path.join(__dirname, '__stub_mfa_mfalogin__.js');
        if (request === '../../telemetry/metrics') return path.join(__dirname, '__stub_met_mfalogin__.js');
        if (request === '../loginAudit') return path.join(__dirname, '__stub_aud_mfalogin__.js');
        if (request === '../../utils/perUserRateLimit') return path.join(__dirname, '__stub_rl_mfalogin__.js');
        if (request === './finalizeLogin') return path.join(__dirname, '__stub_fin_mfalogin__.js');
    }
    return origResolve.call(this, request, parent, ...rest);
};
for (const [fname, exp] of Object.entries({
    '__stub_us_mfalogin__.js': userStoreStub,
    '__stub_mfa_mfalogin__.js': mfaStub,
    '__stub_met_mfalogin__.js': metricsStub,
    '__stub_aud_mfalogin__.js': auditStub,
    '__stub_rl_mfalogin__.js': rateLimitStub,
    '__stub_fin_mfalogin__.js': finalizeStub,
})) {
    const full = path.join(__dirname, fname);
    require.cache[full] = { id: full, filename: full, loaded: true, exports: exp };
}

const express = require('express');
const router = require('./mfaLoginRoutes');
const app = express();
app.use(express.json());
let currentSession = null;
app.use((req, _res, next) => { req.session = currentSession; next(); });
app.use('/auth', router);
let server;

before(() => { server = app.listen(0); });
after(() => { server?.close(); Module._resolveFilename = origResolve; });

function verify(code) {
    const { port } = server.address();
    const body = JSON.stringify({ code });
    return new Promise((resolve, reject) => {
        const req = http.request({
            port, host: '127.0.0.1', path: '/auth/mfa/verify-login', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                let parsed = null;
                try { parsed = JSON.parse(raw); } catch { parsed = raw; }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('error', reject);
        req.end(body);
    });
}

function pendingSession(overrides = {}) {
    return {
        mfaPending: {
            userId: 'u1', user: { id: 'u1', email: 'u@example.test' },
            isAdmin: false, password: 'pw', attempts: 0, ...overrides,
        },
    };
}

test('a CORRECT code completes the login instead of 500ing (the startedAt regression)', async () => {
    userRow = { id: 'u1', mfa_enabled: true, mfa_secret: 'ENC', organizationId: 'org1' };
    currentSession = pendingSession();
    finalizeCalls = [];

    const res = await verify(GOOD_CODE);

    assert.notStrictEqual(res.status, 500, 'a valid second factor must never 500 — this is the bug');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(finalizeCalls.length, 1, 'the route reached finalizeLogin');
    assert.strictEqual(typeof finalizeCalls[0].startedAt, 'number',
        'startedAt must be a real timestamp — finalizeLogin pads failure timing with it');
    assert.strictEqual(currentSession.mfaPending, undefined, 'the pending stash is cleared on success');
});

test('a recovery code also completes the login', async () => {
    userRow = { id: 'u1', mfa_enabled: true, mfa_secret: 'ENC', mfa_recovery_codes: '["recovery-1"]', organizationId: 'org1' };
    currentSession = pendingSession();
    finalizeCalls = [];

    const res = await verify('recovery-1');

    assert.strictEqual(res.status, 200, 'the recovery branch reaches the same success path');
    assert.strictEqual(typeof finalizeCalls[0].startedAt, 'number');
});

test('a wrong code still refuses with 401, not 500', async () => {
    // This half always worked — it is here so a future "fix" cannot pass the
    // happy-path test by making every code succeed.
    userRow = { id: 'u1', mfa_enabled: true, mfa_secret: 'ENC', organizationId: 'org1' };
    currentSession = pendingSession();

    const res = await verify('000000');

    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.code, 'invalid_code');
});

test('no pending login is a 401, and an undecryptable secret says so specifically', async () => {
    currentSession = {};
    assert.strictEqual((await verify(GOOD_CODE)).status, 401, 'no mfaPending → 401');

    userRow = { id: 'u1', mfa_enabled: true, mfa_secret: 'UNREADABLE', organizationId: 'org1' };
    currentSession = pendingSession();
    const res = await verify('000000');
    assert.strictEqual(res.body.code, 'mfa_secret_unreadable',
        'a key-rotation casualty is distinguished from a typo so the user does not burn recovery codes');
});

test('an account with security keys only has no secret: a wrong code is "invalid", not "unreadable"', async () => {
    userRow = { id: 'u1', mfa_enabled: true, mfa_secret: null, organizationId: 'org1' };
    currentSession = pendingSession();
    const res = await verify('000000');
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.code, 'invalid_code');
});

test('an account with security keys only still signs in with a recovery code', async () => {
    userRow = { id: 'u1', mfa_enabled: true, mfa_secret: null, organizationId: 'org1' };
    currentSession = pendingSession();
    finalizeCalls = [];
    const res = await verify('recovery-1');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(finalizeCalls.length, 1);
});
