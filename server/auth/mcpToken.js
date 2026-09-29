// @typecheck
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
 */

'use strict';

const crypto = require('crypto');
const configStore = require('../stores/configStore');

const TOKEN_PREFIX = 'bfmcp';
const SECRET_KEY = (userId) => `mcp_server_token_user_${userId}`;

function mintToken(userId) {
    const random = crypto.randomBytes(32).toString('hex');
    const encodedUser = Buffer.from(String(userId), 'utf8').toString('base64url');
    return { token: `${TOKEN_PREFIX}.${encodedUser}.${random}`, random };
}

function parseToken(raw) {
    if (typeof raw !== 'string') return null;
    const parts = raw.split('.');
    if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null;
    let userId;
    try {
        userId = Buffer.from(parts[1], 'base64url').toString('utf8');
    } catch (_) { return null; }
    if (!userId || !/^[a-f0-9]{64}$/.test(parts[2])) return null;
    return { userId, random: parts[2] };
}

function safeEqual(a, b) {
    const bufA = Buffer.from(String(a || ''), 'utf8');
    const bufB = Buffer.from(String(b || ''), 'utf8');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

/** Resolve a Bearer token to a Bee Flow user id, or null. */
async function authenticateToken(authorization) {
    const raw = String(authorization || '').replace(/^Bearer\s+/i, '').trim();
    const parsed = parseToken(raw);
    if (!parsed) return null;
    let stored;
    try {
        stored = await configStore.getSecret(SECRET_KEY(parsed.userId));
    } catch (_) { return null; }
    if (!stored) return null;
    return safeEqual(stored, parsed.random) ? parsed.userId : null;
}

module.exports = { TOKEN_PREFIX, SECRET_KEY, mintToken, parseToken, safeEqual, authenticateToken };
