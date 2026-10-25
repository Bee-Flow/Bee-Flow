// @typecheck
/**
 * Zero-knowledge envelope encryption: backward-compatible wrappers.
 *
 * Get-or-create for password and SSO users, including the migrations from
 * the PBKDF2 deterministic-salt envelope and the legacy master key (refused
 * after its 2026-06-01 deadline), the compat password-change re-wrap and the
 * non-zero-knowledge admin fallback key. The public surface is
 * auth/encryption.js.
 */

const crypto = require('crypto');
const log = require('../telemetry/log');
const {
    SALT_LENGTH,
    RECOVERY_KEY_LENGTH,
    deriveKEK,
    wrapDEK,
    unwrapDEK,
    secureClear,
    formatRecoveryKey,
} = require('./encryptionPrimitives');
const { createUserDEK, unlockUserDEK, rewrapUserDEK } = require('./encryptionUserDek');

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
// LEGACY / TRANSITIONAL SUPPORT
// ============================================================

/**
 * Get or create DEK for a user, with backward compatibility.
 * Handles migration from old master-key wrapped DEKs.
 * 
 * For new users: creates DEK + recovery key.
 * For existing users with old wrappedDEK (no kekSalt): attempt legacy unwrap.
 * For existing users with kekSalt: standard Argon2id unwrap.
 * 
 * @param {string} userId
 * @param {string} password
 * @returns {Promise<{ encryptionKey: string, recoveryKey?: string }|null>}
 */
async function getOrCreateUserDEKCompat(userId, password) {
    const user = await userStore.getUser(userId);

    if (user && user.wrappedDEK) {
        if (user.kekSalt) {
            // New-style: Argon2id with random salt
            const dek = await unlockUserDEK(userId, password);
            if (dek) {
                const key = dek.toString('base64');
                secureClear(dek);
                return { encryptionKey: key };
            }
            return null;
        } else {
            // Legacy: PBKDF2 with deterministic salt — migrate on successful unlock
            const legacyKEK = crypto.pbkdf2Sync(password, `beeflow-kek-${userId}`, 100000, 32, 'sha256');
            const dek = unwrapDEK(user.wrappedDEK, legacyKEK, ''); // legacy had no AAD
            secureClear(legacyKEK);

            if (dek) {
                // Migrate: re-wrap with new Argon2id KEK + create recovery key
                log.info(`[Auth] Migrating DEK for user ${userId} to Argon2id + random salt`);
                const kekSalt = crypto.randomBytes(SALT_LENGTH);
                const newKEK = await deriveKEK(password, kekSalt);
                const newWrappedDEK = wrapDEK(dek, newKEK, `dek-wrap:${userId}`);
                secureClear(newKEK);

                // Create recovery key
                const recoverySalt = crypto.randomBytes(SALT_LENGTH);
                const recoveryKeyRaw = crypto.randomBytes(RECOVERY_KEY_LENGTH);
                const recoveryKEK = await deriveKEK(recoveryKeyRaw, recoverySalt);
                const recoveryWrappedDEK = wrapDEK(dek, recoveryKEK, `dek-recovery:${userId}`);
                secureClear(recoveryKEK);

                await userStore.updateUser(userId, {
                    kekSalt: kekSalt.toString('base64'),
                    recoverySalt: recoverySalt.toString('base64'),
                    wrappedDEK: newWrappedDEK,
                    recoveryWrappedDEK,
                    masterWrappedDEK: null
                });

                const key = dek.toString('base64');
                const recoveryKey = formatRecoveryKey(recoveryKeyRaw);
                secureClear(dek);
                secureClear(recoveryKeyRaw);

                return { encryptionKey: key, recoveryKey };
            }

            // Legacy unwrap failed — try master key as last resort
            const masterKey = getLegacyMasterKey();
            if (masterKey && user.masterWrappedDEK) {
                const dekFromMaster = unwrapDEK(user.masterWrappedDEK, masterKey, '');
                secureClear(masterKey);
                if (dekFromMaster) {
                    // Migrate from master key
                    log.info(`[Auth] Migrating DEK for user ${userId} from master key to Argon2id`);
                    const kekSalt = crypto.randomBytes(SALT_LENGTH);
                    const newKEK = await deriveKEK(password, kekSalt);
                    const newWrappedDEK = wrapDEK(dekFromMaster, newKEK, `dek-wrap:${userId}`);
                    secureClear(newKEK);

                    const recoverySalt = crypto.randomBytes(SALT_LENGTH);
                    const recoveryKeyRaw = crypto.randomBytes(RECOVERY_KEY_LENGTH);
                    const recoveryKEK = await deriveKEK(recoveryKeyRaw, recoverySalt);
                    const recoveryWrappedDEK = wrapDEK(dekFromMaster, recoveryKEK, `dek-recovery:${userId}`);
                    secureClear(recoveryKEK);

                    await userStore.updateUser(userId, {
                        kekSalt: kekSalt.toString('base64'),
                        recoverySalt: recoverySalt.toString('base64'),
                        wrappedDEK: newWrappedDEK,
                        recoveryWrappedDEK,
                        masterWrappedDEK: null
                    });

                    const key = dekFromMaster.toString('base64');
                    const recoveryKey = formatRecoveryKey(recoveryKeyRaw);
                    secureClear(dekFromMaster);
                    secureClear(recoveryKeyRaw);

                    return { encryptionKey: key, recoveryKey };
                }
            }

            return null;
        }
    }

    // No DEK exists — create new one
    const { dek, recoveryKey } = await createUserDEK(userId, password);
    const key = dek.toString('base64');
    secureClear(dek);
    return { encryptionKey: key, recoveryKey };
}

/**
 * Get or create DEK for SSO user with backward compatibility.
 * Legacy SSO users had DEKs wrapped with master key only.
 * 
 * @param {string} userId
 * @param {boolean} [encryptionEnabled=true] - If false, skip encryption entirely (free/basic plans)
 * @returns {Promise<{ encryptionKey?: string, needsEncryptionSetup?: boolean, needsEncryptionPin?: boolean }>}
 */
async function getOrCreateSSOUserDEKCompat(userId, encryptionEnabled = true) {
    // If encryption is disabled for this user's plan, skip entirely
    if (!encryptionEnabled) {
        return {};
    }

    const user = await userStore.getUser(userId);

    // New system: user has set up encryption PIN
    if (user?.ssoEncryptionSetup) {
        return { needsEncryptionPin: true };
    }

    // Legacy: try master key unwrap
    if (user?.masterWrappedDEK) {
        const masterKey = getLegacyMasterKey();
        if (masterKey) {
            const dek = unwrapDEK(user.masterWrappedDEK, masterKey, '');
            secureClear(masterKey);
            if (dek) {
                const key = dek.toString('base64');
                secureClear(dek);
                // Signal that setup is needed while still providing access
                return { encryptionKey: key, needsEncryptionSetup: true };
            }
        }
    }

    // No DEK at all — needs setup
    return { needsEncryptionSetup: true };
}

/**
 * Legacy master key derivation — ONLY used for migration.
 * Hard deadline: 2026-06-01. After that, legacy unwrap is refused.
 * @returns {Buffer|null}
 */
function getLegacyMasterKey() {
    const secret = process.env.MASTER_ENCRYPTION_KEY;
    if (!secret) return null;

    // Hard deadline — force migration
    const MIGRATION_DEADLINE = new Date('2026-06-01');
    if (Date.now() > MIGRATION_DEADLINE.getTime()) {
        log.error('[CRITICAL] Legacy master key migration deadline passed. Refusing legacy unwrap.');
        return null;
    }

    return crypto.pbkdf2Sync(secret, 'beeflow-master-key', 600000, 32, 'sha256');
}

/**
 * Fallback encryption key for admin users.
 * NOT zero-knowledge — server can derive these keys.
 * Restricted to non-production or explicitly admin contexts.
 *
 * @param {string} userId
 * @returns {string} Base64-encoded 32-byte key
 */
function getFallbackEncryptionKey(userId) {
    const secret = process.env.MASTER_ENCRYPTION_KEY;
    if (!secret) {
        throw new Error('MASTER_ENCRYPTION_KEY env var is required for fallback encryption');
    }
    const salt = `beeflow-fallback-${userId}`;
    return crypto.pbkdf2Sync(secret, salt, 210000, 32, 'sha512').toString('base64');
}

/**
 * Re-wrap DEK during password change with backward compatibility.
 * Unlocks with old password, re-wraps with new password.
 * 
 * @param {string} userId
 * @param {string} oldPassword
 * @param {string} newPassword
 * @returns {Promise<{ success: boolean, encryptionKey?: string }>}
 */
async function rewrapUserDEKCompat(userId, oldPassword, newPassword) {
    const user = await userStore.getUser(userId);
    if (!user || !user.wrappedDEK) {
        return { success: true }; // No DEK to rewrap
    }

    /** @type {Buffer<ArrayBufferLike> | null} */
    let dek = null;

    if (user.kekSalt) {
        // New-style: Argon2id
        dek = await unlockUserDEK(userId, oldPassword);
    } else {
        // Legacy: PBKDF2 with deterministic salt
        const legacyKEK = crypto.pbkdf2Sync(oldPassword, `beeflow-kek-${userId}`, 100000, 32, 'sha256');
        dek = unwrapDEK(user.wrappedDEK, legacyKEK, '');
        secureClear(legacyKEK);
    }

    if (!dek) {
        return { success: false };
    }

    await rewrapUserDEK(userId, dek, newPassword);
    const key = dek.toString('base64');
    secureClear(dek);
    return { success: true, encryptionKey: key };
}

module.exports = {
    getOrCreateUserDEKCompat,
    getOrCreateSSOUserDEKCompat,
    rewrapUserDEKCompat,
    getFallbackEncryptionKey,
    bindUserStore,
};
