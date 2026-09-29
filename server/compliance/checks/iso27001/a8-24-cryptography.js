/**
 * ISO 27001 A.8.24 — Cryptography: the envelope-encryption architecture is
 * intact and its platform keys are configured.
 *
 * Largely static-architecture truth:
 *   1. MODULE — auth/encryption.js loads and exports the full zero-knowledge
 *      API (create/unlock/rewrap/recovery + secureClear/dekFingerprint).
 *   2. PRIMITIVES — the module's source declares AES-256-GCM and Argon2id with
 *      the shipped cost parameters. The constants are intentionally not
 *      exported (low-level primitives are test/dev-only), so they are read
 *      from the source text and reported as measured values.
 *   3. TOGGLES — MASTER_ENCRYPTION_KEY (config envelope + org vault root) and
 *      SESSION_SECRET are set; OPAQUE_SERVER_SETUP is reported as evidence
 *      (set, and readable by the OPAQUE library per auth/opaqueSetup.js).
 */

const fs = require('fs');
const path = require('path');
// Cached boot-time verdict on OPAQUE_SERVER_SETUP; never loads the WASM.
const { getServerSetupStatus } = require('../../../auth/opaqueSetup');

const ENCRYPTION_PATH = path.join(__dirname, '..', '..', '..', 'auth', 'encryption.js');

// Everything the rest of the product calls; the check fails if any disappears.
const REQUIRED_EXPORTS = [
    'createUserDEK', 'unlockUserDEK', 'unlockWithRecoveryKey',
    'rewrapUserDEK', 'rotateRecoveryKey', 'secureClear', 'dekFingerprint',
];

function _readPrimitives() {
    try {
        const src = fs.readFileSync(ENCRYPTION_PATH, 'utf-8');
        const algorithm = (src.match(/ALGORITHM = '([^']+)'/) || [])[1] || null;
        const memory = (src.match(/memoryCost:\s*(\d+)/) || [])[1];
        const time = (src.match(/timeCost:\s*(\d+)/) || [])[1];
        const iv = (src.match(/IV_LENGTH = (\d+)/) || [])[1];
        const salt = (src.match(/SALT_LENGTH = (\d+)/) || [])[1];
        return {
            algorithm,
            kdf: /type:\s*argon2\.argon2id/.test(src) ? 'argon2id' : null,
            argon2_memory_kib: memory ? parseInt(memory, 10) : null,
            argon2_time_cost: time ? parseInt(time, 10) : null,
            iv_bytes: iv ? parseInt(iv, 10) : null,
            salt_bytes: salt ? parseInt(salt, 10) : null,
        };
    } catch {
        return null;
    }
}

module.exports = {
    id: 'ISO27001-A.8.24-cryptography',
    regulation: 'ISO27001',
    article: 'A.8.24',
    controls: ['A.8.24'],
    frameworks: [{ regulation: 'NIS2', ref: 'Art. 21(2)(h)' }],
    severity: 'critical',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.checks.iso_cryptography.title',
    descriptionKey: 'compliance.checks.iso_cryptography.desc',
    remediationKey: 'compliance.checks.iso_cryptography.fix',
    remediationLink: null,
    async evaluate() {
        let encryption = null;
        let loadError = null;
        try {
            encryption = require(ENCRYPTION_PATH);
        } catch (e) {
            loadError = e.message;
        }
        const missingExports = encryption
            ? REQUIRED_EXPORTS.filter(fn => typeof encryption[fn] !== 'function')
            : REQUIRED_EXPORTS;

        const primitives = _readPrimitives();

        const evidence = {
            module_loaded: !!encryption,
            missing_exports: missingExports,
            algorithm: primitives ? primitives.algorithm : null,
            kdf: primitives ? primitives.kdf : null,
            argon2_memory_kib: primitives ? primitives.argon2_memory_kib : null,
            argon2_time_cost: primitives ? primitives.argon2_time_cost : null,
            iv_bytes: primitives ? primitives.iv_bytes : null,
            salt_bytes: primitives ? primitives.salt_bytes : null,
            master_key_configured: !!process.env.MASTER_ENCRYPTION_KEY,
            session_secret_configured: !!process.env.SESSION_SECRET,
            // Set AND not known to be unreadable by the OPAQUE library; the
            // readability verdict itself is null until the boot check ran.
            opaque_configured: !!process.env.OPAQUE_SERVER_SETUP && getServerSetupStatus()?.valid !== false,
            opaque_setup_readable: process.env.OPAQUE_SERVER_SETUP ? (getServerSetupStatus()?.valid ?? null) : null,
        };
        if (loadError) evidence.load_error = loadError;

        if (!encryption || missingExports.length > 0) {
            return {
                status: 'fail',
                evidence,
                details: encryption
                    ? `The encryption module no longer exports: ${missingExports.join(', ')}. User-data encryption is broken or has been tampered with.`
                    : 'The encryption module (auth/encryption.js) failed to load — user-data encryption is not operational.',
            };
        }
        if (!primitives || primitives.algorithm !== 'aes-256-gcm' || primitives.kdf !== 'argon2id') {
            return {
                status: 'fail',
                evidence,
                details: 'The shipped cryptographic primitives (AES-256-GCM + Argon2id) could not be confirmed in auth/encryption.js — the module deviates from the reviewed configuration.',
            };
        }
        // 65536 KiB is the legacy floor kept only for transparent migration;
        // the primary profile must not drop to or below it.
        if ((primitives.argon2_memory_kib || 0) <= 65536) {
            return {
                status: 'warn',
                evidence,
                details: `Argon2id memory cost is ${primitives.argon2_memory_kib} KiB — at or below the legacy migration floor (65536 KiB). Restore the shipped 131072 KiB profile.`,
            };
        }
        if (!process.env.MASTER_ENCRYPTION_KEY) {
            return {
                status: 'warn',
                evidence,
                details: 'The encryption architecture is intact but MASTER_ENCRYPTION_KEY is not set — the config envelope and per-org vault cannot encrypt at rest. Set it in the server environment and restart.',
            };
        }
        return {
            status: 'pass',
            evidence,
            details: `Envelope encryption verified: AES-256-GCM (${primitives.iv_bytes}-byte IV, ${primitives.salt_bytes}-byte salt) with Argon2id key derivation (${primitives.argon2_memory_kib} KiB, t=${primitives.argon2_time_cost}); platform envelope keys are configured.`,
        };
    },
};
