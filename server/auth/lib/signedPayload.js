// @typecheck
/**
 * The HMAC-SHA256 "payload.signature" envelope shared by the signed-token
 * modules (publicShareToken, webpagePreviewToken).
 *
 * Wire format — unchanged from the copies this replaces, so tokens minted by
 * either version verify against the other:
 *
 *     base64url(JSON(payload)) "." base64url(hmac_sha256(secret, payloadB64))
 *
 * `verify` does the crypto only: shape, constant-time signature comparison,
 * JSON parse. It deliberately does NOT interpret the payload — purpose tags,
 * expiry and subject binding are each module's policy and stay there, where
 * they are readable next to the thing they protect.
 */

const crypto = require('crypto');

function b64urlEncode(buf) {
    return Buffer.from(buf).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
    const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
    return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

/**
 * Sign a JSON-serializable payload.
 * @param {Buffer|string} secret
 * @param {object} payload
 * @returns {string} the token
 */
function sign(secret, payload) {
    const payloadB64 = b64urlEncode(JSON.stringify(payload));
    const sig = crypto.createHmac('sha256', secret).update(payloadB64).digest();
    return `${payloadB64}.${b64urlEncode(sig)}`;
}

/**
 * Verify a token's signature and return the parsed payload, or null on any
 * failure (bad shape, bad signature, unparseable payload). Never throws.
 *
 * @param {Buffer|string} secret
 * @param {string} token
 * @returns {object|null}
 */
function verify(secret, token) {
    if (typeof token !== 'string') return null;
    const dot = token.indexOf('.');
    if (dot < 1 || dot === token.length - 1) return null;
    const payloadB64 = token.slice(0, dot);
    const sigB64 = token.slice(dot + 1);

    let expectedSig;
    try { expectedSig = crypto.createHmac('sha256', secret).update(payloadB64).digest(); }
    catch (_) { return null; }

    let providedSig;
    try { providedSig = b64urlDecode(sigB64); } catch (_) { return null; }
    if (providedSig.length !== expectedSig.length) return null;
    if (!crypto.timingSafeEqual(providedSig, expectedSig)) return null;

    try {
        const payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8'));
        return (payload && typeof payload === 'object') ? payload : null;
    } catch (_) {
        return null;
    }
}

module.exports = { sign, verify, b64urlEncode, b64urlDecode };
