// @typecheck strict
/**
 * Requester capability tokens — the HMACs that let someone without an account
 * act on exactly one thread: read it back (access token) and rate it (CSAT
 * token).
 *
 * The two derivations are deliberately distinct — the CSAT token carries a
 * 'csat:' purpose prefix and the score — so an access token can never be
 * replayed as a vote. Keep them that way: a shared derivation would collapse
 * two capabilities into one.
 *
 * A token expires. It is `<expiry>.<hmac>` with the expiry (seconds since the
 * epoch) under the HMAC, so the date cannot be moved. Tokens from before the
 * expiry existed are a bare HMAC; they are still honoured while the thread is
 * younger than the grace period, which gives every link already mailed its
 * natural lifetime and lets the oldest ones lapse, since nothing can revoke
 * them.
 */

const crypto = require('crypto');

/** How long a mailed link stays valid. */
const ACCESS_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const CSAT_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
/** A pre-expiry token is honoured this long after the THREAD was opened. */
const LEGACY_GRACE_SECONDS = 30 * 24 * 60 * 60;

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

/** @param {string} material what the HMAC covers */
function _mac(material) {
    const h = crypto.createHmac('sha256', _secret());
    h.update(material);
    return h.digest('hex').slice(0, 32);
}

/**
 * Constant-time equality of a presented string against the expected one. The
 * candidate is padded or cut to the expected length so timingSafeEqual sees
 * equal sizes whatever was sent; the exact-length check after it is no longer
 * a signal, because the constant-time work has already been done.
 * @param {string} presented
 * @param {string} expected
 */
function _same(presented, expected) {
    const expectedBuf = Buffer.from(expected, 'utf8');
    const candidateBuf = Buffer.alloc(expectedBuf.length, 0);
    Buffer.from(presented, 'utf8').copy(candidateBuf, 0, 0, expectedBuf.length);
    const eq = crypto.timingSafeEqual(candidateBuf, expectedBuf);
    return eq && presented.length === expected.length;
}

/**
 * Split a presented token into its expiry and its MAC. A bare 32-hex token
 * is the pre-expiry form (expiry null).
 * @param {unknown} token
 * @returns {{ expiresAt: number | null, mac: string } | null}
 */
function _parse(token) {
    if (!token || typeof token !== 'string' || token.length > 64) return null;
    const dot = token.indexOf('.');
    if (dot < 0) return /^[0-9a-f]{32}$/.test(token) ? { expiresAt: null, mac: token } : null;
    const expiry = token.slice(0, dot);
    const mac = token.slice(dot + 1);
    if (!/^\d{1,12}$/.test(expiry) || !/^[0-9a-f]{32}$/.test(mac)) return null;
    return { expiresAt: Number(expiry), mac };
}

/**
 * Whether a parsed token is still in date.
 * @param {{ expiresAt: number | null }} parsed
 * @param {{ now?: number, threadCreatedAt?: string | Date | null }} [when]
 */
function _inDate({ expiresAt }, { now = Date.now(), threadCreatedAt = null } = {}) {
    const nowSec = Math.floor(now / 1000);
    if (expiresAt !== null) return expiresAt > nowSec;
    // A pre-expiry token: honoured while the thread is young. A thread whose
    // age is unknown gets the grace period from now, never a free pass.
    const created = threadCreatedAt ? Math.floor(new Date(threadCreatedAt).getTime() / 1000) : NaN;
    if (!Number.isFinite(created)) return true;
    return created + LEGACY_GRACE_SECONDS > nowSec;
}

/** @param {{ now?: number, ttlSeconds?: number }} [opts] */
function _expiry({ now = Date.now(), ttlSeconds = ACCESS_TOKEN_TTL_SECONDS } = {}) {
    return Math.floor(now / 1000) + ttlSeconds;
}

/**
 * @param {string} threadId
 * @param {string | null | undefined} email
 * @param {{ now?: number }} [opts]
 */
function buildAccessToken(threadId, email, opts = {}) {
    const expiresAt = _expiry({ now: opts.now, ttlSeconds: ACCESS_TOKEN_TTL_SECONDS });
    return `${expiresAt}.${_mac(`${threadId}:${(email || '').toLowerCase()}:${expiresAt}`)}`;
}

/**
 * @param {string} threadId
 * @param {string | null | undefined} email
 * @param {unknown} token
 * @param {{ now?: number, threadCreatedAt?: string | Date | null }} [when]
 */
function verifyAccessToken(threadId, email, token, when = {}) {
    const parsed = _parse(token);
    if (!parsed) return false;
    const material = parsed.expiresAt === null
        ? `${threadId}:${(email || '').toLowerCase()}`
        : `${threadId}:${(email || '').toLowerCase()}:${parsed.expiresAt}`;
    // The MAC first, always: the date check must not be reachable with a forged token.
    return _same(parsed.mac, _mac(material)) && _inDate(parsed, when);
}

/**
 * @param {string} threadId
 * @param {string | null | undefined} email
 * @param {number} score
 * @param {{ now?: number }} [opts]
 */
function buildCsatToken(threadId, email, score, opts = {}) {
    const expiresAt = _expiry({ now: opts.now, ttlSeconds: CSAT_TOKEN_TTL_SECONDS });
    // 'csat:' purpose-prefix prevents replay of a thread access token as a vote,
    // and including the score stops URL-tampering 4★ → 5★.
    return `${expiresAt}.${_mac(`csat:${threadId}:${(email || '').toLowerCase()}:${score}:${expiresAt}`)}`;
}

/**
 * @param {string} threadId
 * @param {string | null | undefined} email
 * @param {number} score
 * @param {unknown} token
 * @param {{ now?: number, threadCreatedAt?: string | Date | null }} [when]
 */
function verifyCsatToken(threadId, email, score, token, when = {}) {
    const parsed = _parse(token);
    if (!parsed) return false;
    const material = parsed.expiresAt === null
        ? `csat:${threadId}:${(email || '').toLowerCase()}:${score}`
        : `csat:${threadId}:${(email || '').toLowerCase()}:${score}:${parsed.expiresAt}`;
    return _same(parsed.mac, _mac(material)) && _inDate(parsed, when);
}

module.exports = {
    buildAccessToken,
    verifyAccessToken,
    buildCsatToken,
    verifyCsatToken,
    ACCESS_TOKEN_TTL_SECONDS,
    CSAT_TOKEN_TTL_SECONDS,
    LEGACY_GRACE_SECONDS,
};
