/**
 * Adding, listing, renaming and removing security keys, over HTTP, with the
 * real ceremony, the real proof check and software keys. The store is an
 * in-memory stand-in handed to the router factory; nothing is patched in the
 * module system.
 *
 * What these pin, beyond "it works":
 *   - a key is a second factor on its own: the first one turns two-factor
 *     authentication on and hands out recovery codes, no authenticator needed;
 *   - once 2FA is on, adding a key needs proof of a factor the account
 *     already has (an authenticator code, a recovery code, or another key), so
 *     a hijacked session cannot plant its own;
 *   - the account's last factor cannot be removed here (that is /disable);
 *   - a registration challenge answers once, on the origin it was issued for;
 *   - the client never receives a key's credential id or public key;
 *   - one user can neither rename nor remove another user's key.
 *
 * Run: cd server && node --test auth/securityKeys/managementRoutes.test.js
 */

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const ceremony = require('./ceremony');
const { resolveRelyingParty } = require('./relyingParty');
const { createSecondFactorProof } = require('./proof');
const { createSecurityKeyManagementRouter, MAX_KEYS_PER_USER } = require('./managementRoutes');
const { createSoftAuthenticator } = require('./softAuthenticator.testkit');
const { createMemoryStore, serve, silentLog } = require('./testApp.testkit');
const { createTerminalErrorHandler } = require('../../core/http/terminalErrorHandler');

const ORIGIN = 'https://beeflow.example';
const ENV = { CORS_ORIGIN: `${ORIGIN},https://www.beeflow.example`, CLIENT_PUBLIC_HOST: 'beeflow.example' };
const GOOD_CODE = '123456';
const RECOVERY = 'aaaa-bbbb';

const store = createMemoryStore();
const session = { current: null };
const mfa = {
    decryptSecret: (sealed) => (sealed === 'sealed' ? 'SECRET' : null),
    verifyTotp: (secret, code) => !!secret && code === GOOD_CODE,
    consumeRecoveryCode: async (stored, code) => (code === RECOVERY ? [{ hash: 'h', usedAt: 'now' }] : null),
    generateRecoveryCodes: async () => ({ plain: ['cccc-dddd'], stored: [{ hash: 'fresh', usedAt: null }] }),
};
const router = createSecurityKeyManagementRouter({
    userStore: store,
    mfa,
    ceremony,
    proof: createSecondFactorProof({ userStore: store, mfa, ceremony }),
    ensureUserRow: (id) => store.getUser(id),
    relyingPartyOf: (req) => resolveRelyingParty(req.headers.origin, ENV),
    requireAuth: (req, res, next) => (req.session?.user ? next() : res.status(401).json({ error: 'Authentication required' })),
    codeLimiter: (_req, _res, next) => next(),
    log: silentLog,
});
let app;

/** An account with an authenticator app (the fixture most tests start from). */
const withApp = () => ({ id: 'u1', username: 'ada', displayName: 'Ada', mfa_enabled: true, mfa_secret: 'sealed', mfa_recovery_codes: '[]' });
/** An account without two-factor authentication at all. */
const without2fa = () => ({ id: 'u1', username: 'ada', mfa_enabled: false, mfa_secret: null, mfa_recovery_codes: null });

beforeEach(async () => {
    app ??= await serve(router, { mount: '/auth/mfa', session, errorHandler: createTerminalErrorHandler({ log: silentLog }) });
    store.state.users.clear();
    store.state.keys = [];
    store.state.audit = [];
    store.state.used = [];
    store.state.users.set('u1', withApp());
    store.state.users.set('u2', { id: 'u2', username: 'bob', mfa_enabled: true, mfa_secret: 'sealed' });
    session.current = { user: { id: 'u1', organizationId: 'org-1' } };
});
after(() => app?.close());

const post = (path, body, origin = ORIGIN) => app.request('POST', `/auth/mfa${path}`, { body, origin });

/** Run options → touch → verify. `proof` is whatever the options step carries. */
async function addKey(authenticator = createSoftAuthenticator(), proof = { code: GOOD_CODE }, name = 'YubiKey 5C') {
    const started = await post('/security-keys/registration/options', { ...proof, name });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const response = authenticator.register(started.body.options, { origin: ORIGIN });
    return post('/security-keys/registration/verify', { response });
}

/** Tap an already registered key to answer a proof challenge. */
async function tapAsProof(authenticator) {
    const res = await post('/security-keys/proof/options', {});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return { securityKey: authenticator.authenticate(res.body.options, { origin: ORIGIN }) };
}

// ── The first key: two-factor authentication without an authenticator app ──

test('an account without 2FA adds a key with no code, which turns 2FA on with recovery codes', async () => {
    store.state.users.set('u1', without2fa());
    const res = await addKey(createSoftAuthenticator(), {});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.recoveryCodes, ['cccc-dddd'], 'shown once, like enabling the app');

    const row = store.state.users.get('u1');
    assert.equal(row.mfa_enabled, true);
    assert.equal(row.mfa_secret, null, 'no authenticator app was needed');
    assert.equal(row.mfa_recovery_codes, JSON.stringify([{ hash: 'fresh', usedAt: null }]));
});

test('a key-only account adds its second key by tapping the first', async () => {
    store.state.users.set('u1', without2fa());
    const first = createSoftAuthenticator();
    await addKey(first, {});

    const res = await addKey(createSoftAuthenticator(), await tapAsProof(first), 'Backup key');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.recoveryCodes, undefined, 'the second factor leaves the recovery codes alone');
    assert.equal(store.state.keys.length, 2);
    assert.equal(store.state.used.length, 1, 'the proving key is recorded as used');
});

test('a key-only account can prove with a recovery code, which is then spent', async () => {
    store.state.users.set('u1', { ...without2fa(), mfa_enabled: true, mfa_recovery_codes: '[{"hash":"h"}]' });
    const res = await addKey(createSoftAuthenticator(), { code: RECOVERY });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(store.state.users.get('u1').mfa_recovery_codes, JSON.stringify([{ hash: 'h', usedAt: 'now' }]));
});

test('a key-only account that types a wrong code hears "invalid", not "your authenticator is unreadable"', async () => {
    store.state.users.set('u1', { ...without2fa(), mfa_enabled: true });
    const res = await post('/security-keys/registration/options', { code: '000000' });
    assert.equal(res.body.code, 'invalid_code');
});

// ── Proof while 2FA is on ──────────────────────────────────────────────────

test('with 2FA on, a key is added with an authenticator code and a touch', async () => {
    const authenticator = createSoftAuthenticator();
    const res = await addKey(authenticator);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.key.name, 'YubiKey 5C');
    assert.equal(res.body.key.rpId, 'beeflow.example');
    assert.equal(res.body.recoveryCodes, undefined);

    const [row] = store.state.keys;
    assert.equal(row.userId, 'u1');
    assert.equal(row.credentialId, authenticator.credentialId);
    assert.deepEqual(store.state.audit.map((a) => a.action), ['user.security_key_added']);
});

test('with 2FA on, adding a key without proof is refused and issues no challenge', async () => {
    const res = await post('/security-keys/registration/options', { name: 'Mine' });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'proof_required');
    assert.equal(session.current.securityKeyRegistration, undefined);
});

test('with 2FA on, a wrong code is refused', async () => {
    const res = await post('/security-keys/registration/options', { code: '000000' });
    assert.equal(res.body.code, 'invalid_code');
    assert.equal(session.current.securityKeyRegistration, undefined);
});

test('an unreadable authenticator secret is named as such', async () => {
    store.state.users.get('u1').mfa_secret = 'garbled';
    const res = await post('/security-keys/registration/options', { code: GOOD_CODE });
    assert.equal(res.body.code, 'mfa_secret_unreadable');
});

test('a key answer given as proof counts once', async () => {
    const first = createSoftAuthenticator();
    await addKey(first);
    const proof = await tapAsProof(first);
    assert.equal((await post('/security-keys/registration/options', proof)).status, 200);
    const replay = await post('/security-keys/registration/options', proof);
    assert.equal(replay.body.code, 'challenge_expired');
});

test('a proof tap from a key of another account is refused', async () => {
    const mine = createSoftAuthenticator();
    await addKey(mine);
    const proof = await tapAsProof(mine);
    proof.securityKey = createSoftAuthenticator().authenticate({ rpId: 'beeflow.example', challenge: 'x' }, { origin: ORIGIN });
    const res = await post('/security-keys/registration/options', proof);
    assert.equal(res.body.code, 'security_key_rejected');
});

test('no proof challenge when none of the keys works on this address', async () => {
    const res = await post('/security-keys/proof/options', {});
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'no_security_key_here');
});

test('a registration started without 2FA cannot finish after 2FA was turned on elsewhere', async () => {
    store.state.users.set('u1', without2fa());
    const started = await post('/security-keys/registration/options', {});
    store.state.users.get('u1').mfa_enabled = true; // another tab enabled the app
    const response = createSoftAuthenticator().register(started.body.options, { origin: ORIGIN });
    const res = await post('/security-keys/registration/verify', { response });
    assert.equal(res.body.code, 'proof_required');
    assert.equal(store.state.keys.length, 0);
});

// ── The ceremony itself ────────────────────────────────────────────────────

test('the list shows name and dates, never the credential id or public key', async () => {
    await addKey();
    const res = await app.request('GET', '/auth/mfa/security-keys');
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body.keys[0]).sort(), ['createdAt', 'id', 'lastUsedAt', 'name', 'rpId']);
});

test('a key added without a name gets a generic one', async () => {
    const res = await addKey(createSoftAuthenticator(), { code: GOOD_CODE }, '');
    assert.equal(res.body.key.name, 'Security key');
});

test('an origin outside the allow-list cannot start a registration', async () => {
    const res = await post('/security-keys/registration/options', { code: GOOD_CODE }, 'https://evil.test');
    assert.equal(res.body.code, 'webauthn_unavailable');
});

test('a registration answer without a challenge is refused', async () => {
    const response = createSoftAuthenticator().register({ rp: { id: 'beeflow.example' }, challenge: 'abc' }, { origin: ORIGIN });
    const res = await post('/security-keys/registration/verify', { response });
    assert.equal(res.body.code, 'registration_expired');
});

test('a registration challenge answers once', async () => {
    const started = await post('/security-keys/registration/options', { code: GOOD_CODE });
    const response = createSoftAuthenticator().register(started.body.options, { origin: ORIGIN });
    assert.equal((await post('/security-keys/registration/verify', { response })).status, 200);
    const replay = await post('/security-keys/registration/verify', { response });
    assert.equal(replay.body.code, 'registration_expired');
    assert.equal(store.state.keys.length, 1);
});

test('a registration finished on another allowed origin is refused', async () => {
    const started = await post('/security-keys/registration/options', { code: GOOD_CODE });
    const response = createSoftAuthenticator().register(started.body.options, { origin: ORIGIN });
    const res = await post('/security-keys/registration/verify', { response }, 'https://www.beeflow.example');
    assert.equal(res.body.code, 'webauthn_unavailable');
    assert.equal(store.state.keys.length, 0);
});

test('a registration the key signed for another origin is refused', async () => {
    const started = await post('/security-keys/registration/options', { code: GOOD_CODE });
    const response = createSoftAuthenticator().register(started.body.options, { origin: 'https://evil.test' });
    const res = await post('/security-keys/registration/verify', { response });
    assert.equal(res.body.code, 'security_key_rejected');
    assert.equal(store.state.keys.length, 0);
});

test('the same key twice is refused, not stored as a second row', async () => {
    const authenticator = createSoftAuthenticator();
    assert.equal((await addKey(authenticator)).status, 200);
    const again = await addKey(authenticator);
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'already_registered');
    assert.equal(store.state.keys.length, 1);
});

test(`a user can hold at most ${MAX_KEYS_PER_USER} keys`, async () => {
    for (let i = 0; i < MAX_KEYS_PER_USER; i++) {
        store.state.keys.push({ id: `k${i}`, userId: 'u1', credentialId: `c${i}`, rpId: 'beeflow.example', transports: [] });
    }
    const res = await post('/security-keys/registration/options', { code: GOOD_CODE });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'too_many_keys');
});

test('an anonymous caller gets nothing', async () => {
    session.current = {};
    assert.equal((await app.request('GET', '/auth/mfa/security-keys')).status, 401);
    assert.equal((await post('/security-keys/registration/options', {})).status, 401);
});

// ── Renaming and removing ──────────────────────────────────────────────────

test('a key can be renamed and removed by its owner; removal is audited', async () => {
    const { body } = await addKey();
    const id = body.key.id;
    const renamed = await app.request('PATCH', `/auth/mfa/security-keys/${id}`, { body: { name: 'Backup key' }, origin: ORIGIN });
    assert.equal(renamed.status, 200);
    assert.equal(store.state.keys[0].name, 'Backup key');

    const removed = await app.request('DELETE', `/auth/mfa/security-keys/${id}`, { origin: ORIGIN });
    assert.equal(removed.status, 200);
    assert.equal(store.state.keys.length, 0);
    assert.deepEqual(store.state.audit.map((a) => a.action), ['user.security_key_added', 'user.security_key_removed']);
});

test("the only key of an account without an app is its last factor, and stays", async () => {
    store.state.users.set('u1', without2fa());
    const { body } = await addKey(createSoftAuthenticator(), {});
    const res = await app.request('DELETE', `/auth/mfa/security-keys/${body.key.id}`, { origin: ORIGIN });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'last_factor');
    assert.equal(store.state.keys.length, 1);
});

test('one of two keys can go, even without an app', async () => {
    store.state.users.set('u1', without2fa());
    const first = createSoftAuthenticator();
    const { body } = await addKey(first, {});
    await addKey(createSoftAuthenticator(), await tapAsProof(first));
    const res = await app.request('DELETE', `/auth/mfa/security-keys/${body.key.id}`, { origin: ORIGIN });
    assert.equal(res.status, 200);
    assert.equal(store.state.keys.length, 1);
});

test("another user's key can be neither renamed nor removed", async () => {
    const { body } = await addKey();
    session.current = { user: { id: 'u2' } };
    const renamed = await app.request('PATCH', `/auth/mfa/security-keys/${body.key.id}`, { body: { name: 'Mine now' }, origin: ORIGIN });
    const removed = await app.request('DELETE', `/auth/mfa/security-keys/${body.key.id}`, { origin: ORIGIN });
    assert.equal(renamed.status, 404);
    assert.equal(removed.status, 404);
    assert.equal(store.state.keys[0].name, 'YubiKey 5C');
});

test('an empty name is refused', async () => {
    const { body } = await addKey();
    const res = await app.request('PATCH', `/auth/mfa/security-keys/${body.key.id}`, { body: { name: '   ' }, origin: ORIGIN });
    assert.equal(res.status, 400);
});
