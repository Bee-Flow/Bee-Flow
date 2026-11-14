// @typecheck
/**
 * POST /reset-password against the real router, the real user store, the real
 * org escrow and the real key primitives on PGlite: the account's encryption
 * key follows the new password. On the managed tier the escrowed DEK is wrapped
 * under it and the next sign-in opens the same key; on zero-knowledge the old
 * wrapping is dropped, the response says so, and the next sign-in makes a
 * fresh key. On no tier does the reset leave a key the new password cannot open.
 *
 * Run: cd server && node --test auth/login/passwordResetRoutes.key.pg.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';
process.env.MASTER_ENCRYPTION_KEY ??= 'ci-master-encryption-key-for-tests-only!!';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { usePglitePool } = require('../../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const { initDB } = require('../../stores/user/schema');
const { createUserDEK, unlockUserDEK, getOrCreateUserDEKCompat } = require('../encryption');
const orgEscrow = require('../orgEscrow');
const router = require('./passwordResetRoutes');
const { dispatcher } = require('../../testUtils/routeHarness');

const dispatch = dispatcher(router, { session: () => ({ user: null }) });
const sha256 = (/** @type {string} */ s) => crypto.createHash('sha256').update(s).digest('hex');
const OLD_PW = 'Birch-tunnel-3381!';
const NEW_PW = 'Velvet-signal-7745!';

before(async () => {
    await initDB();
    for (const [id, tier] of [['org-managed', 'managed'], ['org-zk', 'zk']]) {
        await pg.query('INSERT INTO organizations (id, name, encryption_tier) VALUES ($1, $1, $2)', [id, tier]);
    }
}, { timeout: 120_000 });
after(close);

/**
 * A password account in `orgId` that signed in once with OLD_PW (so it holds a
 * DEK wrapped under it) and now holds a reset token. Returns the DEK bytes.
 * @param {string} id @param {string} orgId @param {{ escrow?: boolean, failures?: number }} [o]
 */
async function account(id, orgId, { escrow = false, failures = 0 } = {}) {
    await pg.query(
        `INSERT INTO users (id, username, email, "organizationId", "passwordHash", "dekUnwrapFailures", "dekLockoutUntil",
                            password_reset_token_hash, password_reset_expires_at)
         VALUES ($1, $1, $2, $3, 'hash-of-the-old-password', $4, $5, $6, $7)`,
        [id, `${id}@example.test`, orgId, failures, failures ? new Date(Date.now() + 3600_000).toISOString() : null,
            sha256(`token-${id}`), new Date(Date.now() + 3600_000)],
    );
    const { dek } = await createUserDEK(id, OLD_PW);
    if (escrow) {
        // What the first encrypted write does on managed: the escrow adopts the sign-in key.
        const adopted = await orgEscrow.getOrCreateUserDek(id, orgId, { seedDek: dek });
        assert.ok(adopted.equals(dek));
    }
    return dek;
}
const row = async (/** @type {string} */ id) => (await pg.query('SELECT * FROM users WHERE id = $1', [id])).rows[0];
const reset = (/** @type {string} */ id) => dispatch({ method: 'POST', url: '/reset-password', body: { token: `token-${id}`, newPassword: NEW_PW }, session: undefined });

test('managed: after the reset the new password opens the same DEK, the old one does not, and the escrow is unchanged', { timeout: 60_000 }, async () => {
    const dek = await account('mia', 'org-managed', { escrow: true, failures: 20 });
    const escrowBefore = (await row('mia')).orgWrappedDEK;

    const res = await reset('mia');
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, { success: true }, 'nothing was lost, so nothing to announce');

    const u = await row('mia');
    assert.equal(u.orgWrappedDEK, escrowBefore);
    assert.equal(u.dekUnwrapFailures, 0, 'the hard lockout reached with the old password is lifted');
    assert.equal(u.dekLockoutUntil, null);

    const opened = await unlockUserDEK('mia', NEW_PW);
    assert.ok(opened && opened.equals(dek), 'the new password opens the DEK the content was written under');
    assert.equal(await unlockUserDEK('mia', OLD_PW), null);

    // The sign-in path (finalizeLogin → prepareLoginDek): the same key, no new recovery key.
    const signIn = await getOrCreateUserDEKCompat('mia', NEW_PW);
    assert.ok(signIn);
    assert.equal(signIn.encryptionKey, dek.toString('base64'));
    assert.equal(signIn.recoveryKey, undefined);
    const stillEscrowed = await orgEscrow.getOrCreateUserDek('mia', 'org-managed');
    assert.ok(stillEscrowed.equals(dek));
});

test('managed without an escrow yet: the sign-in with the new password creates the key, as a first sign-in does', { timeout: 60_000 }, async () => {
    await account('noah', 'org-managed');
    const res = await reset('noah');
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, { success: true });
    const u = await row('noah');
    assert.equal(u.wrappedDEK, null);
    assert.equal(u.kekSalt, null);
    const signIn = await getOrCreateUserDEKCompat('noah', NEW_PW);
    assert.ok(signIn && signIn.encryptionKey, 'the sign-in is not refused');
});

test('zero-knowledge: the old wrapping is dropped, the response says the key was reset, and the new password signs in with a fresh key', { timeout: 60_000 }, async () => {
    const dek = await account('zoe', 'org-zk');
    const res = await reset('zoe');
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, { success: true, encryptionKeyReset: true });

    const u = await row('zoe');
    assert.equal(u.wrappedDEK, null);
    assert.equal(u.kekSalt, null);
    assert.equal(u.passwordResetRequired, 0, 'the person chose this password themselves');

    const signIn = await getOrCreateUserDEKCompat('zoe', NEW_PW);
    assert.ok(signIn && signIn.encryptionKey, 'never a refused sign-in');
    assert.notEqual(signIn.encryptionKey, dek.toString('base64'), 'a fresh key: the old content is closed, as the response said');
    assert.ok(signIn.recoveryKey, 'shown once, like at a first sign-in');
});

test('a reset link is still spent by the write that carries the key material', { timeout: 60_000 }, async () => {
    await account('eli', 'org-managed', { escrow: true });
    assert.equal((await reset('eli')).statusCode, 200);
    assert.equal((await reset('eli')).statusCode, 400);
});
