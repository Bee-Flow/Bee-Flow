// @typecheck
/**
 * Named MCP access tokens: mint, list, revoke, resolve a presented one.
 *
 *   bfmcp_<token id, 32 hex>_<secret, 64 hex>
 *
 * The id is the row key, so a presented token resolves to exactly one row with
 * no scan. Only sha256(secret) is stored, and it is compared in constant time.
 * The plaintext token is returned once, from createToken, and exists nowhere
 * else. (The legacy `bfmcp.<user>.<hex>` scheme stays in auth/mcpToken.js.)
 *
 * The SQL lives in stores/mcpTokenStore.js; this file owns the format, the
 * validation and the last-used throttle.
 */

'use strict';

const crypto = require('node:crypto');
const { badRequest } = require('../../shared/httpErrors');
const { normalizeScopes } = require('./scopes');
const { parseCidrList } = require('./ipMatch');
const log = require('../../telemetry/log');

const TOKEN_PATTERN = /^bfmcp_([a-f0-9]{32})_([a-f0-9]{64})$/;
const MAX_NAME = 80;
const MAX_ACTIVE_PER_USER = 25;
const MAX_LIFETIME_MS = 5 * 365 * 24 * 3600 * 1000;
const TOUCH_INTERVAL_MS = 60_000;

/** Collaborator seam: the SQL layer, loaded on first use. Tests swap it. */
let repoOverride = null;
const repo = () => repoOverride || require('../../stores/mcpTokenStore');
function setRepo(next) { repoOverride = next; touched.clear(); }

const sha256 = (secret) => crypto.createHash('sha256').update(secret).digest();

function dashed(hex) {
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** `bfmcp_…` → `{ id, secret }`, or null when it is not a named-token string. */
function parsePresented(raw) {
    if (typeof raw !== 'string') return null;
    const m = TOKEN_PATTERN.exec(raw.trim());
    return m ? { id: dashed(m[1]), secret: m[2] } : null;
}

function isNamedTokenFormat(raw) {
    return typeof raw === 'string' && raw.trim().startsWith('bfmcp_');
}

function normalizeExpiry(expiresAt, now) {
    if (expiresAt === undefined || expiresAt === null || expiresAt === '') return null;
    const when = new Date(expiresAt);
    if (Number.isNaN(when.getTime())) throw badRequest('invalid_expiry', 'The expiry date is not a valid date.');
    if (when.getTime() <= now) throw badRequest('invalid_expiry', 'The expiry date must be in the future.');
    if (when.getTime() > now + MAX_LIFETIME_MS) throw badRequest('invalid_expiry', 'A token can be valid for five years at most.');
    return when.toISOString();
}

/**
 * Mint a token. The plaintext is in the result once and is never stored.
 *
 * @param {{ userId: string, orgId?: string|null, name: string, scopes: unknown,
 *           ipAllowlist?: unknown, expiresAt?: string|Date|null, now?: number }} input
 * @returns {Promise<{ token: string, record: object }>}
 * @throws {import('../../shared/httpErrors').HttpError} 400 on invalid input
 */
async function createToken({ userId, orgId = null, name, scopes, ipAllowlist, expiresAt, now = Date.now() }) {
    if (!userId) throw new Error('createToken needs a userId');
    const cleanName = typeof name === 'string' ? name.trim() : '';
    if (!cleanName) throw badRequest('invalid_name', 'Give the token a name.');
    if (cleanName.length > MAX_NAME) throw badRequest('invalid_name', `A token name can be ${MAX_NAME} characters at most.`);
    const cleanScopes = normalizeScopes(scopes);
    const cleanIps = parseCidrList(ipAllowlist);
    const expiry = normalizeExpiry(expiresAt, now);

    if (await repo().countActiveByUser(userId) >= MAX_ACTIVE_PER_USER) {
        throw badRequest('too_many_tokens', `You can hold ${MAX_ACTIVE_PER_USER} active tokens at most. Revoke one first.`);
    }

    const id = crypto.randomUUID();
    const secret = crypto.randomBytes(32).toString('hex');
    const record = await repo().insert({
        id,
        userId,
        orgId,
        name: cleanName,
        secretHash: sha256(secret).toString('hex'),
        scopes: cleanScopes,
        ipAllowlist: cleanIps,
        expiresAt: expiry,
    });
    return { token: `bfmcp_${id.replace(/-/g, '')}_${secret}`, record };
}

/** The caller's tokens, newest first, without any secret material. */
async function listTokens(userId) {
    return repo().listByUser(userId);
}

/** Revoke one of the user's tokens. Returns the record, or null when it is not theirs. */
async function revokeToken(userId, id) {
    const record = await repo().revoke(userId, id);
    touched.delete(id);
    return record;
}

/**
 * Switch one of the user's tokens off or back on, without touching its secret.
 * Returns the record, or null when it is not theirs.
 * @throws {import('../../shared/httpErrors').HttpError} 400 token_revoked: a revoked token stays revoked
 */
async function setTokenEnabled(userId, id, enabled) {
    const record = await repo().setEnabled(userId, id, enabled === true);
    if (record && record.revokedAt) throw badRequest('token_revoked', 'This token has been revoked for good, so it cannot be switched on or off.');
    return record;
}

/**
 * Resolve a presented token string to its record, or null. A revoked or
 * expired token IS returned (the gate names the reason in its log); a wrong
 * secret, an unknown id and a malformed string are all null.
 */
async function findByPresented(tokenString) {
    const parsed = parsePresented(tokenString);
    if (!parsed) return null;
    const found = await repo().getWithHash(parsed.id);
    // Compare against a dummy when the row is missing so a hit and a miss cost
    // about the same.
    const stored = found ? Buffer.from(found.secretHash, 'hex') : Buffer.alloc(32);
    const presented = sha256(parsed.secret);
    const equal = stored.length === presented.length && crypto.timingSafeEqual(stored, presented);
    return found && equal ? found.record : null;
}

/**
 * A named token's record by id, without any secret material. Revoked and
 * expired tokens ARE returned (the caller decides); an unknown or malformed id is
 * null. For callers that already authenticated the token once and need to ask
 * again whether it is still good, e.g. a one-time upload URL it issued.
 */
async function getTokenById(id) {
    if (typeof id !== 'string' || !/^[0-9a-f-]{32,36}$/i.test(id)) return null;
    const found = await repo().getWithHash(id);
    return found ? found.record : null;
}

/** id → ms of the last write to the table; keeps last_used_at to one write a minute. */
const touched = new Map();

/** Record use, at most once a minute per token. Never throws, never awaits the caller. */
function touchLastUsed(id, now = Date.now()) {
    if (!id) return;
    const last = touched.get(id);
    if (last !== undefined && now - last < TOUCH_INTERVAL_MS) return;
    if (touched.size >= 5000) touched.clear();
    touched.set(id, now);
    Promise.resolve()
        .then(() => repo().touch(id))
        .catch((err) => log.debug(`[McpAccess] could not record last use: ${err.message}`));
}

module.exports = {
    createToken,
    listTokens,
    revokeToken,
    setTokenEnabled,
    findByPresented,
    getTokenById,
    touchLastUsed,
    parsePresented,
    isNamedTokenFormat,
    MAX_ACTIVE_PER_USER,
    _test: { setRepo },
};
