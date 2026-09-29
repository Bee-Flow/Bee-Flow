/**
 * A security key as the second factor of a password sign-in, over HTTP, with
 * the real ceremony and a software key. finalizeLogin is injected: what is
 * pinned here is that the route REACHES it with the pending login intact (the
 * password, for the encryption key, and a numeric startedAt — the field whose
 * absence once made every correct TOTP code a 500), and never reaches it
 * otherwise.
 *
 * Run: cd server && node --test auth/securityKeys/loginRoutes.test.js
 */

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const ceremony = require('./ceremony');
const { resolveRelyingParty } = require('./relyingParty');
const { createSecurityKeyLoginRouter } = require('./loginRoutes');
const { createSoftAuthenticator } = require('./softAuthenticator.testkit');
const { createMemoryStore, serve, silentLog } = require('./testApp.testkit');
const { createTerminalErrorHandler } = require('../../core/http/terminalErrorHandler');

const ORIGIN = 'https://beeflow.example';
const RP = { rpID: 'beeflow.example', origin: ORIGIN };
const ENV = { CORS_ORIGIN: ORIGIN, CLIENT_PUBLIC_HOST: 'beeflow.example' };
const MAX_ATTEMPTS = 5;

const store = createMemoryStore();
const session = { current: null };
const finalized = [];
const audited = [];
const events = [];
const router = createSecurityKeyLoginRouter({
    userStore: store,
    ceremony,
    relyingPartyOf: (req) => resolveRelyingParty(req.headers.origin, ENV),
    finalizeLogin: async (_req, res, args) => { finalized.push(args); res.json({ success: true, user: args.user }); },
    recordAuthEvent: (e) => events.push(e),
    auditLoginFailure: async (_req, row) => { audited.push(row); },
    limiter: (_req, _res, next) => next(),
    maxAttempts: MAX_ATTEMPTS,
    log: silentLog,
});
let app;
let authenticator;

/** Register `a` for u1 the way the management routes would have. */
async function enrol(a, rpID = RP.rpID) {
    const rp = { rpID, origin: `https://${rpID}` };
    const options = await ceremony.registrationOptions({ rp, userName: 'ada', existingKeys: [] });
    const result = await ceremony.verifyRegistration({
        response: a.register(options, { origin: rp.origin }), record: ceremony.challengeRecord(options, rp),
    });
    assert.equal(result.ok, true);
    return store.addSecurityKey({ userId: 'u1', ...result.key, rpId: rpID, name: 'YubiKey' });
}

beforeEach(async () => {
    app ??= await serve(router, { mount: '/auth', session, errorHandler: createTerminalErrorHandler({ log: silentLog }) });
    store.state.users.clear();
    store.state.keys = [];
    store.state.used = [];
    finalized.length = 0;
    audited.length = 0;
    events.length = 0;
    store.state.users.set('u1', { id: 'u1', mfa_enabled: true, organizationId: 'org-1' });
    authenticator = createSoftAuthenticator();
    await enrol(authenticator);
    session.current = {
        mfaPending: { userId: 'u1', user: { id: 'u1', displayName: 'Ada' }, isAdmin: false, password: 'pw', attempts: 0 },
    };
});
after(() => app?.close());

const post = (path, body, origin = ORIGIN) => app.request('POST', `/auth/mfa/security-key${path}`, { body, origin });

async function challenge() {
    const res = await post('/options', {});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.options;
}

// ── The happy path ─────────────────────────────────────────────────────────

test('a touch of the registered key completes the pending login', async () => {
    const options = await challenge();
    assert.deepEqual(options.allowCredentials.map((c) => c.id), [authenticator.credentialId]);

    const res = await post('/verify-login', { response: authenticator.authenticate(options, { origin: ORIGIN }) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(finalized.length, 1);
    assert.equal(finalized[0].password, 'pw', 'the password reaches the DEK derivation');
    assert.equal(typeof finalized[0].startedAt, 'number');
    assert.equal(finalized[0].storedUser.id, 'u1');
    assert.equal(session.current.mfaPending, undefined, 'the pending login is spent');
    assert.deepEqual(store.state.used, [{ userId: 'u1', id: store.state.keys[0].id, signCount: 1 }]);
    assert.deepEqual(events, [{ kind: 'mfa', status: 'ok' }]);
});

// ── Refusals that cost nothing ─────────────────────────────────────────────

test('without a pending login both steps answer 401', async () => {
    session.current = {};
    assert.equal((await post('/options', {})).body.code, 'no_pending_login');
    assert.equal((await post('/verify-login', { response: authenticator.authenticate({ rpId: RP.rpID, challenge: 'x' }, { origin: ORIGIN }) })).body.code, 'no_pending_login');
});

test('a key registered on another host is not offered; the code path stays', async () => {
    store.state.keys = [];
    await enrol(createSoftAuthenticator(), 'other.example');
    const res = await post('/options', {});
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'no_security_key_here');
});

test('an answer without a challenge is a broken flow and costs no attempt', async () => {
    const res = await post('/verify-login', { response: authenticator.authenticate({ rpId: RP.rpID, challenge: 'x' }, { origin: ORIGIN }) });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'challenge_expired');
    assert.equal(session.current.mfaPending.attempts, 0);
    assert.equal(finalized.length, 0);
});

test('an origin outside the allow-list gets no challenge', async () => {
    const res = await post('/options', {}, 'https://evil.test');
    assert.equal(res.body.code, 'webauthn_unavailable');
    assert.equal(session.current.mfaPending.securityKeyChallenge, undefined);
});

test('an account whose MFA was turned off meanwhile loses its pending login', async () => {
    store.state.users.get('u1').mfa_enabled = false;
    const res = await post('/options', {});
    assert.equal(res.body.code, 'mfa_not_enabled');
    assert.equal(session.current.mfaPending, undefined);
});

// ── Wrong answers: each costs one attempt ──────────────────────────────────

async function refusedWith(response) {
    const res = await post('/verify-login', { response });
    assert.equal(res.status, 401, JSON.stringify(res.body));
    assert.equal(res.body.code, 'security_key_rejected');
    assert.equal(finalized.length, 0, 'no session for a refused key');
    assert.equal(session.current.mfaPending.attempts, 1);
    assert.equal(audited.length, 1);
    assert.equal(audited[0].method, 'security_key');
}

test('an unregistered key is refused', async () => {
    const options = await challenge();
    await refusedWith(createSoftAuthenticator().authenticate(options, { origin: ORIGIN }));
});

test('an answer relayed through another origin is refused', async () => {
    const options = await challenge();
    await refusedWith(authenticator.authenticate(options, { origin: 'https://beeflow-login.evil.test' }));
});

test('a cloned key, whose counter did not move forward, is refused', async () => {
    store.state.keys[0].signCount = 9;
    const options = await challenge();
    await refusedWith(authenticator.authenticate(options, { origin: ORIGIN, counterValue: 9 }));
});

test('an old answer does not satisfy a new challenge', async () => {
    const first = await challenge();
    const stale = authenticator.authenticate(first, { origin: ORIGIN });
    await challenge(); // a second prompt replaces the first
    await refusedWith(stale);
});

test('a challenge answers once', async () => {
    const options = await challenge();
    const response = authenticator.authenticate(options, { origin: ORIGIN });
    const wrong = await post('/verify-login', { response: createSoftAuthenticator().authenticate(options, { origin: ORIGIN }) });
    assert.equal(wrong.status, 401);
    const replay = await post('/verify-login', { response });
    assert.equal(replay.body.code, 'challenge_expired', 'the refused answer used the challenge up');
    assert.equal(finalized.length, 0);
});

test('the last allowed wrong answer ends the pending login', async () => {
    session.current.mfaPending.attempts = MAX_ATTEMPTS - 1;
    const options = await challenge();
    const res = await post('/verify-login', { response: createSoftAuthenticator().authenticate(options, { origin: ORIGIN }) });
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'mfa_attempts_exhausted');
    assert.equal(session.current.mfaPending, undefined, 'back to the password step');
});

test('a body that is not a credential is refused before it costs an attempt', async () => {
    await challenge();
    const res = await post('/verify-login', { response: { id: 'x' } });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'invalid_request');
    assert.equal(session.current.mfaPending.attempts, 0);
});
