// @typecheck
// HMAC-based identifiers for Learning Center certificates.
//
// Two derived values, both HMAC-SHA256 over the canonical issuance tuple so they
// are DETERMINISTIC (re-issuing the same certificate to the same user reproduces
// the same serial and verify token — idempotency for free) and UNFORGEABLE without
// the server secret:
//
//   serial      — human-facing "BF-XXXX-XXXX-XXXX" printed on the certificate.
//   verifyToken — the secret in the public /verify/:token URL. The public lookup
//                 index is keyed by sha256(verifyToken) so a leaked configStore
//                 dump yields no working URLs (same property as publicViewer).
//
// Secret precedence: LEARNING_CERT_SECRET || PUBLIC_SHARE_TOKEN_SECRET, then a
// configStore-persisted secret bootstrapped at startup (ensureDurableSecret),
// with the same on-disk dev fallback as publicShareToken.js. The per-process
// random fallback is last resort only — it breaks every public verify link on
// restart, so issuance refuses makePublic while it's active (hasDurableSecret).

const crypto = require('crypto');
const { createSigningSecret } = require('./lib/signingSecret');

// The env → configStore → prod-random → dev-disk ladder lives in lib/
// signingSecret.js, shared with webpagePreviewToken and publicShareToken.
// The parameters below stay per-feature on purpose: a secret scoped to
// certificates must not end up signing preview or share tokens.
const secret = createSigningSecret({
    envVars: ['LEARNING_CERT_SECRET', 'PUBLIC_SHARE_TOKEN_SECRET'],
    devCacheName: 'beeflow-learning-cert-secret',
    configKey: 'learning_cert_secret',
    label: 'CertificateToken',
    productionWarning: 'LEARNING_CERT_SECRET / PUBLIC_SHARE_TOKEN_SECRET not set and the startup bootstrap has not run — certificate serials and verify links will change on every restart. Set LEARNING_CERT_SECRET (32+ chars) to fix this permanently.',
});

// True when serials/verify tokens survive a restart (env, bootstrapped, or
// persisted dev secret). The issue endpoint refuses public certificates when
// this is false rather than minting links that will silently die.
const hasDurableSecret = secret.hasDurable;

// Startup bootstrap for installs that never set the env var: persist a random
// secret in configStore once, and use it for every subsequent boot. Called from
// server startup; safe to call repeatedly (setSecretIfAbsent is ON CONFLICT DO
// NOTHING). Env secrets always win — installs that set one are untouched.
const ensureDurableSecret = secret.ensureDurable;

function hmac(input) {
    return crypto.createHmac('sha256', secret.get()).update(input).digest();
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // no I,L,O,U — unambiguous
function toBase32(buf, len) {
    let bits = 0;
    let value = 0;
    let out = '';
    for (let i = 0; i < buf.length && out.length < len; i += 1) {
        value = (value << 8) | buf[i];
        bits += 8;
        while (bits >= 5 && out.length < len) {
            out += CROCKFORD[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    return out;
}

// "BF-XXXX-XXXX-XXXX" — deterministic per (certId, userId, issuedDayUTC).
function makeSerial(certId, userId, issuedDayUTC) {
    const digest = hmac(`serial|${certId}|${userId}|${issuedDayUTC}`);
    const body = toBase32(digest, 12);
    return `BF-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
}

// Deterministic public verify token (base64url) per (certId, userId).
function makeVerifyToken(certId, userId) {
    const digest = hmac(`verify|${certId}|${userId}`);
    return digest.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Public lookup key: clients present the verifyToken; we index by its hash so the
// stored index reveals nothing usable on its own.
function tokenHash(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

module.exports = { makeSerial, makeVerifyToken, tokenHash, hasDurableSecret, ensureDurableSecret };
