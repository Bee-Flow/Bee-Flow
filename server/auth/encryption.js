// @typecheck strict
/**
 * Zero-Knowledge Envelope Encryption Module
 * 
 * Implements DEK/KEK encryption with zero-knowledge architecture:
 * - DEK (Data Encryption Key): Random 32-byte key per user, encrypts messages
 * - KEK (Key Encryption Key): Derived from password/PIN via Argon2id, wraps DEK
 * - Recovery Key: One-time backup key shown to user, wraps DEK independently
 * 
 * The server NEVER stores plaintext DEKs or any key material that could
 * derive them without user input (password, PIN, or recovery key).
 * 
 * Security improvements over previous version:
 * - Argon2id instead of PBKDF2 (memory-hard, GPU/ASIC resistant)
 * - Random 32-byte salts instead of deterministic salts
 * - 12-byte IVs per NIST SP 800-38D for AES-GCM
 * - AAD (Additional Authenticated Data) to bind ciphertext to context
 * - No hardcoded fallback secrets
 * - No master key backdoor — server cannot derive DEK
 * - DEK returned as Buffer for secure memory clearing
 *
 * This file is the public surface (a barrel). The code lives in:
 *   - encryptionPrimitives.js  constants, Argon2id KEK derivation, wrap/unwrap,
 *                              envelope encoding, secureClear, recovery-key format
 *   - encryptionUserDek.js     password users: create/unlock/recovery/rewrap/rotate,
 *                              admin reset
 *   - encryptionSsoDek.js      SSO users: encryption-PIN setup and unlock
 *   - encryptionCompat.js      backward-compatible wrappers and legacy migrations
 */

const userStore = require('../stores/userStore');
const {
    secureClear,
    formatRecoveryKey,
    parseRecoveryKey,
    dekFingerprint,
    validateEncryptionPin,
    MIN_ENCRYPTION_PIN_LENGTH,
    deriveKEK,
    wrapDEK,
    unwrapDEK,
    envelopeEncoding,
} = require('./encryptionPrimitives');
const encryptionUserDek = require('./encryptionUserDek');
const encryptionSsoDek = require('./encryptionSsoDek');
const encryptionCompat = require('./encryptionCompat');

// The store goes in once, here; the modules behind the barrel never require
// it themselves (see bindUserStore in each).
encryptionUserDek.bindUserStore(userStore);
encryptionSsoDek.bindUserStore(userStore);
encryptionCompat.bindUserStore(userStore);

const { createUserDEK, unlockUserDEK, unlockWithRecoveryKey, rewrapUserDEK, rotateRecoveryKey, adminResetUser } =
    encryptionUserDek;
const { setupSSOUserDEK, unlockSSOUserDEK } = encryptionSsoDek;
const { getOrCreateUserDEKCompat, getOrCreateSSOUserDEKCompat, rewrapUserDEKCompat, getFallbackEncryptionKey } =
    encryptionCompat;

const publicExports = {
    // Core zero-knowledge API
    createUserDEK,
    unlockUserDEK,
    unlockWithRecoveryKey,
    rewrapUserDEK,
    rotateRecoveryKey,
    adminResetUser,

    // SSO PIN flow
    setupSSOUserDEK,
    unlockSSOUserDEK,

    // Backward-compatible wrappers (for gradual migration)
    getOrCreateUserDEKCompat,
    getOrCreateSSOUserDEKCompat,
    rewrapUserDEKCompat,
    getFallbackEncryptionKey,

    // Helpers
    secureClear,
    formatRecoveryKey,
    parseRecoveryKey,
    dekFingerprint,
    validateEncryptionPin,
    MIN_ENCRYPTION_PIN_LENGTH,

    // Envelope primitives. These were previously test/development-only, which
    // meant no other production module could wrap a DEK without duplicating
    // the envelope format — and a second copy of an envelope format is how
    // the hex/base64 split in agent-hub/src/lib/opaque.ts happened. They are
    // pure functions over caller-supplied keys and hold no secret state, so
    // there is nothing to protect by hiding them. auth/orgEscrow.js uses them.
    wrapDEK,
    unwrapDEK,
    envelopeEncoding
};

// Only expose key DERIVATION in test/development — unlike the envelope
// helpers, deriveKEK is the expensive Argon2 path and exposing it invites
// call sites that should be going through unlockUserDEK instead.
const derivationExports = (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development') ? { deriveKEK } : {};

module.exports = { ...publicExports, ...derivationExports };
