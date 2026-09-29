// @typecheck
/**
 * secretBox — one audited AES-256-GCM cipher for small JSON secret blobs
 * (H12). Replaces the duplicated deriveKey/encryptTokens/decryptTokens copies
 * in supportInboxStore.
 *
 * Two things it fixes:
 *   1. Security — one audited GCM implementation (random 16-byte IV, mandatory
 *      auth-tag verification, decrypt-returns-null on any failure) instead of
 *      two drifting copies.
 *   2. Performance — the scrypt key derivation is memoized per box. The old
 *      code called crypto.scryptSync (~30–80ms, event-loop-blocking) on EVERY
 *      encrypt/decrypt; the sync engines decrypt tokens on 30s/90s/5min ticks,
 *      so those stalls were recurring. Here scrypt runs once, lazily, on first
 *      use (so construction never throws if SESSION_SECRET is unset — same
 *      failure timing as before), then the derived key is cached.
 *
 * Ciphertext format is byte-identical to the old code — `iv:tag:hex`, so
 * existing DB rows keep decrypting. Per-feature salts stay DISTINCT parameters
 * (a SESSION_SECRET compromise scoped to one feature's blobs must not trivially
 * decrypt the other's) — never unify them.
 *
 * @param {string} secretSource the raw secret (e.g. process.env.SESSION_SECRET)
 * @param {string} salt per-feature salt (e.g. 'support-inbox-salt')
 * @param {{ logPrefix?: string }} [opts] logPrefix logs decrypt failures like the old stores did
 * @returns {{ encrypt: (obj:any)=>string, decrypt: (blob:string)=>any|null }}
 */
const crypto = require('crypto');
const log = require('../telemetry/log');

function createSecretBox(secretSource, salt, opts = {}) {
    const { logPrefix } = opts;
    let _key = null;
    function key() {
        if (_key === null) _key = crypto.scryptSync(secretSource, salt, 32);
        return _key;
    }

    function encrypt(obj) {
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
        let encrypted = cipher.update(JSON.stringify(obj), 'utf8', 'hex');
        encrypted += cipher.final('hex');
        const tag = cipher.getAuthTag().toString('hex');
        return `${iv.toString('hex')}:${tag}:${encrypted}`;
    }

    function decrypt(blob) {
        try {
            if (!blob) return null;
            const [ivHex, tagHex, data] = String(blob).split(':');
            const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivHex, 'hex'));
            decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
            let decrypted = decipher.update(data, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            return JSON.parse(decrypted);
        } catch (err) {
            if (logPrefix) log.error(`${logPrefix} Token decryption failed:`, err.message);
            return null;
        }
    }

    return { encrypt, decrypt };
}

module.exports = { createSecretBox };
