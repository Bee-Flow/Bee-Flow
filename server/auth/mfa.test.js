/**
 * BFSF-274 — unit tests for the TOTP/recovery-code helpers in auth/mfa.js.
 *
 * configStore is stubbed via require.cache (its real module pulls the DB
 * pool); otplib/bcryptjs/qrcode run for real, so the ±1-step verification
 * window and the bcrypt recovery-code round-trip are tested against the
 * actual crypto, not mocks.
 *
 * Run: cd server && node --test auth/mfa.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

// Stub configStore BEFORE requiring ./mfa — reversible envelope for tests.
const configStorePath = require.resolve('../stores/configStore');
require.cache[configStorePath] = {
    id: configStorePath,
    filename: configStorePath,
    loaded: true,
    exports: {
        encryptValue: (v) => `enc:${v}`,
        decryptValue: (s) => (typeof s === 'string' && s.startsWith('enc:') ? s.slice(4) : null),
    },
};

const mfa = require('./mfa');
const { authenticator } = require('otplib');

test('verifyTotp accepts the current code and ±1 step (30s drift), rejects ±3 steps', () => {
    const secret = mfa.generateSecret();

    // Isolated clone (keeps the crypto plugins) so epoch overrides never
    // leak into the module singleton mfa.js configured with window:1.
    const at = (offsetMs) => authenticator.clone({ epoch: Date.now() + offsetMs }).generate(secret);

    assert.strictEqual(mfa.verifyTotp(secret, at(0)), true, 'current step accepted');
    assert.strictEqual(mfa.verifyTotp(secret, at(-30_000)), true, 'previous step accepted (clock drift)');
    assert.strictEqual(mfa.verifyTotp(secret, at(30_000)), true, 'next step accepted (clock drift)');
    assert.strictEqual(mfa.verifyTotp(secret, at(-90_000)), false, '3 steps back rejected');
    assert.strictEqual(mfa.verifyTotp(secret, at(90_000)), false, '3 steps ahead rejected');
});

test('verifyTotp hard-rejects null secrets and malformed tokens', () => {
    const secret = mfa.generateSecret();
    assert.strictEqual(mfa.verifyTotp(null, '123456'), false, 'null secret (undecryptable) never verifies');
    assert.strictEqual(mfa.verifyTotp(secret, null), false);
    assert.strictEqual(mfa.verifyTotp(secret, 'abc123'), false, 'non-numeric rejected');
    assert.strictEqual(mfa.verifyTotp(secret, '12345'), false, '5 digits rejected');
    // Whitespace inside an otherwise-valid code is tolerated.
    const tok = authenticator.clone().generate(secret);
    assert.strictEqual(mfa.verifyTotp(secret, ` ${tok.slice(0, 3)} ${tok.slice(3)} `), true);
});

test('recovery codes: full round-trip, single use, dash/whitespace tolerant', async () => {
    const { plain, stored } = await mfa.generateRecoveryCodes(4);
    assert.strictEqual(plain.length, 4);
    assert.strictEqual(mfa.remainingRecoveryCodes(JSON.stringify(stored)), 4);

    // Consume with the dash kept and surrounding whitespace.
    const updated = await mfa.consumeRecoveryCode(JSON.stringify(stored), ` ${plain[0]} `);
    assert.ok(updated, 'valid code consumes');
    assert.strictEqual(updated.filter(c => c.usedAt).length, 1, 'exactly one entry marked used');
    assert.strictEqual(mfa.remainingRecoveryCodes(JSON.stringify(updated)), 3);

    // Reuse of the same code is rejected.
    const reuse = await mfa.consumeRecoveryCode(JSON.stringify(updated), plain[0]);
    assert.strictEqual(reuse, null, 'consumed code cannot be reused');

    // A different code (without its dash) still works.
    const second = await mfa.consumeRecoveryCode(JSON.stringify(updated), plain[1].replace('-', ''));
    assert.ok(second, 'dash-less entry accepted');

    // Garbage never matches.
    assert.strictEqual(await mfa.consumeRecoveryCode(JSON.stringify(stored), 'nope-nope'), null);
    assert.strictEqual(await mfa.consumeRecoveryCode(JSON.stringify(stored), ''), null);
});

test('encrypt/decrypt secret round-trips through the configStore envelope', () => {
    const secret = mfa.generateSecret();
    const sealed = mfa.encryptSecret(secret);
    assert.notStrictEqual(sealed, secret);
    assert.strictEqual(mfa.decryptSecret(sealed), secret);
    assert.strictEqual(mfa.decryptSecret(null), null);
    // An envelope the store can't decrypt (key rotation) yields null — the
    // routes turn that into the mfa_secret_unreadable flow.
    assert.strictEqual(mfa.decryptSecret('garbage-envelope'), null);
});
