// @typecheck
/**
 * MFA (TOTP) helpers — shared by mfaRoutes.js (enroll/manage) and the login
 * flow in loginRoutes.js (verify the second factor before a session is
 * established).
 *
 * Storage model (columns on `users`, see userStore migration):
 *   - mfa_enabled (bool)
 *   - mfa_secret  — base32 TOTP secret, ENCRYPTED at rest via the configStore
 *                   AES-256-GCM envelope (never stored in plaintext).
 *   - mfa_recovery_codes — JSON array of { hash, usedAt } where `hash` is a
 *                   bcrypt hash of a one-time recovery code.
 *
 * TOTP is verified with a ±1 step (30s) window to tolerate clock drift.
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { generateSecret: otpGenerateSecret, verifySync, createGuardrails } = require('otplib');
const QRCode = require('qrcode');
const configStore = require('../stores/configStore');
const { bestEffort } = require('../utils/bestEffort');

// Tolerate one 30s step of clock drift on either side. The tolerance is given
// in seconds: [30, 30] accepts exactly the previous, current and next step for
// every instant (the old `window: 1`).
const EPOCH_TOLERANCE_SECONDS = 30;
// otplib 13 refuses secrets under 16 bytes by default. Accounts enrolled with
// otplib 12 hold 10-byte (16 character) secrets, so lower the floor or every
// one of them would be locked out of its authenticator app.
const GUARDRAILS = createGuardrails({ MIN_SECRET_BYTES: 1 });
// Byte length of a new secret: 16 base32 characters, as it always was.
const SECRET_BYTES = 10;

const ISSUER = 'Bee Flow';
const RECOVERY_CODE_COUNT = 10;
// Wrong answers one pending password login may give before it is thrown away
// and the password is asked for again. Shared by every second factor (code,
// recovery code, security key): they spend one counter, so switching method
// does not buy a fresh set of guesses.
const MFA_LOGIN_MAX_ATTEMPTS = 5;

function generateSecret() {
    return otpGenerateSecret({ length: SECRET_BYTES }); // base32, no padding
}

// Built by hand: otplib 13 leaves the default period/digits/algorithm out of
// the URL, and the URL (and so the QR code) is part of what users and support
// see. Byte-identical to what otplib 12's `keyuri` produced.
/** @param {string} secret @param {string | null} [accountLabel] */
function otpauthUrl(secret, accountLabel) {
    const issuer = encodeURIComponent(ISSUER);
    const label = encodeURIComponent(accountLabel || 'user');
    return `otpauth://totp/${issuer}:${label}?secret=${secret}&period=30&digits=6&algorithm=SHA1&issuer=${issuer}`;
}

/** @param {string} otpauth */
async function qrDataUrl(otpauth) {
    return QRCode.toDataURL(otpauth, { margin: 1, width: 220 });
}

/** @param {string} secretPlain @param {string} token */
function verifyTotp(secretPlain, token) {
    if (!secretPlain || !token) return false;
    const clean = String(token).replace(/\s+/g, '');
    if (!/^\d{6}$/.test(clean)) return false;
    try {
        // otplib 12 accepted lower-case and "="-padded secrets; 13 only canonical ones.
        const secret = String(secretPlain).toUpperCase().replace(/=+$/, '');
        return verifySync({
            token: clean,
            secret,
            epochTolerance: EPOCH_TOLERANCE_SECONDS,
            guardrails: GUARDRAILS,
        }).valid;
    } catch (_) {
        return false;
    }
}

// Encrypt / decrypt the TOTP secret at rest using the configStore envelope.
/** @param {string} secretPlain */
function encryptSecret(secretPlain) {
    return configStore.encryptValue(secretPlain);
}
/** @param {string} stored */
function decryptSecret(stored) {
    if (!stored) return null;
    return configStore.decryptValue(stored);
}

// ── Recovery codes ───────────────────────────────────────────────────────
// Human-friendly one-time codes ("a1b2-c3d4"). Stored only as bcrypt hashes.
function _randomCode() {
    const raw = crypto.randomBytes(4).toString('hex'); // 8 hex chars
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

async function generateRecoveryCodes(count = RECOVERY_CODE_COUNT) {
    const plain = Array.from({ length: count }, () => _randomCode());
    const stored = await Promise.all(plain.map(/** @param {string} c @returns {Promise<RecoveryCode>} */ async (c) => ({
        hash: await bcrypt.hash(c.replace('-', ''), 10),
        usedAt: null,
    })));
    return { plain, stored };
}

/** @typedef {{ hash: string, usedAt: string | null }} RecoveryCode */

/**
 * @param {string | RecoveryCode[] | null | undefined} json
 * @returns {RecoveryCode[]}
 */
function parseRecoveryCodes(json) {
    if (!json) return [];
    try {
        const arr = typeof json === 'string' ? JSON.parse(json) : json;
        return Array.isArray(arr) ? arr : [];
    } catch (_) {
        return [];
    }
}

/**
 * Verify a recovery code against the stored hashes. Returns the updated
 * codes array (with the matched entry marked used) when valid, or null when
 * no unused code matches. The caller persists the returned array.
 * @param {string | RecoveryCode[] | null | undefined} storedCodesJson
 * @param {string} inputCode
 */
async function consumeRecoveryCode(storedCodesJson, inputCode) {
    const codes = parseRecoveryCodes(storedCodesJson);
    const clean = String(inputCode || '').replace(/[\s-]/g, '').toLowerCase();
    if (!clean) return null;
    for (const entry of codes) {
        if (entry.usedAt) continue;
        try {
            if (await bcrypt.compare(clean, entry.hash)) {
                entry.usedAt = new Date().toISOString();
                return codes;
            }
        } catch (err) { bestEffort('mfa:recovery-code-entry', err); }
    }
    return null;
}

/** @param {string | RecoveryCode[] | null | undefined} storedCodesJson */
function remainingRecoveryCodes(storedCodesJson) {
    return parseRecoveryCodes(storedCodesJson).filter(c => !c.usedAt).length;
}

module.exports = {
    generateSecret,
    otpauthUrl,
    qrDataUrl,
    verifyTotp,
    encryptSecret,
    decryptSecret,
    generateRecoveryCodes,
    parseRecoveryCodes,
    consumeRecoveryCode,
    remainingRecoveryCodes,
    RECOVERY_CODE_COUNT,
    MFA_LOGIN_MAX_ATTEMPTS,
};
