// @typecheck noImplicitAny
/**
 * Zero-knowledge envelope encryption: SSO/OAuth users with an encryption PIN.
 *
 * First-login PIN setup (fresh DEK, or re-wrap of an existing DEK from the
 * legacy master-key migration, with the guard against re-keying an account
 * that already has one) and the PIN unlock with lockout and transparent
 * Argon2 param migration. The public surface is auth/encryption.js.
 */

const crypto = require('crypto');
const log = require('../telemetry/log');
const {
    SALT_LENGTH,
    DEK_LENGTH,
    RECOVERY_KEY_LENGTH,
    validateEncryptionPin,
    deriveKEK,
    deriveKEK_PIN,
    deriveKEK_LEGACY,
    wrapDEK,
    unwrapDEK,
    secureClear,
    formatRecoveryKey,
} = require('./encryptionPrimitives');

// stores/userStore is handed in by auth/encryption.js (bindUserStore), which
// owns the one require of it: this module stays out of the server's import
// cycle, and tests that stub '../stores/userStore' for the barrel reach it here
// too. Import the barrel, not this file.
/** @type {typeof import('../stores/userStore')} */
let userStore;
/** @param {typeof import('../stores/userStore')} store */
function bindUserStore(store) {
    userStore = store;
}

// ============================================================
// SSO/OAUTH USERS — ENCRYPTION PIN (Option A)
// ============================================================

/**
 * First SSO login: user chooses an encryption PIN.
 * If existingDEK is provided (from legacy master-key unlock), re-wraps that DEK
 * with the new PIN instead of generating a new one — preserving all encrypted data.
 * 
 * @param {string} userId
 * @param {string} encryptionPin - User-chosen PIN (min 6 chars)
 * @param {Buffer} [existingDEK] - Optional existing DEK to re-wrap (legacy migration)
 * @returns {Promise<{ dek: Buffer, recoveryKey: string }>}
 */
async function setupSSOUserDEK(userId, encryptionPin, existingDEK = null) {
    validateEncryptionPin(encryptionPin);

    // Refuse to re-key an account that already has a key.
    //
    // The `else` branch below mints a FRESH DEK and writes it over wrappedDEK
    // and recoveryWrappedDEK. For a genuine first-time user that is the whole
    // point; for a user who already completed setup it is silent, irreversible
    // data loss — every envelope written under the old key stops opening, and
    // the recovery key that could have rescued it is overwritten in the same
    // statement.
    //
    // Nothing should reach here in that state: the PIN-change and recovery
    // paths always pass an existingDEK, and first-time setup is gated on
    // needsEncryptionSetup. But "should" is doing far too much work when the
    // failure is unrecoverable, and a stale gate flag on a bridged session was
    // one live route to it. An error the user can report beats a database they
    // cannot get back.
    if (!existingDEK) {
        const existing = await userStore.getUser(userId);
        if (existing?.ssoEncryptionSetup && existing?.wrappedDEK) {
            const err = new Error(
                'Encryption is already set up for this account. Use PIN change or recovery-key rescue instead.',
            );
            err.code = 'ENCRYPTION_ALREADY_SET_UP';
            throw err;
        }
    }

    /** @type {{ dek: Buffer<ArrayBuffer>; recoveryKey: string; } | { dek: NonSharedBuffer; recoveryKey: string; }} */
    let result;
    if (existingDEK) {
        // Migration: re-wrap existing DEK with new PIN (higher Argon2 cost)
        const kekSalt = crypto.randomBytes(SALT_LENGTH);
        const kek = await deriveKEK_PIN(encryptionPin, kekSalt);
        const wrappedDEK = wrapDEK(existingDEK, kek, `dek-wrap:${userId}`);
        secureClear(kek);

        // Create recovery key
        const recoverySalt = crypto.randomBytes(SALT_LENGTH);
        const recoveryKeyRaw = crypto.randomBytes(RECOVERY_KEY_LENGTH);
        const recoveryKEK = await deriveKEK(recoveryKeyRaw, recoverySalt);
        const recoveryWrappedDEK = wrapDEK(existingDEK, recoveryKEK, `dek-recovery:${userId}`);
        secureClear(recoveryKEK);

        await userStore.updateUser(userId, {
            wrappedDEK,
            kekSalt: kekSalt.toString('base64'),
            recoverySalt: recoverySalt.toString('base64'),
            recoveryWrappedDEK,
            masterWrappedDEK: null
        });

        const recoveryKey = formatRecoveryKey(recoveryKeyRaw);
        secureClear(recoveryKeyRaw);

        result = { dek: Buffer.from(existingDEK), recoveryKey };
    } else {
        // New user: generate fresh DEK (uses PIN-strength Argon2)
        const dek = crypto.randomBytes(DEK_LENGTH);
        const kekSalt = crypto.randomBytes(SALT_LENGTH);
        const recoverySalt = crypto.randomBytes(SALT_LENGTH);
        const recoveryKeyRaw = crypto.randomBytes(RECOVERY_KEY_LENGTH);

        const kek = await deriveKEK_PIN(encryptionPin, kekSalt);
        const wrappedDEK = wrapDEK(dek, kek, `dek-wrap:${userId}`);

        const recoveryKEK = await deriveKEK(recoveryKeyRaw, recoverySalt);
        const recoveryWrappedDEK = wrapDEK(dek, recoveryKEK, `dek-recovery:${userId}`);

        await userStore.updateUser(userId, {
            kekSalt: kekSalt.toString('base64'),
            recoverySalt: recoverySalt.toString('base64'),
            wrappedDEK,
            recoveryWrappedDEK,
            masterWrappedDEK: null
        });

        const recoveryKey = formatRecoveryKey(recoveryKeyRaw);
        secureClear(kek);
        secureClear(recoveryKEK);
        secureClear(recoveryKeyRaw);

        result = { dek, recoveryKey };
    }

    // Mark SSO encryption as set up
    await userStore.updateUser(userId, { ssoEncryptionSetup: 1 });

    return result;
}

/**
 * Returning SSO login: unlock DEK with encryption PIN.
 * 
 * @param {string} userId
 * @param {string} encryptionPin
 * @returns {Promise<{ dek?: Buffer, needsSetup?: true, wrongPin?: true }>} exactly one of the three is set
 */
async function unlockSSOUserDEK(userId, encryptionPin) {
    const user = await userStore.getUser(userId);

    if (!user?.ssoEncryptionSetup) {
        return { needsSetup: true };
    }

    if (!user?.wrappedDEK || !user?.kekSalt) return { needsSetup: true };

    const failures = user.dekUnwrapFailures || 0;
    if (failures >= 20) return { wrongPin: true };
    if (failures >= 3) {
        const lockoutEnd = user.dekLockoutUntil ? new Date(user.dekLockoutUntil).getTime() : 0;
        if (Date.now() < lockoutEnd) return { wrongPin: true };
    }

    // Try PIN-strength params first
    let kek = await deriveKEK_PIN(encryptionPin, user.kekSalt);
    let dek = unwrapDEK(user.wrappedDEK, kek, `dek-wrap:${userId}`);
    secureClear(kek);

    // Fallback: try legacy params (PINs were originally wrapped with deriveKEK at 64MB/3)
    if (!dek) {
        kek = await deriveKEK_LEGACY(encryptionPin, user.kekSalt);
        dek = unwrapDEK(user.wrappedDEK, kek, `dek-wrap:${userId}`);
        secureClear(kek);

        if (dek) {
            // Transparent migration: re-wrap with new PIN-strength params
            log.info(`[Auth] Migrating SSO PIN Argon2 params for user ${userId}`);
            const newKEK = await deriveKEK_PIN(encryptionPin, user.kekSalt);
            const newWrapped = wrapDEK(dek, newKEK, `dek-wrap:${userId}`);
            secureClear(newKEK);
            await userStore.updateUser(userId, { wrappedDEK: newWrapped });
        }
    }

    if (!dek) {
        const newFailures = failures + 1;
        const lockoutMs = Math.min(Math.pow(2, newFailures) * 1000, 3600000);
        await userStore.updateUser(userId, {
            dekUnwrapFailures: newFailures,
            dekLockoutUntil: new Date(Date.now() + lockoutMs).toISOString()
        });
        return { wrongPin: true };
    }

    if (failures > 0) {
        await userStore.updateUser(userId, {
            dekUnwrapFailures: Math.max(0, failures - 1),
            dekLockoutUntil: null
        });
    }

    return { dek };
}

module.exports = {
    setupSSOUserDEK,
    unlockSSOUserDEK,
    bindUserStore,
};
