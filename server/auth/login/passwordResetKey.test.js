// @typecheck
/**
 * keyMaterialForReset with fakes for the policy, the escrow and the primitives:
 * which key material an e-mailed password reset writes next to the new hash.
 *
 * Run: cd server && node --test auth/login/passwordResetKey.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { keyMaterialForReset } = require('./passwordResetKey.mts');
const { wrapDEK, unwrapDEK, secureClear, SALT_LENGTH } = require('../encryptionPrimitives');

const DEK = crypto.randomBytes(32);

/** A fast stand-in for Argon2: the KEK is a hash of password and salt, deterministic for the round trip. */
const fakeDeriveKEK = async (/** @type {string} */ password, /** @type {Buffer} */ salt) =>
    crypto.createHash('sha256').update(password).update(salt).digest();

/** @param {{ tier?: string, escrowOpens?: boolean }} [o] */
function deps({ tier = 'managed', escrowOpens = true } = {}) {
    const calls = { unwrap: 0, cleared: 0 };
    return {
        calls,
        resolvePolicy: async () => ({ tier }),
        unwrapEscrowedDek: async (/** @type {string} */ stored, /** @type {string | null | undefined} */ orgId, /** @type {string} */ userId) => {
            calls.unwrap++;
            assert.equal(stored, 'escrow-envelope');
            assert.equal(orgId, 'org-1');
            assert.equal(userId, 'u1');
            return escrowOpens ? Buffer.from(DEK) : null;
        },
        deriveKEK: fakeDeriveKEK,
        wrapDEK,
        secureClear: (/** @type {Buffer} */ b) => { calls.cleared++; secureClear(b); },
        randomBytes: crypto.randomBytes,
        saltLength: SALT_LENGTH,
    };
}

const user = { id: 'u1', organizationId: 'org-1', wrappedDEK: '{"old":"wrapping"}', orgWrappedDEK: 'escrow-envelope' };

test('managed with an escrow: the same DEK is wrapped under the new password, salt and envelope fresh', async () => {
    const d = deps();
    const material = await keyMaterialForReset(user, 'New-pass-1', d);
    assert.ok(material);
    assert.equal(material.contentKept, true);
    assert.ok(material.kekSalt && Buffer.from(material.kekSalt, 'base64').length === SALT_LENGTH);
    const kek = await fakeDeriveKEK('New-pass-1', Buffer.from(material.kekSalt, 'base64'));
    const opened = unwrapDEK(JSON.parse(/** @type {string} */ (material.wrappedDEK)), kek, 'dek-wrap:u1');
    assert.ok(opened && opened.equals(DEK), 'the new wrapping opens to the escrowed DEK');
    assert.equal(unwrapDEK(JSON.parse(/** @type {string} */ (material.wrappedDEK)), await fakeDeriveKEK('Old-pass-0', Buffer.from(material.kekSalt, 'base64')), 'dek-wrap:u1'), null);
    assert.equal(d.calls.cleared, 2, 'the KEK and the DEK are cleared');
});

test('managed without an escrow yet: the wrapping is dropped and the content counts as kept', async () => {
    const d = deps();
    const material = await keyMaterialForReset({ ...user, orgWrappedDEK: null }, 'New-pass-1', d);
    assert.deepEqual(material, { kekSalt: null, wrappedDEK: null, contentKept: true });
    assert.equal(d.calls.unwrap, 0);
});

test('zero-knowledge: the wrapping is dropped, the escrow is never consulted, the content is not kept', async () => {
    const d = deps({ tier: 'zk' });
    const material = await keyMaterialForReset(user, 'New-pass-1', d);
    assert.deepEqual(material, { kekSalt: null, wrappedDEK: null, contentKept: false });
    assert.equal(d.calls.unwrap, 0, 'on zk the org-held key must never become the sign-in key');
});

test('tier none with a leftover wrapping: dropped like zk', async () => {
    assert.deepEqual(await keyMaterialForReset(user, 'New-pass-1', deps({ tier: 'none' })), { kekSalt: null, wrappedDEK: null, contentKept: false });
});

test('an account without a password-wrapped key: nothing to write', async () => {
    assert.equal(await keyMaterialForReset({ id: 'u1', organizationId: 'org-1', wrappedDEK: null }, 'New-pass-1', deps()), null);
});

test('managed with an escrow that does not open: the reset is refused, no material', async () => {
    await assert.rejects(keyMaterialForReset(user, 'New-pass-1', deps({ escrowOpens: false })), /does not open/);
});
