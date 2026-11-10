// @typecheck
/**
 * Permissions — resolving what a user may do: getUserPermissions (with its
 * cache and degraded-state signal), the audit variant, hasPermission, the RBAC
 * gates built on it (requireAdmin, requirePermission, requirePluginAdmin),
 * resolveUserOrgIds, and the per-organisation form (resolvePermissionsByOrg,
 * hasPermissionInOrg) for a decision about a resource of one organisation.
 *
 * Part of auth/permissions.js (the public surface); import from there.
 */

const { dep } = require('./permissionsDeps');
/** @type {typeof import('../stores/userStore')} */
const userStore = dep('userStore');
const { tagGate } = require('./gateMeta');
/** @type {typeof import('./orgScope').orgScope} */
const orgScope = dep('orgScope');
const log = require('../telemetry/log');
const { bestEffort, fallback } = require('../utils/bestEffort');
const { getRedis } = require('../db');
const { buildKey } = require('../utils/buildInfo');
const _metrics = require('../telemetry/httpMetrics');
const { OrgRoles, GROUP_GRANT_IMPLIED_PERMISSIONS, orgWideGrantImpliedPermissions, getOrgRolePermissions } = require('./permissionsCatalog');
const { PERM_CACHE_TTL, _permCache } = require('./permissionsCache');

const { collectPermissionGrants, permissionsOfGrants, grantsHoldInOrg } = require('./permissionGrants.mts');

// Degraded-state signal — flipped whenever getUserPermissions hits an
// exception path. Stays true for 60s after the last failure so dashboards
// can poll without seeing it bounce. See isPermissionLookupDegraded() below.
let _lastPermLookupFailedAt = 0;

/**
 * A THIRD PARTY's true permissions — the only safe way to ask "what can THAT
 * user do".
 *
 * getUserPermissions(userId, session) returns ['all'] whenever session.isAdmin,
 * regardless of userId (see its first line). Every existing call site passes the
 * CALLER's session, which is right for "may I?" and catastrophically wrong for
 * "may they?": an admin auditing a low-privilege user would be told that user
 * has every permission, and the screen would look entirely plausible.
 *
 * This signature has NO session parameter, so that elevation is unreachable —
 * by construction, not by remembering to pass null. Anything reporting on
 * another user (the Access Map, audits, support tooling) must come through here.
 *
 * Safe to reuse the 30s bf:perms:<id> cache: the ['all'] arm returns BEFORE both
 * the cache read and the cache write, so the cache is never poisoned by it.
 * Do not "defensively" bypass the cache — it pays latency for nothing.
 *
 * @param {string} userId — the user being asked about, never the caller
 */
async function resolveUserPermissionsForAudit(userId) {
    return getUserPermissions(userId);
}

// Helper function to get user's current permissions dynamically
// Results are cached in Redis (or in-memory fallback) for PERM_CACHE_TTL seconds.
//
// NOTE: `session` here is the CALLER's. If you are asking about someone else,
// you want resolveUserPermissionsForAudit(userId) above — passing a caller
// session makes this return ['all'] for any target.
async function getUserPermissions(userId, /** @type {import('../core/entitlements/entitlementTypes').SessionLike | null} */ session = null) {
    // Admin-flagged sessions get full access
    if (session?.isAdmin) return ['all'];

    // ── Check permission cache ──
    const r = getRedis();
    const permCacheKey = buildKey(`bf:perms:${userId}`);
    try {
        if (r) {
            const cached = await r.get(permCacheKey);
            if (cached) { _metrics.recordCache('permissions', true); return JSON.parse(cached); }
        } else {
            const cached = _permCache.get(userId);
            if (cached && (Date.now() - cached.ts) <= PERM_CACHE_TTL * 1000) {
                _metrics.recordCache('permissions', true);
                return cached.perms;
            }
        }
    } catch (err) { bestEffort('permissionsResolve:cache-read', err); }
    _metrics.recordCache('permissions', false);

    try {
        const user = await userStore.getUser(userId);
        if (!user) return ['page_chat']; // minimal fallback

        // Legacy: if user.role === 'admin', grant all
        if (user.role === 'admin') return ['all'];

        // The union of every grant (auth/permissionGrants.mts), in the order
        // they are collected: groups (permissions, implied capability, roles),
        // direct role, orgRole, org-wide grant, group orgRoles.
        const permSet = new Set(permissionsOfGrants(await collectUserGrants(user)));

        // Short-circuit: 'all' overrides everything
        if (permSet.has('all')) return ['all'];

        // Ensure at least chat access for any authenticated user
        permSet.add('page_chat');

        const result = [...permSet];

        // ── Write to cache ──
        try {
            if (r) {
                await r.set(permCacheKey, JSON.stringify(result), 'EX', PERM_CACHE_TTL);
            } else {
                _permCache.set(userId, { perms: result, ts: Date.now() });
            }
        } catch (err) { bestEffort('permissionsResolve:cache-write', err); }

        return result;
    } catch (err) {
        // Genuine DB error → log loudly and bump the degraded-state metric
        // so ops sees the silent "everyone is suddenly restricted" pattern.
        // We still return the minimal fallback rather than 503 here, because
        // many call sites use this for cosmetic UI gating; returning [] would
        // hide the chat window. Routes that need a hard answer should call
        // `hasPermission(userId, perm)` and on `false` decide whether to 403
        // or 503 based on `_lastPermLookupFailedAt`.
        _lastPermLookupFailedAt = Date.now();
        log.error('[Auth] getUserPermissions degraded:', err);
        return ['page_chat'];
    }
}

/**
 * Every permission grant of `user`, tagged with the organisation it holds in
 * (auth/permissionGrants.mts), read from the stores. Store errors propagate.
 *
 * The orgRole permissions are the shipped defaults from config/orgRoles.json
 * with the organisation's own choices layered on top (auth/orgRolePolicy.js):
 * an org that has never touched its Roles screen resolves to the defaults.
 * Legacy accounts carry orgRole 'admin' instead of 'org_admin'; the role map
 * only knows 'org_admin', so the orgRole is normalised first.
 *
 * A group's orgRole is a fan-out shortcut ("everyone in this group also acts
 * as <role>"); it resolves in the GROUP's organisation, whose Roles screen
 * says what the role means there. Removing a member from a group invalidates
 * their cached permissions (invalidateAllPermissionCaches on group mutations,
 * the per-user invalidation when `users.groups` changes).
 *
 * @param {import('./permissionGrants.mts').GrantUser & { groups?: unknown }} user  a userStore.getUser row
 * @returns {Promise<import('./permissionGrants.mts').PermissionGrant[]>}
 */
async function collectUserGrants(user) {
    // user.groups may already be parsed to an array by getUser()
    /** @type {unknown[]} */
    let groupIds = [];
    if (Array.isArray(user.groups)) {
        groupIds = user.groups;
    } else {
        try { groupIds = JSON.parse(typeof user.groups === 'string' && user.groups ? user.groups : '[]'); } catch (err) { groupIds = fallback('permissionsResolve:groups-json', err, []); }
        if (!Array.isArray(groupIds)) groupIds = [];
    }

    const allGroups = await userStore.getAllGroups();
    const allRoles = await userStore.getAllRoles();

    const { resolveOrgRolePermissions, getOrgRoleOverrides } = dep('orgRolePolicy');
    const ORG_ROLE_DEFAULTS = getOrgRolePermissions();
    // Cached per org for a few seconds inside orgRolePolicy, and the flat
    // answer is itself behind the per-user permission cache, so a group in a
    // second org costs one extra config read at most.
    /** @type {Map<string, Record<string, string[]>>} */
    const permsForOrg = new Map();

    return collectPermissionGrants(user, {
        groupIds,
        allGroups,
        allRoles,
        impliedByCapability: GROUP_GRANT_IMPLIED_PERMISSIONS,
        normaliseOrgRole: (r) => {
            if (typeof r !== 'string' || !r) return null;
            return r === OrgRoles.LEGACY_ADMIN ? OrgRoles.ORG_ADMIN : r;
        },
        permsForRoleInOrg: async (role, orgId) => {
            const key = String(orgId || '');
            let byRole = permsForOrg.get(key);
            if (!byRole) {
                byRole = await resolveOrgRolePermissions(orgId, ORG_ROLE_DEFAULTS);
                permsForOrg.set(key, byRole);
            }
            return (byRole && byRole[role]) || null;
        },
        // The org's "All members" grants of a group-scoped beta, only where
        // the org's Roles screen has not decided this role (precedence: see
        // orgWideGrantImpliedPermissions).
        orgWideGrants: async (orgId, orgRole) => {
            const overrides = await getOrgRoleOverrides(orgId);
            const roleDecided = !!orgRole && Object.prototype.hasOwnProperty.call(overrides, orgRole);
            return roleDecided ? [] : orgWideGrantImpliedPermissions(/** @type {string} */ (orgId));
        },
    });
}

/**
 * @typedef {{ holds: (permission: string, orgId: string | null | undefined) => boolean }} OrgPermissions
 *   `holds(P, X)`: the user holds P (or 'all') IN organisation X. Never for an
 *   absent organisation, except for a platform admin, who holds everything.
 */

/** @type {OrgPermissions} */
const HOLDS_EVERYWHERE = Object.freeze({ holds: () => true });
/** @type {OrgPermissions} */
const HOLDS_NOWHERE = Object.freeze({ holds: () => false });

/**
 * Which permissions the user holds in which organisation: one read, any
 * number of `holds(permission, orgId)` questions (a list endpoint asks one per
 * row). See auth/permissionGrants.mts for where each source holds: a group's
 * rights in the group's organisation, the user's orgRole and direct role in
 * the home organisation.
 *
 * A platform admin (`session.isAdmin`, or users.role 'admin') holds everything
 * everywhere, as with getUserPermissions. The always-granted `page_chat` floor
 * of getUserPermissions is not an organisation grant and does not appear here.
 *
 * `session` is the CALLER's, as with getUserPermissions: asking about another
 * user, pass none.
 *
 * Not cached: the per-user permission cache holds the flat answer only. A
 * store error answers "holds nowhere" (fails closed) and flips the same
 * degraded-state signal as getUserPermissions.
 *
 * @param {string | null | undefined} userId
 * @param {import('../core/entitlements/entitlementTypes').SessionLike | null} [session]
 * @returns {Promise<OrgPermissions>}
 */
async function resolvePermissionsByOrg(userId, session = null) {
    if (session?.isAdmin) return HOLDS_EVERYWHERE;
    if (!userId) return HOLDS_NOWHERE;
    try {
        const user = await userStore.getUser(userId);
        if (!user) return HOLDS_NOWHERE;
        if (user.role === 'admin') return HOLDS_EVERYWHERE;
        const grants = await collectUserGrants(user);
        return { holds: (permission, orgId) => grantsHoldInOrg(grants, permission, orgId) };
    } catch (err) {
        _lastPermLookupFailedAt = Date.now();
        log.error('[Auth] resolvePermissionsByOrg degraded:', err);
        return HOLDS_NOWHERE;
    }
}

/**
 * Does the user hold `permission` (or 'all') IN organisation `orgId`? The
 * single-question form of resolvePermissionsByOrg.
 * @param {string | null | undefined} userId
 * @param {string} permission
 * @param {string | null | undefined} orgId
 * @param {import('../core/entitlements/entitlementTypes').SessionLike | null} [session]
 * @returns {Promise<boolean>}
 */
async function hasPermissionInOrg(userId, permission, orgId, session = null) {
    return (await resolvePermissionsByOrg(userId, session)).holds(permission, orgId);
}

function isPermissionLookupDegraded() {
    return Date.now() - _lastPermLookupFailedAt < 60_000; // 1-min sticky
}

/**
 * Helper to check if user has a specific permission
 * @param {string} userId
 * @param {string} permission
 * @param {import('../core/entitlements/betaFeatures').SessionLike | null} [session]
 */
async function hasPermission(userId, permission, /** @type {import('../core/entitlements/entitlementTypes').SessionLike | null} */ session = null) {

    const perms = await getUserPermissions(userId, session);
    return perms.includes('all') || perms.includes(permission);
}

// Middleware to check admin or manage_users permission (dynamic)
const requireAdmin = async (req, res, next) => {
    if (!req.session || !req.session.isAuthenticated || !req.session.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    const userId = req.session.user?.id;

    // Check dynamically if user has admin/manage_users permission
    // Pass session for backwards compatibility with isAdmin flag
    if (await hasPermission(userId, 'manage_users', req.session) || await hasPermission(userId, 'all', req.session)) {
        next();
    } else {
        res.status(403).json({ error: 'Admin access required' });
    }
};
// Tagged after definition — see the note on requireAuth about name inference.
tagGate(requireAdmin, { axis: 'rbac', anyOf: ['manage_users', 'all'] });

// Middleware factory to require a specific permission.
//
// The returned closure is tagged (auth/gateMeta.js) so a router-stack walk can
// recover WHICH permission it enforces — without the tag it is just an anonymous
// arrow and the route table reads "USE:anonymous". The tag is a non-enumerable
// Symbol.for property: it changes nothing at request time.
const requirePermission = (permissionId) => {
    return tagGate(async (req, res, next) => {
        if (!req.session || !req.session.isAuthenticated || !req.session.user) {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        const userId = req.session.user?.id;

        if (await hasPermission(userId, permissionId, req.session)) {
            next();
        } else {
            res.status(403).json({ error: `Permission '${permissionId}' required` });
        }
    }, { axis: 'rbac', anyOf: [permissionId, 'all'] });
};

const requirePluginAdmin = async (req, res, next) => {
    if (!req.session || !req.session.isAuthenticated || !req.session.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    const userId = req.session.user?.id;
    if (await hasPermission(userId, 'admin_components', req.session) || await hasPermission(userId, 'all', req.session)) {
        next();
    } else {
        res.status(403).json({ error: 'Plugin Admin access required' });
    }
};
tagGate(requirePluginAdmin, { axis: 'rbac', anyOf: ['admin_components', 'all'] });

/**
 * Helper to resolve the user's organization IDs from their session.
 * Super admins (role=admin) get null → no org filter (see everything).
 * Returns a Set of org IDs the user belongs to, or null.
 *
 * ── "READ ZERO" AND "NOT READABLE" (A2 contradiction) ───────────────
 * The catch at the bottom swallowed EVERY store error and returned `myOrgIds` — almost always an
 * EMPTY Set. Every caller reads that as "this user is in no organisation at all", and that is
 * precisely the wrong way round: it is the key by which the EU mode and the org-specific tier map
 * are looked up, so one stumbling userStore read sent a complete system prompt to the global,
 * non-EU model. Routes that wanted to give a 503 on that (persona.js, tests.js) had a `catch`
 * around a function that never threw: a dead gate.
 *
 * With `{ strict: true }` it THROWS on an unreadable read. That is opt-in so that every existing
 * caller keeps its behaviour; whoever uses the outcome as a decision key should switch it on.
 *
 * The read itself lives in `auth/orgScope.js` — one implementation for all forms of this question.
 * This name is only the projection onto it.
 *
 * @param {import('express').Request} req
 * @param {{strict?: boolean}} [opts]
 */
const resolveUserOrgIds = async (req, opts) => {
    // The super admin short-circuits here and not in orgScope: his answer (`null`, no filter) costs no
    // read, so a stumbling store must not turn it into a strict-mode error. Whoever asks for an
    // ORGANISATION for him reads orgScope.
    if (req?.session?.user?.id && (req.session.isAdmin || req.session.user.role === 'admin')) return null;
    return (await orgScope(req, opts)).orgIds;
};

module.exports = {
    resolveUserPermissionsForAudit,
    getUserPermissions,
    isPermissionLookupDegraded,
    hasPermission,
    requireAdmin,
    requirePermission,
    requirePluginAdmin,
    resolveUserOrgIds,
    resolvePermissionsByOrg,
    hasPermissionInOrg,
};
