// @typecheck noImplicitAny
/**
 * Zero-knowledge envelope encryption: the primitives.
 *
 * Constants and Argon2id cost profiles, KEK derivation (password, PIN,
 * legacy), DEK wrap/unwrap with AAD, the envelope-encoding detection, memory
 * zeroing, the recovery-key format and the DEK fingerprint. Pure functions
 * over caller-supplied keys; no store access.
 *
 * The public surface is auth/encryption.js: import from there. This module
 * exports deriveKEK unconditionally only for its siblings (encryptionUserDek,
 * encryptionSsoDek, encryptionCompat); the barrel still exposes it to callers
 * under NODE_ENV test/development only.
 *
 * The ISO 27001 A.8.24 check (compliance/checks/iso27001/a8-24-cryptography.js)
 * reads ALGORITHM, IV_LENGTH, SALT_LENGTH and the first memoryCost/timeCost
 * from THIS file's source text: keep ARGON2_OPTIONS the first options object.
 */

const crypto = require('crypto');
const argon2 = require('argon2');
const log = require('../telemetry/log');

// sodium-native for guaranteed memory zeroing (sodium_memzero)
/**
 * @type {{ sodium_memzero: (arg0: Buffer<ArrayBufferLike>) => void; } | null}
 */
let sodium;
try {
    sodium = require('sodium-native');
} catch {
    sodium = null;
    log.warn('[Crypto] sodium-native not available — falling back to Buffer.fill(0) for secureClear');
}

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;       // NIST recommended for GCM
const SALT_LENGTH = 32;
const DEK_LENGTH = 32;
const RECOVERY_KEY_LENGTH = 32;

// Argon2id parameters — OWASP "Password Storage Cheat Sheet" 2026 profile.
//
// We use the "high-memory / moderate-time" tradeoff:
//   • memoryCost = 131_072 KiB = 128 MiB
//   • timeCost   = 4 iterations
//   • parallelism = 4 lanes
//   • hashLength = 32 bytes (256-bit DEK)
//
// Why these numbers:
//   • Argon2id resists both GPU/ASIC brute-force (high memory) and side-
//     channel leakage (id variant). OWASP recommends m≥19 MiB; we go to
//     128 MiB because (a) interactive auth happens at most O(login/day)
//     so the ~250–400 ms cost per hash is acceptable, and (b) the higher
//     memory floor multiplies attacker hardware cost ~6× over the 19 MiB
//     baseline.
//   • timeCost=4 + parallelism=4 is the lower of the two OWASP-suggested
//     profiles for this memory level; raising timeCost trades latency we
//     don't have for marginal extra brute-force resistance.
//   • hashLength=32 produces a key suitable for AES-256-GCM (the rest of
//     this module uses it as a KEK that wraps random per-user DEKs).
//
// Don't lower these without a written threat-model review. If you raise
// them, update ARGON2_OPTIONS_LEGACY too so existing users can still
// unlock with their stored params before being re-hashed on success.
/** @type {import('argon2').HashOptions & { raw: true }} */
const ARGON2_OPTIONS = {
    type: argon2.argon2id,
    memoryCost: 131072,     // 128 MB
    timeCost: 4,
    parallelism: 4,
    hashLength: 32,
    raw: /** @type {true} */ (true)               // Return Buffer, not encoded string
};

// Higher cost for PINs (lower entropy inputs)
const ARGON2_OPTIONS_PIN = {
    ...ARGON2_OPTIONS,
    timeCost: 5,
};

// Legacy params for backward-compatible unlock (will re-wrap on success)
/** @type {import('argon2').HashOptions & { raw: true }} */
const ARGON2_OPTIONS_LEGACY = {
    type: argon2.argon2id,
    memoryCost: 65536,      // 64 MB (old default)
    timeCost: 3,            // old default
    parallelism: 4,
    hashLength: 32,
    raw: /** @type {true} */ (true)
};

// Minimum encryption-PIN length. Exported so the unit test asserts against the
// real policy instead of a hardcoded copy — the two drifted once already (the
// policy was lowered from 8 to 6 and the test kept asserting "at least 8",
// leaving the suite red and unnoticed because no CI job ran it).
// Keep in sync with the client-side check in
// agent-hub/src/pages/EncryptionSetup.jsx.
//
// NOTE: 6 is on the weak side for a secret that wraps a DEK — a digits-only
// PIN is a 10^6 space, which is tractable offline for anyone holding the
// database. Argon2id (128 MiB, timeCost 5) and the unwrap lockout are what
// make it survivable. Raising this to 8 + a complexity rule is a product
// decision, not a silent one: it needs the same change in EncryptionSetup.jsx.
const MIN_ENCRYPTION_PIN_LENGTH = 6;

/**
 * Validate encryption PIN strength.
 * @param {string} pin
 * @throws {Error} if PIN is too weak
 */
function validateEncryptionPin(pin) {
    if (!pin || pin.length < MIN_ENCRYPTION_PIN_LENGTH) {
        throw new Error(`Encryption PIN must be at least ${MIN_ENCRYPTION_PIN_LENGTH} characters`);
    }
}

// ============================================================
// KEY DERIVATION
// ============================================================

/**
 * Derive KEK from password/PIN + random salt using Argon2id.
 * This is the ONLY way to get a KEK — no server-side shortcuts.
 * 
 * @param {string|Buffer} password - User's password or PIN
 * @param {string|Buffer} salt - 32-byte random salt (base64 string or Buffer)
 * @returns {Promise<Buffer>} 32-byte KEK
 */
async function deriveKEK(password, salt) {
    if (!password || (typeof password === 'string' && password.length === 0)) {
        throw new Error('Password/PIN cannot be empty');
    }
    const saltBuffer = Buffer.isBuffer(salt) ? salt : Buffer.from(salt, 'base64');
    if (saltBuffer.length !== SALT_LENGTH) {
        throw new Error(`Invalid salt length: expected ${SALT_LENGTH}, got ${saltBuffer.length}`);
    }
    return argon2.hash(password, {
        ...ARGON2_OPTIONS,
        salt: saltBuffer
    });
}

/**
 * Derive KEK from PIN with higher Argon2 cost (for SSO PINs).
 * @param {string|Buffer} pin
 * @param {string|Buffer} salt
 * @returns {Promise<Buffer>} 32-byte KEK
 */
async function deriveKEK_PIN(pin, salt) {
    if (!pin || (typeof pin === 'string' && pin.length === 0)) {
        throw new Error('PIN cannot be empty');
    }
    const saltBuffer = Buffer.isBuffer(salt) ? salt : Buffer.from(salt, 'base64');
    if (saltBuffer.length !== SALT_LENGTH) {
        throw new Error(`Invalid salt length: expected ${SALT_LENGTH}, got ${saltBuffer.length}`);
    }
    return argon2.hash(pin, {
        ...ARGON2_OPTIONS_PIN,
        salt: saltBuffer
    });
}

/**
 * Derive KEK with LEGACY Argon2 params (for backward-compatible unlock).
 * Only used as fallback during migration.
 * @param {string} password
 * @param {import('buffer').WithImplicitCoercion<string>} salt
 */
async function deriveKEK_LEGACY(password, salt) {
    const saltBuffer = Buffer.isBuffer(salt) ? salt : Buffer.from(salt, 'base64');
    return argon2.hash(password, {
        ...ARGON2_OPTIONS_LEGACY,
        salt: saltBuffer
    });
}

// ============================================================
// DEK WRAPPING (encrypt/decrypt the DEK itself)
// ============================================================

/**
 * Wrap (encrypt) a DEK with a key, binding to a context via AAD.
 * 
 * @param {Buffer} dek - The DEK to wrap
 * @param {Buffer} key - The wrapping key (KEK or recovery KEK)
 * @param {string|Buffer} context - AAD context string or its bytes (e.g. 'dek-wrap:userId')
 * @returns {{ enc: string, iv: string, authTag: string, data: string }} Base64-encoded wrapped DEK
 */
function wrapDEK(dek, key, context) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    // AAD binds ciphertext to context — prevents cross-user replay
    cipher.setAAD(Buffer.from(context));
    let wrapped = cipher.update(dek);
    wrapped = Buffer.concat([wrapped, cipher.final()]);
    return {
        // Explicit encoding marker. This module has always written base64
        // while the browser-side wrapper (agent-hub/src/lib/opaque.ts) writes
        // HEX into the SAME `wrappedDEK` column. Reading a hex envelope as
        // base64 yields garbage, unwrap returns null, and the caller charges
        // the user a failed password attempt — walking them toward the
        // 20-attempt hard lockout with a correct password. Tag what we write
        // so readers never have to guess.
        enc: 'base64',
        iv: iv.toString('base64'),
        authTag: cipher.getAuthTag().toString('base64'),
        data: wrapped.toString('base64')
    };
}

/**
 * Decide how an envelope's fields are encoded.
 *
 * Prefers the explicit `enc` marker. For legacy records written before that
 * marker existed, infer from the IV string length: a 12-byte IV is 24 hex
 * chars but only 16 base64 chars, so the two are unambiguous here even though
 * a short hex string is also syntactically valid base64.
 *
 * @param {{ enc?: string, iv?: string }} envelope
 * @returns {'base64'|'hex'}
 */
function envelopeEncoding(envelope) {
    if (envelope?.enc === 'hex' || envelope?.enc === 'base64') return envelope.enc;
    const iv = typeof envelope?.iv === 'string' ? envelope.iv : '';
    if (/^[0-9a-fA-F]+$/.test(iv) && iv.length === IV_LENGTH * 2) return 'hex';
    return 'base64';
}

/**
 * Unwrap (decrypt) a DEK with a key and matching AAD context.
 * 
 * @param {{ iv: string, authTag: string, data: string }} wrappedDEK
 * @param {Buffer} key - The unwrapping key
 * @param {string|Buffer} context - Must match the context used during wrapping
 * @returns {Buffer|null} The DEK or null on failure
 */
function unwrapDEK(wrappedDEK, key, context) {
    try {
        const encoding = envelopeEncoding(wrappedDEK);
        const iv = Buffer.from(wrappedDEK.iv, encoding);
        const authTag = Buffer.from(wrappedDEK.authTag, encoding);
        const data = Buffer.from(wrappedDEK.data, encoding);
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        decipher.setAAD(Buffer.from(context));
        decipher.setAuthTag(authTag);
        let dek = decipher.update(data);
        dek = Buffer.concat([dek, decipher.final()]);
        return dek;
    } catch (err) {
        // Expected: wrong key or tampered ciphertext
        if (/** @type {Error} */ (err).message?.includes('Unsupported state') || err.code === 'ERR_CRYPTO_AEAD_TAG') {
            return null;
        }
        // Unexpected error — log for debugging
        log.error('[Crypto] Unexpected unwrapDEK error:', /** @type {Error} */ (err).message);
        return null;
    }
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Securely clear sensitive key material from memory.
 * Uses sodium_memzero when available (guaranteed not to be optimized away).
 * Falls back to crypto.randomFill + Buffer.fill(0).
 * 
 * @param {Buffer} buffer - Buffer to zero
 */
function secureClear(buffer) {
    if (!Buffer.isBuffer(buffer)) return;
    if (sodium) {
        sodium.sodium_memzero(buffer);
    } else {
        crypto.randomFillSync(buffer);
        buffer.fill(0);
    }
}

/**
 * Format a raw key buffer as a human-readable recovery key.
 * Format: XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX
 * (8 groups of 8 hex chars = 64 hex chars = 32 bytes, fully preserved)
 * 
 * @param {Buffer} buffer - 32-byte raw key
 * @returns {string} Formatted recovery key
 */
function formatRecoveryKey(buffer) {
    const hex = buffer.toString('hex').toUpperCase();
    return hex.match(/.{1,8}/g).join('-');
}

/**
 * Parse a human-readable recovery key back to a Buffer.
 * 
 * @param {string} keyString - Formatted recovery key
 * @returns {Buffer} Raw key bytes
 */
function parseRecoveryKey(keyString) {
    const hex = keyString.replace(/-/g, '').replace(/\s/g, '').toUpperCase();
    if (!/^[0-9A-F]{64}$/.test(hex)) {
        throw new Error('Invalid recovery key format');
    }
    return Buffer.from(hex, 'hex');
}

/**
 * Generate a fingerprint (HMAC) of a DEK for integrity verification.
 * Store at creation, verify after unwrap to catch subtle corruption.
 * 
 * @param {Buffer} dek - The DEK to fingerprint
 * @param {string} userId - Context binding
 * @returns {string} Base64-encoded HMAC
 */
function dekFingerprint(dek, userId) {
    return crypto.createHmac('sha256', dek)
        .update(`dek-fingerprint:${userId}`)
        .digest('base64');
}

module.exports = {
    SALT_LENGTH,
    DEK_LENGTH,
    RECOVERY_KEY_LENGTH,
    MIN_ENCRYPTION_PIN_LENGTH,
    validateEncryptionPin,
    deriveKEK,
    deriveKEK_PIN,
    deriveKEK_LEGACY,
    wrapDEK,
    envelopeEncoding,
    unwrapDEK,
    secureClear,
    formatRecoveryKey,
    parseRecoveryKey,
    dekFingerprint,
};
