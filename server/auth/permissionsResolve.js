// @typecheck
/**
 * Permissions — resolving what a user may do: getUserPermissions (with its
 * cache and degraded-state signal), the audit variant, hasPermission, the RBAC
 * gates built on it (requireAdmin, requirePermission, requirePluginAdmin) and
 * resolveUserOrgIds.
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
const { getRedis } = require('../db');
const { buildKey } = require('../utils/buildInfo');
const _metrics = require('../telemetry/httpMetrics');
const { OrgRoles, GROUP_GRANT_IMPLIED_PERMISSIONS, orgWideGrantImpliedPermissions, getOrgRolePermissions } = require('./permissionsCatalog');
const { PERM_CACHE_TTL, _permCache } = require('./permissionsCache');

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
async function getUserPermissions(userId, session = null) {
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
    } catch (_) { /* cache miss — resolve from DB */ }
    _metrics.recordCache('permissions', false);

    try {
        const user = await userStore.getUser(userId);
        if (!user) return ['page_chat']; // minimal fallback

        // Legacy: if user.role === 'admin', grant all
        if (user.role === 'admin') return ['all'];

        const permSet = new Set();

        // Resolve groups — user.groups may already be parsed to an array by getUser()
        let groupIds = [];
        if (Array.isArray(user.groups)) {
            groupIds = user.groups;
        } else {
            try { groupIds = JSON.parse(user.groups || '[]'); } catch (_) { }
        }

        const allGroups = await userStore.getAllGroups();
        const allRoles = await userStore.getAllRoles();
        const roleMap = Object.fromEntries(allRoles.map(r => [r.id, r]));

        for (const gid of groupIds) {
            const group = allGroups.find(g => g.id === gid);
            if (!group) continue;

            // Add group-level permissions
            for (const p of (group.permissions || [])) permSet.add(p);

            // …and the permissions a capability grant to this group implies.
            const granted = Array.isArray(group.granted_capabilities) ? group.granted_capabilities : [];
            for (const capId of granted) {
                for (const p of (GROUP_GRANT_IMPLIED_PERMISSIONS[capId] || [])) permSet.add(p);
            }

            // Resolve roles attached to the group
            for (const rid of (group.roles || [])) {
                const role = roleMap[rid];
                if (role) {
                    for (const p of (role.permissions || [])) permSet.add(p);
                }
            }
        }

        // Resolve the user's direct role field (e.g. 'admin-light')
        if (user.role && user.role !== 'admin') {
            const directRole = roleMap[user.role];
            if (directRole) {
                for (const p of (directRole.permissions || [])) permSet.add(p);
            }
        }

        // ── Organisation role → permissions mapping ──
        // Shipped defaults from config/orgRoles.json, with the organisation's
        // own choices layered on top (auth/orgRolePolicy.js). An org that has
        // never touched its Roles screen resolves byte-identically to before.
        const { resolveOrgRolePermissions } = dep('orgRolePolicy');
        const ORG_ROLE_DEFAULTS = getOrgRolePermissions();
        // Cached per org for a few seconds inside orgRolePolicy, and this whole
        // function is itself behind the per-user permission cache, so a group
        // in a second org costs one extra config read at most.
        const _permsForOrg = new Map();
        const permsForRoleInOrg = async (role, orgId) => {
            const key = String(orgId || '');
            if (!_permsForOrg.has(key)) {
                _permsForOrg.set(key, await resolveOrgRolePermissions(orgId, ORG_ROLE_DEFAULTS));
            }
            return _permsForOrg.get(key)[role] || null;
        };

        // Legacy compatibility: accounts created before the role rename carry
        // orgRole === 'admin' instead of 'org_admin'. Many code paths already
        // accept both (see server/routes/ai/config.js requireOrgAdminForN8n),
        // but the permissions map only has 'org_admin' — resulting in zero
        // permissions for legacy admins. Normalise here.
        const normaliseOrgRole = (r) => (r === OrgRoles.LEGACY_ADMIN ? OrgRoles.ORG_ADMIN : r);

        // Apply user's direct orgRole
        const userOrgRole = normaliseOrgRole(user.orgRole);
        if (userOrgRole) {
            const granted = await permsForRoleInOrg(userOrgRole, user.organizationId);
            if (granted) for (const p of granted) permSet.add(p);
        }

        // The org's "All members" grants of a group-scoped beta — only where
        // the org's Roles screen has not decided this role (precedence: see
        // orgWideGrantImpliedPermissions).
        if (user.organizationId) {
            const { getOrgRoleOverrides } = dep('orgRolePolicy');
            const overrides = await getOrgRoleOverrides(user.organizationId);
            const roleDecided = !!userOrgRole && Object.prototype.hasOwnProperty.call(overrides, userOrgRole);
            if (!roleDecided) {
                for (const p of await orgWideGrantImpliedPermissions(user.organizationId)) permSet.add(p);
            }
        }

        // Apply group-level orgRoles (a group can grant a role to all its members).
        //
        // Why this exists: the canonical place to assign an orgRole is the
        // `users.orgRole` column. The `groups.orgRole` column is a fan-out
        // shortcut for "everyone in this group should also act as <role>"
        // (e.g. an "ops" group that grants `dpo` to its members without
        // editing each user). It is additive — a user's own orgRole and
        // every group orgRole they're in all union into the permission set.
        //
        // Operational notes:
        //   • Group orgRoles do NOT promote a user across org boundaries —
        //     a group's organizationId scopes its members; cross-org
        //     resolution still relies on the per-user orgRole + user.organizationId.
        //   • Removing a member from a group invalidates their cached perms
        //     via invalidateAllPermissionCaches (group mutations) or the
        //     per-user invalidation when adminRoutes updates `users.groups`.
        //   • The mechanism is rarely used today; left in place for orgs
        //     that want to manage "all members of group X get DPO" without
        //     editing per-user rows.
        for (const gid of groupIds) {
            const group = allGroups.find(g => g.id === gid);
            const groupOrgRole = normaliseOrgRole(group?.orgRole);
            if (!groupOrgRole) continue;
            // The GROUP's org decides, not the user's: a group fans its role
            // out to its own members, and it is that organisation's Roles
            // screen that says what the role means.
            const granted = await permsForRoleInOrg(groupOrgRole, group?.organizationId || user.organizationId);
            if (granted) for (const p of granted) permSet.add(p);
        }

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
        } catch (_) { /* cache write failure is non-fatal */ }

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

function isPermissionLookupDegraded() {
    return Date.now() - _lastPermLookupFailedAt < 60_000; // 1-min sticky
}

// Helper to check if user has a specific permission
async function hasPermission(userId, permission, session = null) {
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
 * ── "GELEZEN NUL" EN "NIET TE LEZEN" (A2-tegenspraak) ───────────────
 * De catch onderaan slikte ELKE storefout en gaf `myOrgIds` terug — vrijwel
 * altijd een LEGE Set. Iedere aanroeper leest die als "deze gebruiker zit in
 * geen enkele org", en dat is precies de verkeerde kant op: het is de sleutel
 * waarop de EU-modus en de org-eigen tiermap worden opgezocht, dus één
 * haperende userStore-lezing stuurde een volledig systeemprompt naar het
 * globale, niet-EU model. Routes die daarop een 503 wilden geven (persona.js,
 * tests.js) hadden een `catch` om een functie die nooit gooide: een dode poort.
 *
 * Met `{ strict: true }` GOOIT hij op een onleesbare lezing. Dat is opt-in
 * zodat elke bestaande aanroeper zijn gedrag houdt; wie de uitkomst als
 * beslissleutel gebruikt hoort hem aan te zetten.
 *
 * De lezing zelf staat in `auth/orgScope.js` — één implementatie voor alle
 * vormen van deze vraag. Deze naam is nog maar de projectie erop.
 *
 * @param {import('express').Request} req
 * @param {{strict?: boolean}} [opts]
 */
const resolveUserOrgIds = async (req, opts) => {
    // De super-admin kort hier af en niet in orgScope: zijn antwoord (`null`,
    // geen filter) kost geen lezing, dus een haperende store mag het niet in
    // een strict-fout veranderen. Wie hém om een órg vraagt leest orgScope.
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
};
