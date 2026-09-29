/**
 * The ExApp's request-edge logic, free of Express and of the network:
 * the AppAPI auth header, HTML escaping, and the frame-ancestors list.
 *
 * Public: decodeAuth(header), verifyAppApiAuth(header, secret),
 * escapeHtml(s), frameAncestors(nextcloudUrl, headers).
 *
 * Invariant: with no APP_SECRET configured nobody is authenticated. An empty
 * secret used to match the header `base64("<anyone>:")`.
 */

const crypto = require('crypto');

/** AUTHORIZATION-APP-API is base64("<userId>:<APP_SECRET>"). */
function decodeAuth(header) {
    if (!header || typeof header !== 'string') return null;
    const decoded = Buffer.from(header, 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx === -1) return null;
    return { userId: decoded.slice(0, idx), secret: decoded.slice(idx + 1) };
}

/**
 * { ok: true, userId } when the header carries the shared secret and a user;
 * otherwise { ok: false, reason: 'auth' | 'no_user' }.
 */
function verifyAppApiAuth(header, secret) {
    const decoded = decodeAuth(header);
    if (!secret || !decoded) return { ok: false, reason: 'auth' };
    const given = crypto.createHash('sha256').update(decoded.secret).digest();
    const expected = crypto.createHash('sha256').update(secret).digest();
    if (!crypto.timingSafeEqual(given, expected)) return { ok: false, reason: 'auth' };
    if (!decoded.userId) return { ok: false, reason: 'no_user' };
    return { ok: true, userId: decoded.userId };
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

/**
 * The CSP frame-ancestors sources that let Nextcloud iframe this app: self,
 * the configured Nextcloud origin, and the Origin/Referer of the request.
 */
function frameAncestors(nextcloudUrl, headers = {}) {
    const ancestors = new Set(["'self'"]);
    for (const v of [nextcloudUrl, headers.origin, headers.referer]) {
        if (!v) continue;
        try { ancestors.add(new URL(v).origin); } catch { /* not a URL: skip */ }
    }
    return [...ancestors];
}

module.exports = { decodeAuth, verifyAppApiAuth, escapeHtml, frameAncestors };
