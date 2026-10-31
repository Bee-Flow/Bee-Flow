/** @typedef {import('qs').ParsedQs} ParsedQs */
// @typecheck noImplicitAny
/**
 * Session-token bridge for cross-context auth (embedded iframe, popup handoff).
 *
 * The browser's storage partitioning blocks the BeeFlow session cookie from
 * being shared between a top-level BeeFlow popup and a BeeFlow iframe embedded
 * inside another origin (e.g. Nextcloud). To bridge that gap we mint a random
 * `sessionToken` on the server, hand it to the iframe out-of-band, and let the
 * iframe present it via the `X-Session-Token` header on every request — the
 * middleware in server/index.js merges that into req.session.
 *
 * Two stores live here:
 *   - sessionTokens (`bf:stok:<token>`) — long-lived (default 1 h), used as the
 *     bearer the iframe sends with each request.
 *   - pickupTokens  (`bf:pickup:<id>`)  — short-lived (default 2 min), used
 *     once during the popup→iframe handoff right after OAuth completes.
 *
 * Both fall back to in-memory Maps if Redis isn't available, which is fine for
 * single-instance dev. Production should run with Redis so the popup process
 * and iframe process see the same store.
 */

const crypto = require('crypto');
const { getRedis } = require('../db');

const _sessionTokenFallback = new Map();
const _pickupFallback = new Map();
/** userId -> the bridge tokens minted for that user (the no-Redis index). */
const _userTokensFallback = new Map();

/**
 * The per-user index of bridge tokens: `bf:utok:<userId>`, a set of tokens.
 * It is what lets "end every session of this user" reach the tokens too. The
 * set outlives its longest member (the native TTL) and is pruned on revoke.
 */
const USER_TOKEN_INDEX_TTL_SECONDS = 30 * 24 * 60 * 60;

/** @param {unknown} data */
function userIdOf(data) {
    const id = data && typeof data === 'object' && /** @type {any} */ (data).user && /** @type {any} */ (data).user.id;
    return id ? String(id) : null;
}

/** Node fires any longer timer immediately — see setSessionToken. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * The default bridge-token TTL: an hour, which is the right answer for what
 * this bridge was built for — a popup handing a session to an iframe that is
 * open on screen right now.
 */
const SESSION_TOKEN_TTL_SECONDS = 3600;

/**
 * The TTL for a native client, which is a different animal.
 *
 * The Android app has no cookie jar to fall back on: RFC 8252 puts the OAuth
 * round trip in a Custom Tab with its own cookie store, so for an SSO sign-in
 * this token is the app's ONLY credential. At one hour, closing the app over
 * lunch was indistinguishable from signing out — while the same account in a
 * browser keeps its `connect.sid` for thirty days (server/index.js).
 *
 * So this is parity with the cookie that account already has, not a new
 * exposure: the token stands for the same session, it is held in the Android
 * Keystore, and the app is excluded from Google backup.
 */
const NATIVE_SESSION_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * @param {string} token
 */
async function getSessionToken(token) {
    const r = getRedis();
    if (r) {
        const val = await r.get(`bf:stok:${token}`);
        const data = val ? JSON.parse(val) : null;
        if (require('../auth/microsoftIdentity').isLegacyMicrosoftSession(data)) { await r.del(`bf:stok:${token}`); return null; }
        return data;
    }
    const entry = _sessionTokenFallback.get(token);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
        _sessionTokenFallback.delete(token);
        return null;
    }
    if (require('../auth/microsoftIdentity').isLegacyMicrosoftSession(entry.data)) { _sessionTokenFallback.delete(token); return null; }
    return entry.data;
}

/**
 * @param {string} token
 * @param {number} [ttlSeconds]
 * @param {unknown} data
 */
async function setSessionToken(token, data, ttlSeconds = SESSION_TOKEN_TTL_SECONDS) {
    const r = getRedis();
    const userId = userIdOf(data);
    if (r) {
        await r.set(`bf:stok:${token}`, JSON.stringify(data), 'EX', ttlSeconds);
        if (userId) {
            await r.sadd(`bf:utok:${userId}`, token);
            await r.expire(`bf:utok:${userId}`, USER_TOKEN_INDEX_TTL_SECONDS);
        }
        return;
    }
    if (userId) {
        if (!_userTokensFallback.has(userId)) _userTokensFallback.set(userId, new Set());
        _userTokensFallback.get(userId).add(token);
    }
    // The fallback has to answer the same question Redis answers — "is this
    // still valid?" — and a bare setTimeout cannot. Node's timer delay is a
    // signed 32-bit millisecond count: anything over ~24.8 days overflows and
    // fires IMMEDIATELY, which would make the LONGEST ttl the shortest one of
    // all and evict a native token the instant it was minted. So the deadline
    // lives on the row and is checked on read; the timer is only an eviction
    // hint, clamped so it can never misfire, and unref'd so a month-long timer
    // cannot hold the process open at shutdown.
    const expiresAt = Date.now() + ttlSeconds * 1000;
    _sessionTokenFallback.set(token, { data, expiresAt });
    armEviction(token, expiresAt);
}

/**
 * Schedule the eviction, re-arming across the 32-bit ceiling.
 *
 * A bare `Math.min(ttl, MAX)` would have been worse than no clamp for the one
 * TTL that needs it: a 30-day entry would be deleted at 24.8 days — five days
 * early, silently, and only on the deployment with no Redis. Firing early and
 * re-checking is the only version of this that is honest, so the timer deletes
 * nothing unless the deadline on the row has actually passed.
 * @param {number} expiresAt
 * @param {string} token
 */
function armEviction(token, expiresAt) {
    const remaining = expiresAt - Date.now();
    const timer = setTimeout(() => {
        const entry = _sessionTokenFallback.get(token);
        // Gone, or replaced by a later mint that owns its own timer.
        if (!entry || entry.expiresAt !== expiresAt) return;
        if (Date.now() >= entry.expiresAt) {
            _sessionTokenFallback.delete(token);
            return;
        }
        armEviction(token, expiresAt);
    }, Math.max(0, Math.min(remaining, MAX_TIMER_MS)));
    if (typeof timer.unref === 'function') timer.unref();
}

/**
 * Drop a bridge token now.
 *
 * Signing out has to reach the token, not just the cookie session. A bridge
 * token is a bearer: it stands on its own, the server keeps no per-user index
 * of them, and nothing else in the system can invalidate one. At an hour that
 * was a small window to leave open; at thirty days on a phone that may have
 * been handed on, lost, or signed out of deliberately, it is not.
 *
 * This revokes the token the caller PRESENTED, which is the case that matters:
 * "I signed out on this device". Tokens minted for other devices, and
 * superseded ones from earlier renewals, still live out their TTL — closing
 * that needs a per-user index this store does not have, and it is written
 * down in the PR rather than half-built here.
 * @param {string | null | undefined} token
 */
async function deleteSessionToken(token) {
    if (!token) return;
    const r = getRedis();
    if (r) {
        const val = await r.get(`bf:stok:${token}`);
        const userId = userIdOf(val ? JSON.parse(val) : null);
        await r.del(`bf:stok:${token}`);
        if (userId) await r.srem(`bf:utok:${userId}`, token);
        return;
    }
    const entry = _sessionTokenFallback.get(token);
    const userId = userIdOf(entry && entry.data);
    _sessionTokenFallback.delete(token);
    if (userId) _userTokensFallback.get(userId)?.delete(token);
}

/**
 * Drop every bridge token minted for a user: the per-user half of ending that
 * user's sessions (auth/sessionCache.js bustSessionsForUser). Returns how many
 * were dropped.
 * @param {string | null | undefined} userId
 */
async function revokeSessionTokensForUser(userId) {
    if (!userId) return 0;
    const r = getRedis();
    if (r) {
        const key = `bf:utok:${userId}`;
        const tokens = await r.smembers(key);
        if (tokens.length) await r.del(...tokens.map((/** @type {string} */ t) => `bf:stok:${t}`));
        await r.del(key);
        return tokens.length;
    }
    const tokens = _userTokensFallback.get(String(userId));
    if (!tokens) return 0;
    for (const token of tokens) _sessionTokenFallback.delete(token);
    _userTokensFallback.delete(String(userId));
    return tokens.size;
}

// ── Pickup tokens (popup → iframe handoff after OAuth) ───────────────
// The popup deposits a sessionToken under a random pickupId; the iframe claims
// it once. Pickup IDs are short-lived — long enough to cover an OAuth
// round-trip but short enough that abandoned popups don't leak claimable
// tokens.
//
// Five minutes, not two. A native client cannot claim while it is in the
// background (Android freezes JS timers under a Custom Tab), so its window
// only opens when the user comes back — after a round trip that can include a
// password manager, a second factor and first-time consent. At two minutes the
// deposit could expire before the app ever got a turn, which is indis-
// tinguishable from a failed sign-in. The token remains one-shot and is
// deleted on the first claim.

//
// The claim is bound to the client that started the sign-in. That client mints
// a secret along with the pickup id and sends only sha256(secret) — the
// `challenge` — on /auth/login/:provider; the callback files it next to the
// token, and the claim must present the secret itself. The id alone travels
// in a URL the browser navigates to, so it cannot be the whole claim key.
//
// A pickup deposited WITHOUT a challenge — a client that predates the secret —
// is claimable by id alone unless OAUTH_PICKUP_REQUIRE_CHALLENGE=1, which is
// the switch to flip once every client sends one.

/**
 * The challenge for a secret, as the clients compute it: base64url of the
 * SHA-256 of the secret's UTF-8 bytes.
 * @param {string} secret
 */
function pickupChallengeOf(secret) {
    return crypto.createHash('sha256').update(String(secret), 'utf8').digest('base64url');
}

/** What a challenge or a secret must look like to be stored or compared at all. */
const PICKUP_TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,128}$/;

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isPickupTokenShaped(value) {
    return typeof value === 'string' && PICKUP_TOKEN_SHAPE.test(value);
}

function pickupChallengeRequired() {
    return process.env.OAUTH_PICKUP_REQUIRE_CHALLENGE === '1';
}

/**
 * Whether `secret` is the one the deposit was bound to. A deposit with no
 * challenge is open by id alone only while the compatibility switch allows it.
 * @param {{ challenge?: string } | null | undefined} pickup
 * @param {unknown} secret
 */
function pickupSecretMatches(pickup, secret) {
    const challenge = pickup && pickup.challenge;
    if (!challenge) return !pickupChallengeRequired();
    if (!isPickupTokenShaped(secret)) return false;
    const expected = Buffer.from(String(challenge));
    const presented = Buffer.from(pickupChallengeOf(secret));
    return expected.length === presented.length && crypto.timingSafeEqual(expected, presented);
}

/**
 * @param {{ sessionToken: string; challenge?: string }} data
 * @param {number} [ttlSeconds]
 * @param {string} pickupId
 */
async function setPickup(pickupId, data, ttlSeconds = 300) {
    const r = getRedis();
    if (r) {
        await r.set(`bf:pickup:${pickupId}`, JSON.stringify(data), 'EX', ttlSeconds);
    } else {
        _pickupFallback.set(pickupId, data);
        // An eviction hint only; it must not keep the process alive.
        const timer = setTimeout(() => _pickupFallback.delete(pickupId), ttlSeconds * 1000);
        if (typeof timer.unref === 'function') timer.unref();
    }
}

/**
 * Take the deposit out of the store in one step: a second claimant racing the
 * first must find nothing, which get-then-del cannot promise.
 * @param {string} key
 * @param {import('ioredis').Redis} r
 */
async function takeFromRedis(r, key) {
    if (typeof r.getdel === 'function') {
        try {
            return await r.getdel(key);
        } catch (_) {
            // A Redis older than 6.2: fall through to the two-step read.
        }
    }
    const val = await r.get(key);
    if (val) await r.del(key);
    return val;
}

/**
 * One-shot: the deposit is consumed whether or not the secret matches, so a
 * claim with the wrong secret leaves nothing for a later one.
 * @param {string | ParsedQs | (string | ParsedQs)[] | undefined} pickupId
 * @param {unknown} [secret]
 */
async function claimPickup(pickupId, secret) {
    const r = getRedis();
    /** @type {{ sessionToken: string; challenge?: string } | null} */
    let pickup = null;
    if (r) {
        const val = await takeFromRedis(r, `bf:pickup:${pickupId}`);
        pickup = val ? JSON.parse(val) : null;
    } else {
        pickup = _pickupFallback.get(String(pickupId)) || null;
        if (pickup) _pickupFallback.delete(String(pickupId));
    }
    if (!pickup) return null;
    if (!pickupSecretMatches(pickup, secret)) return null;
    return await getSessionToken(pickup.sessionToken) ? pickup : null;
}

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

module.exports = {
    getSessionToken,
    setSessionToken,
    deleteSessionToken,
    revokeSessionTokensForUser,
    SESSION_TOKEN_TTL_SECONDS,
    NATIVE_SESSION_TOKEN_TTL_SECONDS,
    setPickup,
    claimPickup,
    pickupChallengeOf,
    isPickupTokenShaped,
    generateToken,
};
