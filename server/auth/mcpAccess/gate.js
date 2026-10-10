// @typecheck
/**
 * One access gate for every Bee Flow MCP endpoint.
 *
 * `evaluateAccess` is the pure decision, in the order the design fixes:
 *
 *   1. the token exists, is not revoked, not expired and not switched off;
 *   2. its user exists and the account is active;
 *   3. the org policy: MCP enabled, this user allowed, a legacy token allowed;
 *   4. the client IP is inside the org allow-list (when it has entries);
 *   5. the client IP is inside the token's own allow-list (strictest wins);
 *   6. the token has the server the request is for.
 *
 * `gateRequest` is the Express-facing wrapper: it resolves the bearer, loads
 * the user, account state and policy, applies the per-token rate limit and
 * records use. The per-tool check (tools/list filtering, tools/call re-check)
 * is scopes.js, called by each router with the scopes this returns.
 *
 * A user may belong to several organisations (through groups, with or without a
 * home org). The org policy binds every one of them, so the checks from 3 to 5
 * run once per org and the first refusal wins (`evaluateAccessForOrgs`).
 *
 * A refusal never says which check failed (see rpcDenied): the reason goes to
 * the operator's log with the token id, never the token.
 */

'use strict';

const { authenticateToken } = require('../mcpToken');
const { isActiveAccount } = require('../accountStatusGate');
const { LEGACY_SCOPES } = require('./scopes');
const { ipAllowed } = require('./ipMatch');
const { userAllowedByPolicy } = require('./orgPolicy');
const tokenStore = require('./tokenStore');
const { MAX_BATCH_SIZE } = require('./batch');
const log = require('../../telemetry/log');

const RATE_LIMIT_PER_MINUTE = 120;
// Across ALL of a user's tokens, so many tokens do not multiply the budget.
const USER_RATE_LIMIT_PER_MINUTE = 300;


/** @typedef {{ ok: boolean, status?: number, reason?: string }} Decision */
/**
 * @typedef {{
 *   ok: boolean, status?: number, reason?: string, retryAfter?: number,
 *   user?: any, orgId?: string|null,
 *   token?: { id: string|null, name: string, scopes: any, legacy: boolean },
 * }} GateResult
 */

/**
 * Pure access decision.
 *
 * @param {{
 *   token: null | { orgId?: string|null, revokedAt?: string|null, expiresAt?: string|null, disabledAt?: string|null, ipAllowlist?: string[], scopes?: object, legacy?: boolean },
 *   user: null | { id: string, organizationId?: string|null, orgRole?: string },
 *   orgIds?: string[],
 *   accountActive: boolean,
 *   policy: any,
 *   ip: string|null|undefined,
 *   server?: string,
 *   now?: number,
 * }} input
 * @returns {Decision}
 */
function evaluateAccess({ token, user, orgIds, accountActive, policy, ip, server, now = Date.now() }) {
    if (!token) return { ok: false, status: 401, reason: 'token_unknown' };
    if (token.revokedAt) return { ok: false, status: 401, reason: 'token_revoked' };
    if (token.expiresAt && new Date(token.expiresAt).getTime() <= now) return { ok: false, status: 401, reason: 'token_expired' };

    // Switched off by its owner (reversible; a revoked token is gone for good).
    if (token.disabledAt) return { ok: false, status: 401, reason: 'token_disabled' };

    if (!user) return { ok: false, status: 403, reason: 'user_missing' };
    if (!accountActive) return { ok: false, status: 403, reason: 'account_inactive' };
    // A token minted in one org does not follow its user into another. With the
    // resolved org list (home org and group orgs) the token's org must be one of
    // them; without it, the home org is all there is to compare.
    if (token.orgId && (Array.isArray(orgIds)
        ? !orgIds.includes(token.orgId)
        : user.organizationId && token.orgId !== user.organizationId)) {
        return { ok: false, status: 403, reason: 'token_org_mismatch' };
    }

    if (!policy || policy.enabled === false) return { ok: false, status: 403, reason: 'mcp_disabled' };
    if (!userAllowedByPolicy(policy, user)) return { ok: false, status: 403, reason: 'user_not_allowed' };
    if (token.legacy && policy.rejectLegacyTokens) return { ok: false, status: 403, reason: 'legacy_rejected' };

    if (!ipAllowed(ip, policy.ipAllowlist)) return { ok: false, status: 403, reason: 'ip_outside_org_list' };
    if (!ipAllowed(ip, token.ipAllowlist)) return { ok: false, status: 403, reason: 'ip_outside_token_list' };

    if (server !== undefined && !(token.scopes && token.scopes[server])) {
        return { ok: false, status: 403, reason: 'server_not_in_scope' };
    }
    return { ok: true };
}

/**
 * `evaluateAccess` against the policy of EVERY org the user belongs to; the
 * first refusal wins, so the strictest org decides.
 *
 * @param {{ token: any, user: any, orgIds?: string[], accountActive: boolean, policies: any[],
 *           ip: string|null|undefined, server?: string, now?: number }} input
 * @returns {Decision}
 */
function evaluateAccessForOrgs({ policies, ...rest }) {
    if (!Array.isArray(policies) || policies.length === 0) return evaluateAccess({ ...rest, policy: null });
    for (const policy of policies) {
        const decision = evaluateAccess({ ...rest, policy });
        if (!decision.ok) return decision;
    }
    return { ok: true };
}

/** Collaborators, loaded on first use; tests pass their own as `gateRequest`'s third argument. */
const defaultDeps = {
    getUser: (id) => require('../../stores/userStore').getUser(id),
    getOrgMcpPolicy: (orgId) => require('./orgPolicy').getOrgMcpPolicy(orgId),
    resolveOrgs: (user) => require('./orgResolve').resolveMcpOrgs(user),
    findByPresented: (raw) => tokenStore.findByPresented(raw),
    authenticateLegacy: (header) => authenticateToken(header),
    touchLastUsed: (id) => tokenStore.touchLastUsed(id),
    rateLimit: (key, cost) => rateLimitCheck(key, cost),
    rateLimitUser: (key, cost) => userRateLimitCheck(key, cost),
};

const limiters = {};

/**
 * Run a shared limiter outside Express: `{ ok }` or `{ ok: false, retryAfter }`.
 * `cost` is the number of JSON-RPC messages the request carries.
 */
function checkLimiter(kind, key, cost) {
    if (!limiters[kind.name]) {
        const { perUserRateLimit } = require('../../utils/perUserRateLimit');
        limiters[kind.name] = perUserRateLimit({
            windowMs: 60_000,
            max: kind.max,
            name: kind.name,
            keyFn: (req) => req.mcpRateKey,
            costFn: (req) => req.mcpRateCost,
        });
    }
    const limiter = limiters[kind.name];
    return new Promise((resolve) => {
        const res = {
            headers: {},
            set(name, value) { this.headers[name] = value; return this; },
            status() { return this; },
            json() { resolve({ ok: false, retryAfter: Number(this.headers['Retry-After']) || 60 }); return this; },
        };
        limiter({ mcpRateKey: key, mcpRateCost: cost }, res, () => resolve({ ok: true }));
    });
}

const rateLimitCheck = (key, cost = 1) => checkLimiter({ name: 'mcp-token', max: RATE_LIMIT_PER_MINUTE }, key, cost);
const userRateLimitCheck = (key, cost = 1) => checkLimiter({ name: 'mcp-user', max: USER_RATE_LIMIT_PER_MINUTE }, key, cost);

/**
 * What this request costs: one unit per JSON-RPC message in a batch. Capped one
 * past the batch limit, which is enough to be refused by the router and keeps
 * the cost below the limiter's budget.
 */
function requestCost(req) {
    return Array.isArray(req?.body) ? Math.min(MAX_BATCH_SIZE + 1, Math.max(1, req.body.length)) : 1;
}

const bearerOf = (header) => String(header || '').replace(/^Bearer\s+/i, '').trim();

/**
 * Authenticate and authorise one request to MCP `server` ('integrations' |
 * 'automations' | 'studio' | 'cms').
 *
 * @param {import('express').Request} req
 * @param {string} server
 * @param {Partial<typeof defaultDeps>} [overrides] test seam
 * @returns {Promise<GateResult>}
 */
async function gateRequest(req, server, overrides = {}) {
    const d = { ...defaultDeps, ...overrides };
    const header = req.headers?.authorization;
    const bearer = bearerOf(header);
    const ip = req.ip;

    /** @returns {GateResult} */
    const deny = (status, reason, tokenId, extra = '') => {
        // The reason stays in the operator's log; the client gets a generic error.
        log.warn(`[McpAccess] denied ${status} ${reason} server=${server} token=${tokenId || 'legacy-or-unknown'}${extra}`);
        return { ok: false, status, reason };
    };

    let token = null;
    try {
        if (tokenStore.isNamedTokenFormat(bearer)) {
            token = await d.findByPresented(bearer);
        } else {
            const legacyUserId = await d.authenticateLegacy(header);
            if (legacyUserId) {
                token = {
                    id: null, userId: legacyUserId, orgId: null, name: 'legacy', scopes: LEGACY_SCOPES,
                    ipAllowlist: [], expiresAt: null, revokedAt: null, legacy: true,
                };
            }
        }
    } catch (err) {
        return deny(401, 'token_lookup_failed', null, ` error=${err.message}`);
    }
    if (!token) return deny(401, 'token_unknown', null);

    let user = null;
    /** @type {{ primary: string|null, all: string[] }} */
    let orgs = { primary: null, all: [] };
    let policies = [];
    try {
        user = await d.getUser(token.userId);
        if (user) {
            // Every org the user belongs to, home or through a group. If this
            // cannot be resolved the request is refused, never waved through.
            orgs = await d.resolveOrgs(user);
            policies = orgs.all.length > 0
                ? await Promise.all(orgs.all.map((orgId) => d.getOrgMcpPolicy(orgId)))
                : [await d.getOrgMcpPolicy(null)];
        }
    } catch (err) {
        return deny(403, 'lookup_failed', token.id, ` error=${err.message}`);
    }
    const orgId = orgs.primary || token.orgId || null;

    const decision = evaluateAccessForOrgs({
        token,
        user,
        orgIds: orgs.all,
        accountActive: isActiveAccount(user),
        policies,
        ip,
        server,
    });
    if (!decision.ok) {
        const ipReason = decision.reason.startsWith('ip_outside');
        return deny(decision.status, decision.reason, token.id, ipReason ? ` ip=${ip}` : '');
    }

    // A batch is charged per message, against the token and against the user
    // (so a handful of tokens do not multiply one person's budget).
    const cost = requestCost(req);
    const tokenLimit = await d.rateLimit(token.id || `legacy:${token.userId}`, cost);
    const limited = tokenLimit.ok ? await d.rateLimitUser(`user:${token.userId}`, cost) : tokenLimit;
    if (!limited.ok) {
        log.warn(`[McpAccess] rate limited server=${server} token=${token.id || 'legacy'}`);
        return { ok: false, status: 429, reason: 'rate_limited', retryAfter: limited.retryAfter };
    }

    if (token.id) d.touchLastUsed(token.id);
    return {
        ok: true,
        user,
        orgId,
        token: { id: token.id, name: token.name, scopes: token.scopes, legacy: !!token.legacy },
    };
}

const DENIED = Object.freeze({
    401: { code: -32001, message: 'Unauthorized' },
    403: { code: -32003, message: 'Forbidden' },
    429: { code: -32029, message: 'Too many requests' },
});

/**
 * Answer a refused request with a generic JSON-RPC error. Never says which
 * check failed.
 *
 * @param {import('express').Response} res
 * @param {number} status 401, 403 or 429
 * @param {string|number|null} [id]
 * @param {number} [retryAfter] seconds, for 429
 */
function rpcDenied(res, status, id = null, retryAfter) {
    const shape = DENIED[status] || DENIED[403];
    const code = DENIED[status] ? status : 403;
    if (code === 401) res.set('WWW-Authenticate', 'Bearer realm="bee-flow"');
    if (code === 429) res.set('Retry-After', String(retryAfter || 60));
    return res.status(code).json({ jsonrpc: '2.0', id, error: { code: shape.code, message: shape.message } });
}

module.exports = {
    evaluateAccess, evaluateAccessForOrgs, gateRequest, rpcDenied,
    RATE_LIMIT_PER_MINUTE, USER_RATE_LIMIT_PER_MINUTE,
    _test: { rateLimitCheck, userRateLimitCheck, requestCost },
};
