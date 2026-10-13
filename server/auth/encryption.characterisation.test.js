/**
 * Characterisation test for the zero-knowledge encryption module
 * (auth/encryption.js and the modules behind it).
 *
 * Pins the golden behaviour before and after the module was split:
 *   - crypto vectors (Argon2id KEK, envelope wrap/unwrap in base64 and hex,
 *     recovery-key format, DEK fingerprint, fallback key);
 *   - the ORDER of the gates in every unlock path (hard lockout, backoff,
 *     current params, legacy params, failure bookkeeping, success decay) as the
 *     sequence of userStore reads and writes they produce;
 *   - the legacy migrations (Argon2 params, PBKDF2 deterministic salt, master
 *     key past its deadline) and the SSO PIN setup guard.
 *
 * The fake userStore goes in through bindUserStore, the seam the barrel uses.
 * Run: node --test auth/encryption.characterisation.test.js
 */

process.env.NODE_ENV = 'test';
process.env.MASTER_ENCRYPTION_KEY = 'characterisation-master-key-0123456789';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const argon2 = require('argon2');

// ── fake userStore: an in-memory table plus a call log ─────────────────────
const users = new Map();
const calls = [];
const fakeUserStore = {
    async getUser(id) {
        calls.push(['get', id]);
        const u = users.get(id);
        return u ? { ...u } : null;
    },
    async updateUser(id, updates) {
        calls.push(['update', id, { ...updates }]);
        users.set(id, { ...(users.get(id) || {}), ...updates });
        return true;
    },
};
// The modules behind the auth/encryption.js barrel take the store through
// bindUserStore (the barrel binds the real one); the export surface of the
// barrel itself is pinned in encryption.test.js.
const primitives = require('./encryptionPrimitives');
const userDek = require('./encryptionUserDek');
const ssoDek = require('./encryptionSsoDek');
const compat = require('./encryptionCompat');
for (const m of [userDek, ssoDek, compat]) m.bindUserStore(fakeUserStore);
const enc = { ...primitives, ...userDek, ...ssoDek, ...compat };

beforeEach(() => {
    users.clear();
    calls.length = 0;
});

const updates = () => calls.filter(c => c[0] === 'update').map(c => c[2]);
const legacyKEK = (pw, salt) => argon2.hash(pw, {
    type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4, hashLength: 32, raw: true,
    salt: Buffer.from(salt, 'base64'),
});
const pinKEK = (pin, salt) => argon2.hash(pin, {
    type: argon2.argon2id, memoryCost: 131072, timeCost: 5, parallelism: 4, hashLength: 32, raw: true,
    salt: Buffer.from(salt, 'base64'),
});
const pbkdf2Legacy = (pw, userId) => crypto.pbkdf2Sync(pw, `beeflow-kek-${userId}`, 100000, 32, 'sha256');

// ── crypto vectors ─────────────────────────────────────────────────────────

test('deriveKEK: Argon2id 128 MiB / t=4 / p=4 vector', async () => {
    const kek = await enc.deriveKEK('correct horse battery', Buffer.alloc(32, 7));
    assert.equal(kek.toString('hex'), 'bc25bccc810c881f8041739eb5b34acbb2bc4a1a9bd87cdd59d6dc92fdd579c8');
    const fromB64 = await enc.deriveKEK('correct horse battery', Buffer.alloc(32, 7).toString('base64'));
    assert.ok(fromB64.equals(kek));
});

test('deriveKEK rejects an empty secret and a wrong salt length', async () => {
    await assert.rejects(enc.deriveKEK('', Buffer.alloc(32)), /Password\/PIN cannot be empty/);
    await assert.rejects(enc.deriveKEK('x', Buffer.alloc(16)), /Invalid salt length: expected 32, got 16/);
});

test('wrapDEK writes a base64 envelope that plain AES-256-GCM with the AAD opens', () => {
    const key = Buffer.alloc(32, 3);
    const dek = Buffer.alloc(32, 9);
    const env = enc.wrapDEK(dek, key, 'dek-wrap:u');
    assert.deepEqual(Object.keys(env), ['enc', 'iv', 'authTag', 'data']);
    assert.equal(env.enc, 'base64');
    assert.equal(Buffer.from(env.iv, 'base64').length, 12);
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
    d.setAAD(Buffer.from('dek-wrap:u'));
    d.setAuthTag(Buffer.from(env.authTag, 'base64'));
    assert.ok(Buffer.concat([d.update(Buffer.from(env.data, 'base64')), d.final()]).equals(dek));
});

test('unwrapDEK opens fixed hex, base64 and unmarked envelopes; null on wrong key/AAD', () => {
    const key = Buffer.alloc(32, 5);
    const dek = Buffer.alloc(32, 0xab);
    const iv = Buffer.alloc(12, 1);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    c.setAAD(Buffer.from('ctx'));
    const data = Buffer.concat([c.update(dek), c.final()]);
    const tag = c.getAuthTag();
    const hex = { iv: iv.toString('hex'), authTag: tag.toString('hex'), data: data.toString('hex') };
    const b64 = { iv: iv.toString('base64'), authTag: tag.toString('base64'), data: data.toString('base64') };
    assert.equal(enc.envelopeEncoding(hex), 'hex');
    assert.equal(enc.envelopeEncoding(b64), 'base64');
    assert.equal(enc.envelopeEncoding({ enc: 'hex', iv: 'zz' }), 'hex');
    assert.equal(enc.envelopeEncoding(undefined), 'base64');
    assert.ok(enc.unwrapDEK(hex, key, 'ctx').equals(dek));
    assert.ok(enc.unwrapDEK(b64, key, 'ctx').equals(dek));
    assert.ok(enc.unwrapDEK({ enc: 'hex', ...hex }, key, Buffer.from('ctx')).equals(dek));
    assert.equal(enc.unwrapDEK(b64, Buffer.alloc(32, 6), 'ctx'), null);
    assert.equal(enc.unwrapDEK(b64, key, 'other'), null);
    assert.equal(enc.unwrapDEK({ iv: 'AAAA', authTag: '', data: '' }, key, 'ctx'), null);
});

test('recovery key format, parse, fingerprint and fallback key vectors', () => {
    assert.equal(enc.MIN_ENCRYPTION_PIN_LENGTH, 6);
    const raw = Buffer.from([...Array(32).keys()]);
    const formatted = enc.formatRecoveryKey(raw);
    assert.equal(formatted, '00010203-04050607-08090A0B-0C0D0E0F-10111213-14151617-18191A1B-1C1D1E1F');
    assert.ok(enc.parseRecoveryKey(formatted.toLowerCase().replace(/-/g, ' - ')).equals(raw));
    assert.throws(() => enc.parseRecoveryKey('ABCD-1234'), /Invalid recovery key format/);
    assert.equal(enc.dekFingerprint(Buffer.alloc(32, 1), 'user-1'), 'HH1N4W3i6LAyprZfkB7MjvRRsFlbIKJSB9nDoiPuvPo=');
    assert.equal(enc.getFallbackEncryptionKey('user-1'), 'Jjw6frKClkSTHMYDggR03EUQLg3DHK1xDMQbAEJK3IQ=');
    const saved = process.env.MASTER_ENCRYPTION_KEY;
    delete process.env.MASTER_ENCRYPTION_KEY;
    try {
        assert.throws(() => enc.getFallbackEncryptionKey('user-1'), /MASTER_ENCRYPTION_KEY env var is required/);
    } finally { process.env.MASTER_ENCRYPTION_KEY = saved; }
    const b = Buffer.alloc(8, 0xff);
    enc.secureClear(b);
    assert.ok(b.equals(Buffer.alloc(8)));
    enc.secureClear('not a buffer'); // ignored
    assert.throws(() => enc.validateEncryptionPin('12345'), /at least 6 characters/);
    enc.validateEncryptionPin('123456');
});

// ── password users: create, unlock gates, recovery, rewrap ─────────────────

test('createUserDEK writes salts, both envelopes and clears masterWrappedDEK; password and recovery key open it', async () => {
    const { dek, recoveryKey } = await enc.createUserDEK('u1', 'pw-one');
    assert.equal(dek.length, 32);
    assert.match(recoveryKey, /^([0-9A-F]{8}-){7}[0-9A-F]{8}$/);
    assert.deepEqual(calls.map(c => c[0]), ['update']);
    assert.deepEqual(Object.keys(updates()[0]), ['kekSalt', 'recoverySalt', 'wrappedDEK', 'recoveryWrappedDEK', 'masterWrappedDEK']);
    assert.equal(updates()[0].masterWrappedDEK, null);
    const u = users.get('u1');
    const kek = await enc.deriveKEK('pw-one', u.kekSalt);
    assert.ok(enc.unwrapDEK(u.wrappedDEK, kek, 'dek-wrap:u1').equals(dek));
    const rk = await enc.deriveKEK(enc.parseRecoveryKey(recoveryKey), u.recoverySalt);
    assert.ok(enc.unwrapDEK(u.recoveryWrappedDEK, rk, 'dek-recovery:u1').equals(dek));
});

test('unlockUserDEK gates: missing record, hard lockout, active backoff — no derivation, no write', async () => {
    assert.equal(await enc.unlockUserDEK('nobody', 'x'), null);
    users.set('h', { wrappedDEK: {}, kekSalt: Buffer.alloc(32).toString('base64'), dekUnwrapFailures: 20 });
    assert.equal(await enc.unlockUserDEK('h', 'x'), null);
    users.set('b', {
        wrappedDEK: {}, kekSalt: Buffer.alloc(32).toString('base64'), dekUnwrapFailures: 3,
        dekLockoutUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.equal(await enc.unlockUserDEK('b', 'x'), null);
    assert.deepEqual(calls, [['get', 'nobody'], ['get', 'h'], ['get', 'b']]);
});

test('unlockUserDEK: wrong password counts a failure with 2^n s backoff; right password decays it', async () => {
    const { dek } = await enc.createUserDEK('u2', 'right');
    calls.length = 0;
    const before = Date.now();
    assert.equal(await enc.unlockUserDEK('u2', 'wrong'), null);
    const [fail] = updates();
    assert.deepEqual(Object.keys(fail), ['dekUnwrapFailures', 'dekLockoutUntil']);
    assert.equal(fail.dekUnwrapFailures, 1);
    const until = new Date(fail.dekLockoutUntil).getTime() - before;
    assert.ok(until >= 2000 && until < 12000, `backoff ${until}`);
    // expired backoff at 3 failures: the attempt goes through and decays by one
    users.get('u2').dekUnwrapFailures = 3;
    users.get('u2').dekLockoutUntil = new Date(Date.now() - 1000).toISOString();
    calls.length = 0;
    const got = await enc.unlockUserDEK('u2', 'right');
    assert.ok(got.equals(dek));
    assert.deepEqual(updates(), [{ dekUnwrapFailures: 2, dekLockoutUntil: null }]);
});

test('unlockUserDEK: a DEK wrapped with the legacy Argon2 params unlocks and is re-wrapped', async () => {
    const dek = crypto.randomBytes(32);
    const salt = crypto.randomBytes(32).toString('base64');
    users.set('lg', { kekSalt: salt, wrappedDEK: enc.wrapDEK(dek, await legacyKEK('pw', salt), 'dek-wrap:lg') });
    const got = await enc.unlockUserDEK('lg', 'pw');
    assert.ok(got.equals(dek));
    assert.deepEqual(calls.map(c => c[0]), ['get', 'update']);
    assert.deepEqual(Object.keys(updates()[0]), ['wrappedDEK']);
    const now = await enc.deriveKEK('pw', salt);
    assert.ok(enc.unwrapDEK(users.get('lg').wrappedDEK, now, 'dek-wrap:lg').equals(dek));
});

test('unlockWithRecoveryKey: lockouts and a malformed key never derive or write', async () => {
    users.set('r', { recoveryWrappedDEK: {}, recoverySalt: 'x', recoveryUnwrapFailures: 10 });
    assert.equal(await enc.unlockWithRecoveryKey('r', 'whatever'), null);
    users.set('r', {
        recoveryWrappedDEK: {}, recoverySalt: 'x', recoveryUnwrapFailures: 3,
        recoveryLockoutUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.equal(await enc.unlockWithRecoveryKey('r', 'whatever'), null);
    users.set('r', { recoveryWrappedDEK: {}, recoverySalt: 'x' });
    assert.equal(await enc.unlockWithRecoveryKey('r', 'not-a-key'), null);
    assert.deepEqual(calls.map(c => c[0]), ['get', 'get', 'get']);
});

test('unlockWithRecoveryKey: wrong key counts, right key decays; rotate and rewrap', async () => {
    const { dek, recoveryKey } = await enc.createUserDEK('rk', 'pw');
    calls.length = 0;
    const wrong = enc.formatRecoveryKey(Buffer.alloc(32, 1));
    assert.equal(await enc.unlockWithRecoveryKey('rk', wrong), null);
    assert.deepEqual(Object.keys(updates()[0]), ['recoveryUnwrapFailures', 'recoveryLockoutUntil']);
    assert.equal(updates()[0].recoveryUnwrapFailures, 1);
    calls.length = 0;
    assert.ok((await enc.unlockWithRecoveryKey('rk', recoveryKey)).equals(dek));
    assert.deepEqual(updates(), [{ recoveryUnwrapFailures: 0, recoveryLockoutUntil: null }]);

    calls.length = 0;
    const newKey = await enc.rotateRecoveryKey('rk', dek);
    assert.deepEqual(Object.keys(updates()[0]), ['recoverySalt', 'recoveryWrappedDEK']);
    assert.notEqual(newKey, recoveryKey);
    assert.ok((await enc.unlockWithRecoveryKey('rk', newKey)).equals(dek));

    calls.length = 0;
    assert.equal(await enc.rewrapUserDEK('rk', dek, 'pw2'), true);
    assert.deepEqual(Object.keys(updates()[0]), ['kekSalt', 'wrappedDEK']);
    assert.ok((await enc.unlockUserDEK('rk', 'pw2')).equals(dek));
});

test('adminResetUser wipes the password envelope and keeps the recovery one', async () => {
    assert.equal(await enc.adminResetUser('a'), true);
    assert.deepEqual(calls, [['update', 'a', {
        wrappedDEK: null, kekSalt: null, passwordResetRequired: 1, dekUnwrapFailures: 0, dekLockoutUntil: null,
    }]]);
});

// ── SSO PIN users ──────────────────────────────────────────────────────────

test('setupSSOUserDEK: PIN check first, then the already-set-up guard', async () => {
    await assert.rejects(enc.setupSSOUserDEK('s', '123'), /at least 6 characters/);
    assert.deepEqual(calls, []);
    users.set('s', { ssoEncryptionSetup: 1, wrappedDEK: { iv: 'x' } });
    await assert.rejects(enc.setupSSOUserDEK('s', '123456'), err => err.code === 'ENCRYPTION_ALREADY_SET_UP');
    assert.deepEqual(calls, [['get', 's']]);
});

test('setupSSOUserDEK fresh: key write, then the setup flag; PIN uses t=5 Argon2', async () => {
    const { dek, recoveryKey } = await enc.setupSSOUserDEK('s1', 'pin-123456');
    assert.deepEqual(calls.map(c => c[0]), ['get', 'update', 'update']);
    assert.deepEqual(Object.keys(updates()[0]), ['kekSalt', 'recoverySalt', 'wrappedDEK', 'recoveryWrappedDEK', 'masterWrappedDEK']);
    assert.deepEqual(updates()[1], { ssoEncryptionSetup: 1 });
    const u = users.get('s1');
    assert.ok(enc.unwrapDEK(u.wrappedDEK, await pinKEK('pin-123456', u.kekSalt), 'dek-wrap:s1').equals(dek));
    assert.ok((await enc.unlockWithRecoveryKey('s1', recoveryKey)).equals(dek));
});

test('setupSSOUserDEK with an existing DEK: no read, re-wrap, returns a copy', async () => {
    const existing = crypto.randomBytes(32);
    const { dek, recoveryKey } = await enc.setupSSOUserDEK('s2', 'pin-123456', existing);
    assert.notEqual(dek, existing);
    assert.ok(dek.equals(existing));
    assert.deepEqual(calls.map(c => c[0]), ['update', 'update']);
    assert.deepEqual(Object.keys(updates()[0]), ['wrappedDEK', 'kekSalt', 'recoverySalt', 'recoveryWrappedDEK', 'masterWrappedDEK']);
    assert.deepEqual(updates()[1], { ssoEncryptionSetup: 1 });
    assert.match(recoveryKey, /^([0-9A-F]{8}-){7}[0-9A-F]{8}$/);
    const r = await enc.unlockSSOUserDEK('s2', 'pin-123456');
    assert.ok(r.dek.equals(existing));
});

test('unlockSSOUserDEK gates: needsSetup, hard lockout, backoff, wrong PIN, success decay', async () => {
    assert.deepEqual(await enc.unlockSSOUserDEK('none', 'x'), { needsSetup: true });
    users.set('n', { ssoEncryptionSetup: 1 });
    assert.deepEqual(await enc.unlockSSOUserDEK('n', 'x'), { needsSetup: true });
    users.set('h', { ssoEncryptionSetup: 1, wrappedDEK: {}, kekSalt: 'x', dekUnwrapFailures: 20 });
    assert.deepEqual(await enc.unlockSSOUserDEK('h', 'x'), { wrongPin: true });
    users.set('b', {
        ssoEncryptionSetup: 1, wrappedDEK: {}, kekSalt: 'x', dekUnwrapFailures: 4,
        dekLockoutUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.deepEqual(await enc.unlockSSOUserDEK('b', 'x'), { wrongPin: true });
    assert.deepEqual(calls.map(c => c[0]), ['get', 'get', 'get', 'get']);

    const { dek } = await enc.setupSSOUserDEK('p', 'pin-123456');
    calls.length = 0;
    assert.deepEqual(await enc.unlockSSOUserDEK('p', 'pin-000000'), { wrongPin: true });
    assert.equal(updates()[0].dekUnwrapFailures, 1);
    calls.length = 0;
    const ok = await enc.unlockSSOUserDEK('p', 'pin-123456');
    assert.deepEqual(Object.keys(ok), ['dek']);
    assert.ok(ok.dek.equals(dek));
    assert.deepEqual(updates(), [{ dekUnwrapFailures: 0, dekLockoutUntil: null }]);
});

test('unlockSSOUserDEK: a PIN wrapped with legacy params unlocks and is re-wrapped at PIN strength', async () => {
    const dek = crypto.randomBytes(32);
    const salt = crypto.randomBytes(32).toString('base64');
    users.set('lp', { ssoEncryptionSetup: 1, kekSalt: salt, wrappedDEK: enc.wrapDEK(dek, await legacyKEK('pin-123456', salt), 'dek-wrap:lp') });
    const r = await enc.unlockSSOUserDEK('lp', 'pin-123456');
    assert.ok(r.dek.equals(dek));
    assert.deepEqual(Object.keys(updates()[0]), ['wrappedDEK']);
    assert.ok(enc.unwrapDEK(users.get('lp').wrappedDEK, await pinKEK('pin-123456', salt), 'dek-wrap:lp').equals(dek));
});

// ── backward-compatible wrappers ───────────────────────────────────────────

test('getOrCreateSSOUserDEKCompat branches (master key past its 2026-06-01 deadline)', async () => {
    assert.deepEqual(await enc.getOrCreateSSOUserDEKCompat('x', false), {});
    assert.deepEqual(calls, []);
    users.set('set', { ssoEncryptionSetup: 1 });
    assert.deepEqual(await enc.getOrCreateSSOUserDEKCompat('set'), { needsEncryptionPin: true });
    users.set('mw', { masterWrappedDEK: { iv: 'x' } });
    assert.deepEqual(await enc.getOrCreateSSOUserDEKCompat('mw'), { needsEncryptionSetup: true });
    assert.deepEqual(await enc.getOrCreateSSOUserDEKCompat('none'), { needsEncryptionSetup: true });
    assert.deepEqual(calls.map(c => c[0]), ['get', 'get', 'get']);
});

test('getOrCreateUserDEKCompat: new user, Argon2 user, wrong password', async () => {
    const created = await enc.getOrCreateUserDEKCompat('c1', 'pw');
    assert.deepEqual(Object.keys(created), ['encryptionKey', 'recoveryKey']);
    assert.deepEqual(calls.map(c => c[0]), ['get', 'update']);
    calls.length = 0;
    const again = await enc.getOrCreateUserDEKCompat('c1', 'pw');
    assert.deepEqual(again, { encryptionKey: created.encryptionKey });
    assert.equal(await enc.getOrCreateUserDEKCompat('c1', 'nope'), null);
});

test('getOrCreateUserDEKCompat: PBKDF2 legacy envelope migrates to Argon2 with a recovery key', async () => {
    const dek = crypto.randomBytes(32);
    users.set('pb', { wrappedDEK: enc.wrapDEK(dek, pbkdf2Legacy('pw', 'pb'), ''), masterWrappedDEK: { iv: 'old' } });
    const r = await enc.getOrCreateUserDEKCompat('pb', 'pw');
    assert.equal(r.encryptionKey, dek.toString('base64'));
    assert.deepEqual(calls.map(c => c[0]), ['get', 'update']);
    assert.deepEqual(Object.keys(updates()[0]), ['kekSalt', 'recoverySalt', 'wrappedDEK', 'recoveryWrappedDEK', 'masterWrappedDEK']);
    assert.ok((await enc.unlockUserDEK('pb', 'pw')).equals(dek));
    assert.ok((await enc.unlockWithRecoveryKey('pb', r.recoveryKey)).equals(dek));
    // PBKDF2 path with a wrong password and the master key expired: null, no write
    users.set('pb2', { wrappedDEK: enc.wrapDEK(dek, pbkdf2Legacy('pw', 'pb2'), ''), masterWrappedDEK: { iv: 'old' } });
    calls.length = 0;
    assert.equal(await enc.getOrCreateUserDEKCompat('pb2', 'bad'), null);
    assert.deepEqual(calls.map(c => c[0]), ['get']);
});

test('rewrapUserDEKCompat: no DEK, PBKDF2 legacy, wrong old password', async () => {
    assert.deepEqual(await enc.rewrapUserDEKCompat('none', 'a', 'b'), { success: true });
    const dek = crypto.randomBytes(32);
    users.set('rw', { wrappedDEK: enc.wrapDEK(dek, pbkdf2Legacy('old', 'rw'), '') });
    assert.deepEqual(await enc.rewrapUserDEKCompat('rw', 'bad', 'new'), { success: false });
    calls.length = 0;
    const r = await enc.rewrapUserDEKCompat('rw', 'old', 'new');
    assert.deepEqual(r, { success: true, encryptionKey: dek.toString('base64') });
    assert.deepEqual(calls.map(c => c[0]), ['get', 'update']);
    assert.ok((await enc.unlockUserDEK('rw', 'new')).equals(dek));
});
