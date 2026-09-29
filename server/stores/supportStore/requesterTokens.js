// @typecheck
/**
 * Requester capability tokens — the HMACs that let someone without an account
 * act on exactly one thread: read it back (access token) and rate it (CSAT
 * token).
 *
 * The two derivations are deliberately distinct — the CSAT token carries a
 * 'csat:' purpose prefix and the score — so an access token can never be
 * replayed as a vote. Keep them that way: a shared derivation would collapse
 * two capabilities into one.
 */

const crypto = require('crypto');

// ── HMAC token for anonymous requesters ───────────────────────────────────
// Anonymous threads (created via marketing form) are addressable by URL using
// a short-lived HMAC of (threadId + requesterEmail) so the requester can come
// back and read the AI reply without an account.

function _secret() {
    const s = process.env.SESSION_SECRET;
    if (!s || s.length < 32) {
        throw new Error('[SupportStore] SESSION_SECRET must be set (≥32 chars) for support thread tokens.');
    }
    return s;
}

function buildAccessToken(threadId, email) {
    const h = crypto.createHmac('sha256', _secret());
    h.update(`${threadId}:${(email || '').toLowerCase()}`);
    return h.digest('hex').slice(0, 32);
}

function verifyAccessToken(threadId, email, token) {
    if (!token || typeof token !== 'string') return false;
    const expected = buildAccessToken(threadId, email);
    // Constant-time compare. Pad/truncate user-supplied token to the expected
    // length so timingSafeEqual sees buffers of equal size regardless of input
    // — removes the tiny early-return signal when lengths differ.
    const expectedBuf = Buffer.from(expected, 'utf8');
    const candidateBuf = Buffer.alloc(expectedBuf.length, 0);
    Buffer.from(token, 'utf8').copy(candidateBuf, 0, 0, expectedBuf.length);
    const eq = crypto.timingSafeEqual(candidateBuf, expectedBuf);
    // Still require exact length to match — the constant-time work above
    // happens regardless, so this length check is no longer an information leak.
    return eq && token.length === expected.length;
}

function buildCsatToken(threadId, email, score) {
    const h = crypto.createHmac('sha256', _secret());
    // 'csat:' purpose-prefix prevents replay of a thread access token as a vote,
    // and including the score stops URL-tampering 4★ → 5★.
    h.update(`csat:${threadId}:${(email || '').toLowerCase()}:${score}`);
    return h.digest('hex').slice(0, 32);
}

function verifyCsatToken(threadId, email, score, token) {
    if (!token || typeof token !== 'string') return false;
    const expected = buildCsatToken(threadId, email, score);
    const expectedBuf = Buffer.from(expected, 'utf8');
    const candidateBuf = Buffer.alloc(expectedBuf.length, 0);
    Buffer.from(token, 'utf8').copy(candidateBuf, 0, 0, expectedBuf.length);
    return crypto.timingSafeEqual(candidateBuf, expectedBuf) && token.length === expected.length;
}

module.exports = {
    buildAccessToken,
    verifyAccessToken,
    buildCsatToken,
    verifyCsatToken,
};
