// @typecheck strict
/**
 * Zero-knowledge envelope encryption: password users.
 *
 * Create the DEK, unlock it with the password (exponential backoff, hard
 * lockout at 20, transparent Argon2 param migration) or the recovery key,
 * re-wrap it on a password change, rotate the recovery key, and the
 * destructive admin reset. The public surface is auth/encryption.js.
 */

const crypto = require('crypto');
const log = require('../telemetry/log');
const {
    SALT_LENGTH,
    DEK_LENGTH,
    RECOVERY_KEY_LENGTH,
    deriveKEK,
    deriveKEK_LEGACY,
    wrapDEK,
    unwrapDEK,
    secureClear,
    formatRecoveryKey,
    parseRecoveryKey,
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
// ZERO-KNOWLEDGE USER SETUP
// ============================================================

/**
 * Create DEK for a new user (registration or first login).
 * Returns { dek, recoveryKey } — recoveryKey MUST be shown to user ONCE.
 * Server never sees the DEK in plaintext after this function returns.
 * 
 * @param {string} userId
 * @param {string} password - User's password or encryption PIN
 * @returns {Promise<{ dek: Buffer, recoveryKey: string }>}
 */
async function createUserDEK(userId, password) {
    const dek = crypto.randomBytes(DEK_LENGTH);
    const kekSalt = crypto.randomBytes(SALT_LENGTH);
    const recoverySalt = crypto.randomBytes(SALT_LENGTH);
    const recoveryKeyRaw = crypto.randomBytes(RECOVERY_KEY_LENGTH);

    // Derive KEK from password
    const kek = await deriveKEK(password, kekSalt);
    const wrappedDEK = wrapDEK(dek, kek, `dek-wrap:${userId}`);

    // Derive recovery KEK from recovery key
    const recoveryKEK = await deriveKEK(recoveryKeyRaw, recoverySalt);
    const recoveryWrappedDEK = wrapDEK(dek, recoveryKEK, `dek-recovery:${userId}`);

    // Store — server has NO way to reverse these without user secrets
    await userStore.updateUser(userId, {
        kekSalt: kekSalt.toString('base64'),
        recoverySalt: recoverySalt.toString('base64'),
        wrappedDEK,
        recoveryWrappedDEK,
        // Clear any legacy master-wrapped DEK
        masterWrappedDEK: null
    });

    // Format recovery key as human-readable
    const recoveryKey = formatRecoveryKey(recoveryKeyRaw);

    // Zero-out sensitive buffers
    secureClear(kek);
    secureClear(recoveryKEK);

    return {
        dek,            // Buffer — caller must secureClear() after use
        recoveryKey     // string — show to user ONCE, then discard
    };
}

/**
 * Unlock DEK with password (normal login).
 * Implements exponential backoff, hard lockout at 20 attempts, and alert logging.
 * 
 * @param {string} userId
 * @param {string} password
 * @returns {Promise<Buffer|null>} DEK buffer or null on failure
 */
async function unlockUserDEK(userId, password) {
    const user = await userStore.getUser(userId);
    if (!user?.wrappedDEK || !user?.kekSalt) return null;

    const failures = user.dekUnwrapFailures || 0;

    // Hard lockout at 20 attempts
    if (failures >= 20) {
        log.error(`[ALERT] HARD LOCKOUT for ${userId} — admin reset or recovery key required (${failures} failures)`);
        return null;
    }

    // Exponential backoff: 2^failures seconds, capped at 1 hour
    if (failures >= 3) {
        const lockoutEnd = user.dekLockoutUntil ? new Date(user.dekLockoutUntil).getTime() : 0;
        if (Date.now() < lockoutEnd) {
            log.error(`[Auth] DEK locked for ${userId}, ${Math.ceil((lockoutEnd - Date.now()) / 1000)}s remaining`);
            return null;
        }
    }

    // Try current params first
    let kek = await deriveKEK(password, user.kekSalt);
    let dek = unwrapDEK(user.wrappedDEK, kek, `dek-wrap:${userId}`);
    secureClear(kek);

    // Fallback: try legacy params (64MB/timeCost 3)
    if (!dek) {
        kek = await deriveKEK_LEGACY(password, user.kekSalt);
        dek = unwrapDEK(user.wrappedDEK, kek, `dek-wrap:${userId}`);
        secureClear(kek);

        if (dek) {
            // Transparent migration: re-wrap with new params
            log.info(`[Auth] Migrating Argon2 params for user ${userId}`);
            const newKEK = await deriveKEK(password, user.kekSalt);
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
        if (newFailures >= 5) {
            log.error(`[ALERT] ${newFailures} failed DEK unwrap attempts for ${userId}`);
        }
        return null;
    }

    // Success — decay failures
    if (failures > 0) {
        await userStore.updateUser(userId, {
            dekUnwrapFailures: Math.max(0, failures - 1),
            dekLockoutUntil: null
        });
    }

    return dek;
}

/**
 * Unlock DEK with recovery key (forgot password flow).
 * After this, user MUST set new password via rewrapUserDEK().
 * 
 * @param {string} userId
 * @param {string} recoveryKeyString - Human-readable recovery key
 * @returns {Promise<Buffer|null>} DEK buffer or null on failure
 */
async function unlockWithRecoveryKey(userId, recoveryKeyString) {
    const user = await userStore.getUser(userId);
    if (!user?.recoveryWrappedDEK || !user?.recoverySalt) return null;

    // Rate limit recovery attempts
    const recoveryFailures = user.recoveryUnwrapFailures || 0;
    if (recoveryFailures >= 10) {
        log.error(`[ALERT] HARD LOCKOUT on recovery key for ${userId} (${recoveryFailures} failures)`);
        return null;
    }
    if (recoveryFailures >= 3) {
        const lockoutEnd = user.recoveryLockoutUntil ? new Date(user.recoveryLockoutUntil).getTime() : 0;
        if (Date.now() < lockoutEnd) return null;
    }

    /** @type {Buffer<ArrayBufferLike>} */
    let recoveryKeyRaw;
    try {
        recoveryKeyRaw = parseRecoveryKey(recoveryKeyString);
    } catch {
        return null; // Invalid format
    }

    const recoveryKEK = await deriveKEK(recoveryKeyRaw, user.recoverySalt);
    const dek = unwrapDEK(user.recoveryWrappedDEK, recoveryKEK, `dek-recovery:${userId}`);
    secureClear(recoveryKEK);
    secureClear(recoveryKeyRaw);

    if (!dek) {
        const newFailures = recoveryFailures + 1;
        await userStore.updateUser(userId, {
            recoveryUnwrapFailures: newFailures,
            recoveryLockoutUntil: new Date(Date.now() + Math.pow(2, newFailures) * 1000).toISOString()
        });
        return null;
    }

    // Success — decay recovery failures
    if (recoveryFailures > 0) {
        await userStore.updateUser(userId, {
            recoveryUnwrapFailures: Math.max(0, recoveryFailures - 1),
            recoveryLockoutUntil: null
        });
    }

    return dek; // Buffer or null
}

// ============================================================
// PASSWORD CHANGE & RECOVERY KEY ROTATION
// ============================================================

/**
 * Re-wrap DEK with a new password (password change flow).
 * Requires the DEK to already be unlocked (user is logged in).
 * 
 * @param {string} userId
 * @param {Buffer} dek - The unlocked DEK
 * @param {string} newPassword
 * @returns {Promise<boolean>}
 */
async function rewrapUserDEK(userId, dek, newPassword) {
    const newKekSalt = crypto.randomBytes(SALT_LENGTH);
    const newKEK = await deriveKEK(newPassword, newKekSalt);
    const newWrappedDEK = wrapDEK(dek, newKEK, `dek-wrap:${userId}`);
    secureClear(newKEK);

    await userStore.updateUser(userId, {
        kekSalt: newKekSalt.toString('base64'),
        wrappedDEK: newWrappedDEK
    });
    return true;
}

/**
 * Rotate recovery key — generates new recovery key, re-wraps DEK.
 * Returns new recoveryKey string to show to user.
 * 
 * @param {string} userId
 * @param {Buffer} dek - The unlocked DEK
 * @returns {Promise<string>} New recovery key string
 */
async function rotateRecoveryKey(userId, dek) {
    const newRecoverySalt = crypto.randomBytes(SALT_LENGTH);
    const newRecoveryKeyRaw = crypto.randomBytes(RECOVERY_KEY_LENGTH);
    const newRecoveryKEK = await deriveKEK(newRecoveryKeyRaw, newRecoverySalt);
    const newRecoveryWrappedDEK = wrapDEK(dek, newRecoveryKEK, `dek-recovery:${userId}`);
    secureClear(newRecoveryKEK);

    await userStore.updateUser(userId, {
        recoverySalt: newRecoverySalt.toString('base64'),
        recoveryWrappedDEK: newRecoveryWrappedDEK
    });

    const key = formatRecoveryKey(newRecoveryKeyRaw);
    secureClear(newRecoveryKeyRaw);
    return key;
}

// ============================================================
// ADMIN OPERATIONS (zero-knowledge — destructive!)
// ============================================================

/**
 * Admin password reset — does NOT recover data.
 * User must use their recovery key to restore access to encrypted data.
 * Without recovery key, old data is PERMANENTLY LOST.
 * 
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
async function adminResetUser(userId) {
    // Wipe the password-wrapped DEK (it's useless without old password)
    await userStore.updateUser(userId, {
        wrappedDEK: null,
        kekSalt: null,
        // recoveryWrappedDEK stays — user can recover with their key
        passwordResetRequired: 1,
        dekUnwrapFailures: 0,
        dekLockoutUntil: null
    });
    log.info(`[Auth] Admin reset user ${userId} — recovery key required for data`);
    return true;
}

module.exports = {
    createUserDEK,
    unlockUserDEK,
    unlockWithRecoveryKey,
    rewrapUserDEK,
    rotateRecoveryKey,
    adminResetUser,
    bindUserStore,
};
