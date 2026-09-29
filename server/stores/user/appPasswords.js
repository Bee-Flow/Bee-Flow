// @typecheck
// App passwords (Nextcloud / WebDAV credentials) — AES-256-GCM envelope
// encryption under the master key, plus the per-user store/read/delete API.

const crypto = require('crypto');
const { run } = require('../../db');
const { initDB } = require('./schema');
const { getUser, createUser } = require('./users');
const log = require('../../telemetry/log');

// ── Encryption (app passwords) ─────────────────────────────
const ALGORITHM = 'aes-256-gcm';
const APP_PWD_IV_LENGTH = 12;

// App-password (Nextcloud WebDAV credential) sealing.
//
// v2 derives a DOMAIN-SEPARATED key by HMAC, matching stores/orgVault.js. The
// original v1 key was a bare sha256() of the master with no domain separation,
// and fell back to SESSION_SECRET — a session-signing secret with a different
// rotation lifecycle, which orgVault.js explicitly warns against: rotating it
// on an install without MASTER_ENCRYPTION_KEY silently destroyed every stored
// app password. v1 ciphertext stays readable (see decrypt) and is re-sealed as
// v2 on the next write, so no migration is needed.
const APP_PWD_ENVELOPE_TAG = 'appcred-v1';

function getEncryptionKey() {
    const master = process.env.MASTER_ENCRYPTION_KEY;
    if (!master) throw new Error('MASTER_ENCRYPTION_KEY env var is required to store app passwords');
    return crypto.createHmac('sha256', master).update('beeflow:app-password:v1').digest();
}

// Legacy key for reading rows written before the domain-separated derivation.
function getLegacyEncryptionKey() {
    const secret = process.env.MASTER_ENCRYPTION_KEY || process.env.SESSION_SECRET;
    if (!secret) throw new Error('MASTER_ENCRYPTION_KEY or SESSION_SECRET env var is required');
    return crypto.createHash('sha256').update(secret).digest();
}

function encrypt(text) {
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(APP_PWD_IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    // The tag lets scripts/rotate-master-key.js find these blobs; without it
    // they were invisible to rotation and a key change bricked them.
    return {
        _encrypted: APP_PWD_ENVELOPE_TAG,
        iv: iv.toString('hex'),
        authTag: cipher.getAuthTag().toString('hex'),
        data: encrypted,
    };
}

function decrypt(encrypted) {
    if (typeof encrypted === 'string') { try { encrypted = JSON.parse(encrypted); } catch (e) { return null; } }
    if (!encrypted || typeof encrypted !== 'object') return null;
    const tryKey = (key) => {
        try {
            const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(encrypted.iv, 'hex'));
            decipher.setAuthTag(Buffer.from(encrypted.authTag, 'hex'));
            let decrypted = decipher.update(encrypted.data, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        } catch (_) { return null; }
    };
    // v2 first, then the legacy derivation for rows written before the change.
    let out = null;
    try { out = tryKey(getEncryptionKey()); } catch (_) { /* master missing — try legacy */ }
    if (out !== null) return out;
    try { out = tryKey(getLegacyEncryptionKey()); } catch (_) { return null; }
    if (out === null) log.error('App-password decryption failed (wrong key or rotated master)');
    return out;
}

// ── App Password (Nextcloud / WebDAV) ─────────────────
// Stores `{username, password, url}` as encrypted JSON in users.appPassword. The username
// is the Nextcloud uid used for WebDAV Basic auth, which may differ from the BeeFlow login
// (e.g. SSO email vs Nextcloud uid). `url` is the optional per-user Nextcloud base URL that
// overrides the org-wide config (null falls back to it). Reads tolerate the legacy
// plain-password format and the earlier two-field `{username, password}` JSON.
async function storeAppPassword(userId, username, appPassword, nextcloudUrl = null) {
    await initDB();
    const user = await getUser(userId);
    if (!user) await createUser({ id: userId, username });
    try {
        const payload = JSON.stringify({ username, password: appPassword, url: nextcloudUrl || null });
        await run('UPDATE users SET "appPassword" = $1, "appPasswordCreated" = $2 WHERE id = $3',
            [JSON.stringify(encrypt(payload)), new Date().toISOString(), userId]);
        return true;
    } catch (e) { log.error(e); return false; }
}

async function getAppPassword(userId) {
    const user = await getUser(userId);
    if (!user || !user.appPassword) return null;
    const decrypted = decrypt(user.appPassword);
    if (!decrypted) return null;
    // New format: encrypted JSON { username, password, url? }. Legacy: encrypted password only.
    try {
        const parsed = JSON.parse(decrypted);
        if (parsed && typeof parsed === 'object' && parsed.password) {
            return {
                username: parsed.username || user.username,
                password: parsed.password,
                url: parsed.url || null,
                createdAt: user.appPasswordCreated
            };
        }
    } catch (_) { /* legacy bare-password path */ }
    return { username: user.username, password: decrypted, url: null, createdAt: user.appPasswordCreated };
}

async function hasAppPassword(userId) { const user = await getUser(userId); return !!(user && user.appPassword); }

async function deleteAppPassword(userId) {
    await initDB();
    const { rowCount } = await run('UPDATE users SET "appPassword" = NULL, "appPasswordCreated" = NULL WHERE id = $1', [userId]);
    return rowCount > 0;
}

module.exports = { storeAppPassword, getAppPassword, hasAppPassword, deleteAppPassword };
