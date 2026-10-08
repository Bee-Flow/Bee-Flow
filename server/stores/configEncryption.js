'use strict';
// Side-effect-free encryption helpers, shared by config storage and read-only upgrade inspection.
const crypto = require('crypto');
const log = require('../telemetry/log');

// ── Encryption helpers for secrets at rest ──────────────────────
// Derives a 256-bit key from MASTER_ENCRYPTION_KEY using HKDF-SHA256.
//
// Two derivation contexts are supported:
//   • 'beeflow:config-secrets:v1'         — default; used by all rows that
//      don't belong to a single org (provider client secrets, FX rates, …)
//      and by every legacy row written before per-org HKDF landed.
//   • 'beeflow:config-secrets:v1:<orgId>' — used for `org_<orgId>_*` keys.
//      A master-key rotation re-encrypts all rows under the new master, but
//      per-org rows additionally bind to the org id so a leak of one org's
//      derived key doesn't reveal another org's.
//
// The envelope records the context as `keyContext: '<orgId>' | undefined`
// so decrypt can pick the right derivation without scanning the key name.

const ORG_KEY_PREFIX_RE = /^org_([^_]+)_/;

function _inferOrgIdFromKey(key) {
    if (!key || typeof key !== 'string') return null;
    const m = key.match(ORG_KEY_PREFIX_RE);
    return m ? m[1] : null;
}

function _deriveKey(orgId = null) {
    const master = process.env.MASTER_ENCRYPTION_KEY;
    if (!master) throw new Error('MASTER_ENCRYPTION_KEY env var is required for config encryption');
    const info = orgId
        ? `beeflow:config-secrets:v1:${orgId}`
        : 'beeflow:config-secrets:v1';
    return crypto.createHmac('sha256', master).update(info).digest();
}

// ── Rate-limited decrypt failure logging ────────────────────────
// Batches decrypt errors into a single summary per interval
let _decryptFailCount = 0;
let _decryptFailTimer = null;
const DECRYPT_FAIL_LOG_INTERVAL_MS = 60_000; // 1 minute

function _logDecryptFailure() {
    _decryptFailCount++;
    if (!_decryptFailTimer) {
        _decryptFailTimer = setTimeout(() => {
            if (_decryptFailCount > 0) {
                log.warn(`[ConfigStore] Failed to decrypt ${_decryptFailCount} value(s) in the last 60s — check MASTER_ENCRYPTION_KEY or re-enter API keys via Admin UI`);
                _decryptFailCount = 0;
            }
            _decryptFailTimer = null;
        }, DECRYPT_FAIL_LOG_INTERVAL_MS);
        // Don't hold the process open for this timer
        if (_decryptFailTimer.unref) _decryptFailTimer.unref();
    }
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns a JSON-encoded envelope: { _encrypted: "config-v1", iv, authTag, data }.
 *
 * When `orgId` is supplied, derives a per-org key via HKDF info string
 * `beeflow:config-secrets:v1:<orgId>` and records the org context in the
 * envelope so decrypt can rebuild the right key.
 */
function encryptValue(plaintext, orgId = null) {
    if (!plaintext) return plaintext;
    const key = _deriveKey(orgId);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const env = {
        _encrypted: 'config-v1',
        iv: iv.toString('hex'),
        authTag: authTag.toString('hex'),
        data: encrypted.toString('hex'),
    };
    if (orgId) env.keyContext = orgId;
    return JSON.stringify(env);
}

/**
 * Decrypt an AES-256-GCM encrypted envelope.
 *
 *   • Envelopes with `keyContext: '<orgId>'` derive the per-org key.
 *   • Envelopes without keyContext use the legacy single-tenant key.
 *   • Plaintext values pass through unchanged.
 *
 * On failure, returns null (caller surfaces via the rate-limited logger).
 */
function decryptValue(stored) {
    if (!stored) return stored;

    // Parse if string
    let envelope = stored;
    if (typeof stored === 'string') {
        try { envelope = JSON.parse(stored); } catch (_) { return stored; /* plaintext */ }
    }

    // Not an encrypted envelope — return as-is (legacy migration)
    if (!envelope || typeof envelope !== 'object' || envelope._encrypted !== 'config-v1') {
        // If it was parsed from JSON but isn't an encrypted envelope, return original string
        return typeof stored === 'string' ? stored : JSON.stringify(stored);
    }

    try {
        const orgCtx = (typeof envelope.keyContext === 'string' && envelope.keyContext) ? envelope.keyContext : null;
        const key = _deriveKey(orgCtx);
        const iv = Buffer.from(envelope.iv, 'hex');
        const authTag = Buffer.from(envelope.authTag, 'hex');
        const data = Buffer.from(envelope.data, 'hex');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
        decipher.setAuthTag(authTag);
        return decipher.update(data) + decipher.final('utf8');
    } catch (err) {
        _logDecryptFailure();
        return null;
    }
}

module.exports = { encryptValue, decryptValue, _inferOrgIdFromKey };
