/**
 * DSR identity-verification token — the signed link in the acknowledgement
 * e-mail. Clicking it proves the requester controls the mailbox the request
 * names (identity_status → `verified_email_link`).
 *
 * Envelope: auth/lib/signedPayload (HMAC-SHA256 "payload.signature").
 * Payload:  { p: 'dsr_verify', id, e: sha256(email), o: orgId, exp }
 *   - `e` is a hash, never the address: the token travels in a URL and lands
 *     in mail logs / browser history.
 *   - 7-day expiry (the ack mail is read within days; the request itself has
 *     a one-month clock).
 *   - single use: the route stores sha256(token) in dsr_requests.verify_token_hash
 *     and burns it with dsrStore.consumeVerifyToken.
 *
 * The secret follows the signingSecret ladder: env DSR_VERIFY_SIGNING_KEY →
 * configStore 'dsr_verify_signing_key' (bootstrapped via ensureDurable) →
 * per-process random (production, loud) / dev temp file.
 */

const crypto = require('crypto');
const signedPayload = require('../../auth/lib/signedPayload');
const { createSigningSecret } = require('../../auth/lib/signingSecret');

const PURPOSE = 'dsr_verify';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

const secret = createSigningSecret({
    envVars: ['DSR_VERIFY_SIGNING_KEY'],
    devCacheName: 'beeflow-dsr-verify-secret',
    configKey: 'dsr_verify_signing_key',
    label: 'DsrVerifyToken',
    productionWarning: 'DSR_VERIFY_SIGNING_KEY is not set and no durable secret could be bootstrapped; verification links will stop working on restart.',
    productionLogLevel: 'warn',
});

function sha256Hex(s) {
    return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

/** Deterministic e-mail binding: lower-cased, trimmed, hashed. */
function emailHash(email) {
    return sha256Hex(String(email || '').trim().toLowerCase());
}

/**
 * Mint a token for one request.
 * @param {{id:number|string, email:string, orgId?:string|null, now?:number}} input
 * @returns {{token:string, tokenHash:string, exp:number}}
 */
function mint({ id, email, orgId = null, now = Date.now() }) {
    if (id == null || !email) throw new Error('id and email are required');
    const exp = now + TTL_MS;
    const token = signedPayload.sign(secret.get(), {
        p: PURPOSE, id: Number(id), e: emailHash(email), o: orgId || null, exp,
    });
    return { token, tokenHash: sha256Hex(token), exp };
}

/**
 * Verify a token against a request row. Returns the payload on success or
 * null on ANY failure — callers answer a uniform 400 `invalid_token` so a
 * probe cannot tell "expired" from "wrong request" from "wrong signature".
 *
 * @param {string} token
 * @param {{id:number|string, subject_email:string, organization_id?:string|null}} row
 * @param {{now?:number}} [opts]
 * @returns {{payload:object, tokenHash:string}|null}
 */
function check(token, row, { now = Date.now() } = {}) {
    if (typeof token !== 'string' || token.length > 2048 || !row) return null;
    const payload = signedPayload.verify(secret.get(), token);
    if (!payload || payload.p !== PURPOSE) return null;
    if (typeof payload.exp !== 'number' || payload.exp <= now) return null;
    if (Number(payload.id) !== Number(row.id)) return null;
    if (typeof payload.e !== 'string' || payload.e.length !== 64) return null;
    const expected = Buffer.from(emailHash(row.subject_email), 'hex');
    const given = Buffer.from(payload.e, 'hex');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    if ((payload.o || null) !== (row.organization_id || null)) return null;
    return { payload, tokenHash: sha256Hex(token) };
}

/** Bootstraps the durable secret (non-fatal); the route calls it at load time. */
async function ensureDurable() {
    try { return await secret.ensureDurable(); } catch { return false; }
}

module.exports = { mint, check, emailHash, sha256Hex, ensureDurable, PURPOSE, TTL_MS };
