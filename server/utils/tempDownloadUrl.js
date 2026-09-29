// @typecheck
/**
 * HMAC-signed, time-limited download URLs for storage objects.
 *
 * An external service — Azure Whisper batch, a model provider fetching an
 * image — must sometimes read one object without a session. The URL carries
 * the key, an expiry and an HMAC over both; routes/storageProxy.js serves it.
 * Server-side readers (core/documents/imageInline.js) verify the same
 * signature through resolveTempDownloadKey instead of going over HTTP, so the
 * route and the readers enforce exactly one rule set.
 */

const crypto = require('crypto');

const HMAC_SECRET = process.env.SESSION_SECRET;
if (!HMAC_SECRET || HMAC_SECRET.length < 32) {
    throw new Error('[tempDownloadUrl] SESSION_SECRET must be set (≥32 chars) — used as HMAC key for time-limited download URLs.');
}

/**
 * True when a key contains anything that could escape its prefix once resolved
 * to a filesystem path.
 *
 * The prefix checks (`users/{id}/`, `shared/`, `transcription-tmp/`) are plain
 * string comparisons, so they run BEFORE any normalization: without this guard
 * `users/<me>/../../users/<victim>/x` satisfies `startsWith('users/<me>/')` and
 * then resolves, inside storageStore's local-disk mode, to the victim's file —
 * localPathFor only guarantees containment in the storage ROOT, not in the
 * caller's own prefix. S3 treats keys literally so only local mode is
 * exploitable, but that is the default self-host configuration.
 */
function hasTraversal(key) {
    if (typeof key !== 'string') return true;
    if (key.includes('\\') || key.includes('\0')) return true;
    return key.split('/').some((seg) => seg === '..');
}

// Keys eligible for temp (HMAC-signed, unauthenticated) downloads:
//   - `transcription-tmp/`                          — audio for Azure Whisper batch
//   - `users/{userId}/attachments|uploads/`         — images uploaded for AI inference
//   - `studio-apps/{owner}/{app}/attachments/{sha}` — App Studio attachments handed
//     to automations by an app_trigger run (appStudio/actionExecutor.js); the
//     sha256 segment is strict so only content-addressed attachment blobs (never
//     data.db or other app objects) can be minted.
function isTempDownloadKey(key) {
    if (hasTraversal(key)) return false;
    return key.startsWith('transcription-tmp/')
        || /^users\/[^/]+\/(attachments|uploads)\//.test(key)
        || /^studio-apps\/[^/]+\/[^/]+\/attachments\/[a-f0-9]{64}$/.test(key);
}

/**
 * Generate a time-limited, HMAC-signed public URL for a storage key.
 * Allowed key prefixes: see isTempDownloadKey.
 *
 * @param {string} key - storage object key
 * @param {number} ttlSeconds - URL lifetime (default: 900 = 15 min)
 * @returns {string} Full public URL
 */
function generateTempDownloadUrl(key, ttlSeconds = 900) {
    if (!isTempDownloadKey(key)) {
        throw new Error('Temp download URLs only allowed for transcription-tmp/, users/{id}/attachments|uploads/, or studio-app attachment keys');
    }
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    const payload = `${key}:${expires}`;
    const token = crypto.createHmac('sha256', HMAC_SECRET).update(payload).digest('hex');
    const encodedKey = encodeURIComponent(key);

    const protocol = process.env.SERVER_PROTOCOL || 'https';
    const host = process.env.SERVER_PUBLIC_HOST || 'localhost:3002';
    return `${protocol}://${host}/api/storage/tmp/${token}?key=${encodedKey}&expires=${expires}`;
}

/**
 * Verify a temp-download signature. Pure (no req/res) so the route and
 * server-side readers enforce EXACTLY the same rules.
 *
 * @returns {'ok'|'missing'|'forbidden'|'expired'|'invalid_token'}
 */
function verifyTempSignature(key, expires, token) {
    if (!key || !expires || !token) return 'missing';
    if (!isTempDownloadKey(key)) return 'forbidden';
    if (Math.floor(Date.now() / 1000) > expires) return 'expired';

    const payload = `${key}:${expires}`;
    const expected = crypto.createHmac('sha256', HMAC_SECRET).update(payload).digest('hex');
    // timingSafeEqual THROWS on a length mismatch, and the token is
    // attacker-controlled (odd length / non-hex chars truncate the buffer),
    // so compare lengths first — otherwise a malformed token surfaces as a
    // generic 500 from the caller instead of a clean rejection.
    const tokenBuf = Buffer.from(token, 'hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    if (tokenBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(tokenBuf, expectedBuf)) {
        return 'invalid_token';
    }
    return 'ok';
}

/**
 * Parse a temp-download URL back into its storage key, verifying the signature
 * and expiry the same way the route does. Returns null for anything that isn't
 * a currently-valid temp URL — callers must treat null as "not readable".
 */
function resolveTempDownloadKey(url) {
    if (typeof url !== 'string' || !url.includes('/api/storage/tmp/')) return null;
    let parsed;
    try {
        // Base only matters for relative inputs; the origin is never used.
        parsed = new URL(url, 'http://internal.invalid');
    } catch {
        return null;
    }
    const match = parsed.pathname.match(/\/api\/storage\/tmp\/([^/]+)$/);
    if (!match) return null;
    const key = parsed.searchParams.get('key');
    const expires = parseInt(parsed.searchParams.get('expires'), 10);
    return verifyTempSignature(key, expires, decodeURIComponent(match[1])) === 'ok' ? key : null;
}

module.exports = {
    hasTraversal,
    isTempDownloadKey,
    generateTempDownloadUrl,
    verifyTempSignature,
    resolveTempDownloadKey,
};
