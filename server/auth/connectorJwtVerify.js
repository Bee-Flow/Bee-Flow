// @typecheck strict
/**
 * The token checks of the Nextcloud Connector JWT middleware (connectorJwt.js
 * is the entry point): HS256 verification against one candidate tenant key,
 * and the best-effort domain read of a token that did NOT verify.
 */

const crypto = require('crypto');

/** @param {string} str */
function _b64urlDecode(str) {
    const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
    return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

/** @param {Buffer} a @param {Buffer} b */
function _timingSafeEq(a, b) {
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

// The longest `exp` a connector token may carry, with a margin for the two
// clocks. 15 minutes is three times the connector's default TTL.
const MAX_TOKEN_LIFETIME_SECONDS = 15 * 60;
const CLOCK_SKEW_SECONDS = 60;

/**
 * Verify an HS256 JWT against a candidate key. Returns the decoded payload
 * on success, throws on any failure (signature mismatch, expired, missing or
 * too-long expiry, malformed).
 * @param {string} token
 * @param {string} key
 * @returns {Record<string, any>}
 */
function _verifyHs256(token, key) {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('malformed JWT');
    const [hB64, pB64, sB64] = parts;

    const header = JSON.parse(_b64urlDecode(hB64).toString('utf8'));
    if (header.alg !== 'HS256') throw new Error(`unexpected alg: ${header.alg}`);
    if (header.typ && header.typ !== 'JWT') throw new Error(`unexpected typ: ${header.typ}`);

    const expected = crypto.createHmac('sha256', key)
        .update(`${hB64}.${pB64}`)
        .digest();
    const provided = _b64urlDecode(sB64);
    if (!_timingSafeEq(expected, provided)) throw new Error('signature mismatch');

    const payload = JSON.parse(_b64urlDecode(pB64).toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    // Every connector mint sets `exp` (auth.js: BEEFLOW_JWT_TTL_SECONDS,
    // default 300; bootstrap.js rotate-key: 60), so a token without one, or
    // one that outlives the ceiling, did not come from a connector.
    if (!Number.isFinite(payload.exp)) throw new Error('token has no expiry');
    if (now >= payload.exp) throw new Error('token expired');
    if (payload.exp - now > MAX_TOKEN_LIFETIME_SECONDS + CLOCK_SKEW_SECONDS) throw new Error('token lifetime too long');
    if (payload.nbf && now < payload.nbf) throw new Error('token not yet valid');
    if (payload.iss && payload.iss !== 'nextcloud-connector') throw new Error(`unexpected iss: ${payload.iss}`);
    if (payload.aud && payload.aud !== 'beeflow.nl') throw new Error(`unexpected aud: ${payload.aud}`);

    return payload;
}

/**
 * Best-effort email-DOMAIN extraction from an UNVERIFIED JWT payload. Used
 * only to attribute 'no matching tenant key' failures to a customer bucket
 * (subject `domain:<d>`); the token did not verify, so the value is spoofable
 * and is stored domain-only with meta.unverified=true. Never throws.
 * @param {unknown} token
 */
function _unverifiedEmailDomain(token) {
    try {
        const payload = JSON.parse(_b64urlDecode(String(token).split('.')[1]).toString('utf8'));
        const email = String(payload?.email || '');
        const domain = email.includes('@') ? email.split('@')[1].trim().toLowerCase() : '';
        return domain || null;
    } catch (_) {
        return null;
    }
}

module.exports = { _verifyHs256, _unverifiedEmailDomain, MAX_TOKEN_LIFETIME_SECONDS };
