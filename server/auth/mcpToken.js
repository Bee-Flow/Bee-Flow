// @typecheck strict
/**
 * The MCP bearer token: mint it, read it, verify it.
 *
 *   bfmcp.<base64url(userId)>.<64 hex>
 *
 * The user id travels in the clear on purpose — it is not a secret, and
 * embedding it means a presented token resolves to exactly one stored secret
 * without a reverse index or a migration. Only the random half is stored, as
 * `mcp_server_token_user_<userId>` in the secret store, and it is compared in
 * constant time; a user has exactly one token, so minting again revokes the
 * previous one.
 *
 * This is a credential scheme, not an HTTP concern, and it had three consumers
 * before it had two: `routes/mcpServer.js` (which owned it), the two sibling
 * MCP routers, and `scripts/mint-mcp-token.js` — a CLI with no Express in
 * sight that had to require a ROUTER to reach the signer, which is the upward
 * edge layering.test.js counts. It lives beside certificateToken.js and
 * connectorJwt.js because signed credentials are what auth/ is for.
 *
 * Lifetime: a token stops verifying LEGACY_MCP_TOKEN_MAX_AGE_DAYS after it was
 * issued (default 365, 0 = unlimited). The issue time is kept next to the
 * secret as `<key>_issued` = { fp, at }, where `fp` is a short hash of the
 * stored half, so a re-mint (a new stored half) starts a new lifetime. The
 * mint route records it through `recordIssued`; a token from before that
 * record existed is stamped the first time it verifies.
 */

'use strict';

const crypto = require('crypto');
const configStore = require('../stores/configStore');
const issuedStore = require('../stores/user/mcpTokenIssued.mts');

const TOKEN_PREFIX = 'bfmcp';
/**
 * @param {string | null} userId
 */
const SECRET_KEY = (userId) => `mcp_server_token_user_${userId}`;
/** @param {string | null} userId */
const ISSUED_KEY = (userId) => `${SECRET_KEY(userId)}_issued`;
const DEFAULT_MAX_AGE_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The lifetime in ms; 0 = unlimited. An unreadable value falls back to the default. */
function maxAgeMs(env = process.env) {
    const raw = env.LEGACY_MCP_TOKEN_MAX_AGE_DAYS;
    const days = raw === undefined || raw === '' ? DEFAULT_MAX_AGE_DAYS : Number(raw);
    if (!Number.isFinite(days) || days < 0) return DEFAULT_MAX_AGE_DAYS * DAY_MS;
    return days * DAY_MS;
}

/** @param {string} random */
const fingerprint = (random) => crypto.createHash('sha256').update(String(random)).digest('hex').slice(0, 16);

/**
 * Record when the stored half `random` was issued.
 * @param {string | null} userId
 * @param {string} random
 * @param {number} [now]
 */
async function recordIssued(userId, random, now = Date.now()) {
    await issuedStore.writeIssued(ISSUED_KEY(userId), { fp: fingerprint(random), at: now });
}

/**
 * Drop the issue record, for a revoked token: nobody holds the stored half
 * left behind, so it has no lifetime to keep.
 * @param {string | null} userId
 */
async function clearIssued(userId) {
    await issuedStore.deleteIssued(ISSUED_KEY(userId));
}

/**
 * Whether the token with stored half `stored` is past its lifetime. A token
 * without a matching issue record is stamped now and counts as fresh.
 * @param {string} userId
 * @param {string} stored
 * @param {number} [now]
 */
async function isExpired(userId, stored, now = Date.now()) {
    const limit = maxAgeMs();
    if (limit === 0) return false;
    const issued = await issuedStore.readIssued(ISSUED_KEY(userId));
    if (!issued || issued.fp !== fingerprint(stored) || typeof issued.at !== 'number') {
        await recordIssued(userId, stored, now);
        return false;
    }
    return now - issued.at > limit;
}

/**
 * @param {string | null} userId
 */
function mintToken(userId) {
    const random = crypto.randomBytes(32).toString('hex');
    const encodedUser = Buffer.from(String(userId), 'utf8').toString('base64url');
    return { token: `${TOKEN_PREFIX}.${encodedUser}.${random}`, random };
}

/**
 * @param {string} raw
 */
function parseToken(raw) {
    if (typeof raw !== 'string') return null;
    const parts = raw.split('.');
    if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null;
    /** @type {string} */
    let userId;
    try {
        userId = Buffer.from(parts[1], 'base64url').toString('utf8');
    } catch (_) { return null; }
    if (!userId || !/^[a-f0-9]{64}$/.test(parts[2])) return null;
    return { userId, random: parts[2] };
}

/**
 * @param {string} b
 */
function safeEqual(/** @type {unknown} */ a, b) {
    const bufA = Buffer.from(String(a || ''), 'utf8');
    const bufB = Buffer.from(String(b || ''), 'utf8');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

/** Resolve a Bearer token to a Bee Flow user id, or null. */
async function authenticateToken(/** @type {unknown} */ authorization) {
    const raw = String(authorization || '').replace(/^Bearer\s+/i, '').trim();
    const parsed = parseToken(raw);
    if (!parsed) return null;
    let stored;
    try {
        stored = await configStore.getSecret(SECRET_KEY(parsed.userId));
    } catch (_) { return null; }
    if (!stored) return null;
    if (!safeEqual(stored, parsed.random)) return null;
    try {
        if (await isExpired(parsed.userId, stored)) return null;
    } catch (_) { return null; }
    return parsed.userId;
}

module.exports = { TOKEN_PREFIX, SECRET_KEY, ISSUED_KEY, mintToken, parseToken, safeEqual, authenticateToken, recordIssued, clearIssued, maxAgeMs };
