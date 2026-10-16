// @typecheck
/**
 * Nextcloud Connector JWT Auth Middleware
 *
 * Handles requests originating from the Bee Flow Nextcloud ExApp connector
 * (see nextcloud-connector/src/auth.js). The connector mints a short-lived
 * HS256 JWT signed with the customer's tenant key and forwards it as
 * `Authorization: Bearer <jwt>` plus an `X-Beeflow-Source: nextcloud-connector`
 * marker.
 *
 * Flow on this side:
 *   1. Spot the connector marker — if absent, fall through (cookie auth
 *      handles its own paths and we must not interfere with it).
 *   2. Resolve the tenant key. The connector signs with one specific
 *      customer's key, but the JWT body doesn't tell us which customer —
 *      that's the whole point of HS256 (we re-derive who it is by trying
 *      keys until one verifies). For a small number of tenants we iterate;
 *      at scale we'd index by a key hint in the JWT header (kid).
 *   3. Verify the signature, decode the payload, look up the user by email,
 *      populate req.session so downstream handlers see no difference from a
 *      cookie session.
 *   4. Reject (403) if the email isn't provisioned — never auto-create users
 *      from the connector path.
 *
 * Tenant keys live in configStore as encrypted secrets keyed
 * `connector_tenant_key_<organizationId>`. They're minted by the admin
 * endpoint added in server/routes/adminRoutes.js (see relatedconnector PR).
 */

const crypto = require('crypto');
const userStore = require('../stores/userStore');
const configStore = require('../stores/configStore');
// Phases that run after the tenant key verified the token live in
// connectorJwtPhases.js / connectorJwtProvision.js (outcome contract
// documented in the former).
const phases = require('./connectorJwtPhases');
const { provisionConnectorUser } = require('./connectorJwtProvision');
const { reject } = phases;
// Org-health capture. Every call below is fire-and-forget (never awaited on
// the request path, never throws) — this middleware runs on EVERY connector
// request and must not gain latency or new failure modes. Gate exits are
// rollup-only problems (the store dedups the 30s SPA retry storm); the DB
// write itself happens off this stack.
const orgHealth = require('../services/orgHealth');
const log = require('../telemetry/log');

const TENANT_KEY_PREFIX = 'connector_tenant_key_';

// In-memory cache of (orgId → tenant key) — avoids hitting configStore on
// every request. Invalidated on key rotation by the admin endpoint via
// invalidateTenantKeyCache().
const _keyCache = new Map();
const KEY_CACHE_TTL_MS = 60_000;


function _cacheGet(orgId) {
    const entry = _keyCache.get(orgId);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        _keyCache.delete(orgId);
        return null;
    }
    return entry.key;
}

function _cacheSet(orgId, key) {
    _keyCache.set(orgId, { key, expiresAt: Date.now() + KEY_CACHE_TTL_MS });
}

function invalidateTenantKeyCache(orgId) {
    if (orgId) _keyCache.delete(orgId);
    else _keyCache.clear();
    // A key (re)mint can also mean a NEW tenant — drop the org-id list so
    // the next request re-reads it instead of waiting out the TTL.
    _orgIdList = null;
    _orgIdListAt = 0;
}

// Cached list of org ids that have a tenant key. Embedded requests carry no
// cookie, so EVERY one of them resolves a tenant — without this cache that
// was a config-table scan per request (10-20× per page load; the main
// "slow inside Nextcloud" cause). 60s TTL, invalidated with the key cache,
// refreshed once on a total verification miss (see _resolveTenant pass 3).
let _orgIdList = null;
let _orgIdListAt = 0;
const ORG_ID_LIST_TTL_MS = 60_000;

async function _listTenantOrgIds({ fresh = false } = {}) {
    const now = Date.now();
    if (!fresh && _orgIdList && (now - _orgIdListAt) < ORG_ID_LIST_TTL_MS) return _orgIdList;
    let orgIds;
    if (typeof configStore.listKeysWithPrefix === 'function') {
        // Full keys by contract — slice the prefix off HERE. (The earlier
        // optional-chained call assumed a method that did not exist; when
        // adding it, returning full keys kept the store generic, so the
        // suffixing stays the caller's job.)
        const fullKeys = await configStore.listKeysWithPrefix(TENANT_KEY_PREFIX);
        orgIds = fullKeys.map(k => k.slice(TENANT_KEY_PREFIX.length));
    } else {
        orgIds = await _listOrgIdsFallback();
    }
    _orgIdList = orgIds;
    _orgIdListAt = now;
    return orgIds;
}

function _b64urlDecode(str) {
    const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
    return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function _timingSafeEq(a, b) {
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

/**
 * Verify an HS256 JWT against a candidate key. Returns the decoded payload
 * on success, throws on any failure (signature mismatch, expired, malformed).
 */
function _verifyHs256(token, key) {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('malformed JWT');
    const [hB64, pB64, sB64] = parts;

    const header = JSON.parse(_b64urlDecode(hB64).toString('utf8'));
    if (header.alg !== 'HS256') throw new Error(`unexpected alg: ${header.alg}`);
    if (header.typ && header.typ !== 'JWT') throw new Error(`unexpected typ: ${header.typ}`);

    const expected = crypto.createHmac('sha256', key)
        .update(`${hB64}.${pB64}`)
        .digest();
    const provided = _b64urlDecode(sB64);
    if (!_timingSafeEq(expected, provided)) throw new Error('signature mismatch');

    const payload = JSON.parse(_b64urlDecode(pB64).toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && now >= payload.exp) throw new Error('token expired');
    if (payload.nbf && now < payload.nbf) throw new Error('token not yet valid');
    if (payload.iss && payload.iss !== 'nextcloud-connector') throw new Error(`unexpected iss: ${payload.iss}`);
    if (payload.aud && payload.aud !== 'beeflow.nl') throw new Error(`unexpected aud: ${payload.aud}`);

    return payload;
}

/**
 * Try every known tenant key until one verifies the JWT.
 *
 * For a single-digit number of tenants this is fine. Past ~50 we should
 * include a `kid` (key id) in the JWT header on the connector side and
 * index by that here.
 */
async function _resolveTenant(token) {
    const orgIds = await _listTenantOrgIds();
    // Pass 1 — cached keys (fast path; hits on every steady-state request).
    for (const orgId of orgIds) {
        let key = _cacheGet(orgId);
        if (!key) {
            key = await configStore.getSecret(TENANT_KEY_PREFIX + orgId);
            if (!key) continue;
            _cacheSet(orgId, key);
        }
        try {
            const payload = _verifyHs256(token, key);
            return { orgId, payload };
        } catch (_) {
            // try the next key
        }
    }
    // Pass 2 — cache-bypass. A tenant key may have just been (re)minted on
    // another replica while this replica's per-process cache still holds the
    // OLD key (≤60s). Without this, a connector that just (re)bootstrapped is
    // 403'd for up to a minute on the stale replica. Re-read fresh from the DB
    // before rejecting; getSecretFresh also self-heals the stale cache. Bounded
    // by the (single-digit) tenant count, and only runs when Pass 1 misses.
    if (typeof configStore.getSecretFresh === 'function') {
        for (const orgId of orgIds) {
            const fresh = await configStore.getSecretFresh(TENANT_KEY_PREFIX + orgId);
            if (!fresh) continue;
            try {
                const payload = _verifyHs256(token, fresh);
                _cacheSet(orgId, fresh); // refresh the per-org key cache too
                return { orgId, payload };
            } catch (_) {
                // genuinely not this tenant
            }
        }
    }
    // Pass 3 — the org-id LIST itself may be stale: a tenant that
    // bootstrapped within the last 60s on another replica is absent from
    // this replica's cached list, so passes 1–2 never tried its key at all.
    // Refresh the list once and fresh-verify only the org ids we have not
    // seen yet, before rejecting. Steady-state requests never reach this.
    const known = new Set(orgIds);
    const refreshed = await _listTenantOrgIds({ fresh: true });
    for (const orgId of refreshed) {
        if (known.has(orgId)) continue;
        const key = typeof configStore.getSecretFresh === 'function'
            ? await configStore.getSecretFresh(TENANT_KEY_PREFIX + orgId)
            : await configStore.getSecret(TENANT_KEY_PREFIX + orgId);
        if (!key) continue;
        try {
            const payload = _verifyHs256(token, key);
            _cacheSet(orgId, key);
            return { orgId, payload };
        } catch (_) {
            // genuinely not this tenant
        }
    }
    return null;
}

/**
 * Fallback for configStore impls that lack listKeysWithPrefix. The
 * connector's expected scale is single-digit tenants for the first quarter,
 * so a full scan via getAllConfigs is acceptable.
 */
async function _listOrgIdsFallback() {
    // configStore exports `getAllConfig` (singular) — match that. The earlier
    // typo caused this to silently return [] and reject every connector JWT
    // with "no matching tenant key" even when the tenant key was present.
    const fn = configStore.getAllConfig || /** @type {any} */ (configStore).getAllConfigs; // defensive: an impl without the singular name
    if (typeof fn !== 'function') return [];
    const all = await fn();
    return Object.keys(all || {})
        .filter(k => k.startsWith(TENANT_KEY_PREFIX))
        .map(k => k.slice(TENANT_KEY_PREFIX.length));
}

/**
 * Best-effort email-DOMAIN extraction from an UNVERIFIED JWT payload. Used
 * only to attribute 'no matching tenant key' failures to a customer bucket
 * (subject `domain:<d>`); the token did not verify, so the value is spoofable
 * and is stored domain-only with meta.unverified=true. Never throws.
 */
function _unverifiedEmailDomain(token) {
    try {
        const payload = JSON.parse(_b64urlDecode(String(token).split('.')[1]).toString('utf8'));
        const email = String(payload?.email || '');
        const domain = email.includes('@') ? email.split('@')[1].trim().toLowerCase() : '';
        return domain || null;
    } catch (_) {
        return null;
    }
}

/**
 * Cookie-session precheck (runs OUTSIDE the main try block: a throw here
 * rejects the returned promise, as before). Returns true when a still-valid
 * cookie session exists; the caller then calls next(). Returns false to
 * continue with header (JWT) auth, after a stale session has been replaced.
 */
async function _reuseCookieSession(req) {
    // Skip if the cookie session is already authenticated — let session take
    // precedence so users who log in normally aren't surprised.
    // BUT: if the session claims a user that no longer exists in the DB
    // (e.g. admin deleted the org, dev `reset` wiped users) the connector
    // headers should be allowed to re-establish the session. Otherwise the
    // SPA sits on the login form forever even though the connector is
    // sending valid headers.
    if (req.session?.isAuthenticated && req.session?.user?.id) {
        const stillExists = await userStore.getUser(req.session.user.id).catch(() => null);
        if (stillExists) {
            // Re-sync the mutable identity fields from the DB before reusing the
            // session. The embedded SPA lives in a long-lived Nextcloud iframe,
            // so its session cookie is reused on every request indefinitely —
            // without this, a connector user's orgRole / organizationId / admin
            // flag stay frozen at their first-login values even after an admin
            // changes them. That produced inconsistent role/permission views
            // between accounts in the same org (one session sees the change, the
            // other doesn't) and, worse, let a demoted user keep stale elevated
            // permissions until the session expired. Scope to connector sessions
            // (cookie-login keeps its own refresh path) and only write when
            // something actually changed, to avoid a session-store write per
            // request.
            if (stillExists.provider === 'nextcloud_connector'
                || req.headers['x-beeflow-source'] === 'nextcloud-connector') {
                const nextOrgRole = stillExists.orgRole || '';
                const nextRole = stillExists.role || 'user';
                const nextOrgId = stillExists.organizationId || req.session.user.organizationId || null;
                const nextIsAdmin = stillExists.role === 'admin';
                if (req.session.user.orgRole !== nextOrgRole
                    || req.session.user.role !== nextRole
                    || req.session.user.organizationId !== nextOrgId
                    || req.session.isAdmin !== nextIsAdmin) {
                    req.session.user.orgRole = nextOrgRole;
                    req.session.user.role = nextRole;
                    req.session.user.organizationId = nextOrgId;
                    req.session.isAdmin = nextIsAdmin;
                }
            }
            return true;
        }
        // Stale session — invalidate it and fall through to header-based (JWT)
        // auth. We REGENERATE rather than destroy(): destroy() nulls req.session
        // for the rest of THIS request, which then crashes every downstream
        // reader (requireAuth/requireAdmin read req.session.isAuthenticated) as
        // well as the JWT re-auth + login handlers that repopulate the session.
        // regenerate() leaves a fresh, empty, valid session object in its place.
        log.info(`[ConnectorJWT] Dropping stale session for missing user ${req.session.user.id}`);
        await /** @type {Promise<void>} */ (new Promise(resolve => req.session.regenerate(() => resolve())));
    }
    return false;
}

/**
 * The connector's bearer token, or null when this request is not a connector
 * request / carries no JWT-shaped bearer (the caller then falls through to
 * the rest of the chain with next()).
 */
function _connectorBearerToken(req) {
    // Connector requests are tagged with this header. Without it, fall through
    // to the rest of the chain.
    if (req.headers['x-beeflow-source'] !== 'nextcloud-connector') {
        return null;
    }

    const authHeader = req.headers['authorization'] || req.headers['Authorization'];
    if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
        return null;
    }

    const token = authHeader.slice(7).trim();
    // Reject anything that isn't a JWT-shaped string before we hash-walk
    // tenant keys.
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
        return null;
    }
    return token;
}

/**
 * Everything after the token shape check: verify against the tenant keys,
 * find or provision the user, gate, reconcile, populate the session. Returns
 * an outcome ({kind:'reject'|'error'|'ok'}, see connectorJwtPhases.js) and
 * NEVER touches res/next itself. Throws are answered 401 by the caller.
 */
async function _authenticateConnectorToken(req, token) {
    const resolved = await _resolveTenant(token);
    if (!resolved) {
        // Tenant-key divergence smoking gun: attribute to the (unverified)
        // email domain so the operator can see WHICH customer's connector
        // is signing with a stale key.
        const emailDomain = _unverifiedEmailDomain(token);
        orgHealth.problem('auth.no_matching_tenant_key', {
            subjectKey: emailDomain ? `domain:${emailDomain}` : 'unknown',
            source: 'connectorJwt', req,
            meta: { emailDomain: emailDomain || null, unverified: true, reason: 'no_matching_tenant_key' },
        });
        return reject(401, { error: 'Connector token rejected: no matching tenant key' });
    }
    const { orgId, payload } = resolved;
    if (!payload.email) {
        orgHealth.problem('auth.missing_email', {
            orgId, source: 'connectorJwt', req,
            meta: { sub: payload.sub || null, reason: 'jwt_missing_email_claim' },
        });
        return reject(400, { error: 'Connector token missing email claim' });
    }

    let user = await userStore.getUserByEmail(payload.email);
    if (!user) {
        const provisioned = await provisionConnectorUser(req, orgId, payload);
        if (provisioned.kind !== 'ok') return provisioned;
        user = provisioned.user;
    } else {
        const mismatch = phases.crossTenantGate(req, user, orgId);
        if (mismatch) return mismatch;
    }
    const pending = phases.pendingApprovalGate(req, user, orgId);
    if (pending) return pending;
    await phases.reconcileUserRecord(user, orgId, payload);
    return phases.establishConnectorSession(req, user, orgId, payload);
}

async function connectorJwtMiddleware(req, res, next) {
    if (await _reuseCookieSession(req)) return next();

    const token = _connectorBearerToken(req);
    if (!token) return next();

    try {
        const outcome = await _authenticateConnectorToken(req, token);
        if (outcome.kind === 'reject') return res.status(outcome.status).json(outcome.body);
        if (outcome.kind === 'error') return next(outcome.error);
        // Fail closed: only an explicit 'ok' WITH an authenticated session
        // (what establishConnectorSession writes) continues the chain.
        if (outcome.kind !== 'ok' || req.session?.isAuthenticated !== true) {
            throw new Error('unexpected connector auth outcome');
        }
        next();
        return;
    } catch (err) {
        log.warn(`[ConnectorJWT] Auth failed for ${req.method} ${req.url}: ${err.message}`);
        return res.status(401).json({ error: 'Invalid connector token' });
    }
}

module.exports = Object.assign(connectorJwtMiddleware, {
    invalidateTenantKeyCache,
    _verifyHs256, // exported for tests
    _isOrgAdminRequester: phases._isOrgAdminRequester, // exported for tests
    _resolveRequesterNcUid: phases._resolveRequesterNcUid, // exported for tests
    _resolveSessionNcUid: phases._resolveSessionNcUid, // exported for tests
    _resolveTenant, // shared with /connector/status (phone-home) — single two-pass key resolver
    _unverifiedEmailDomain, // exported for tests
});
