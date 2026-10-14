// @typecheck
/**
 * Permissions — the organisation gates: the org-lifecycle gate
 * (requireActiveOrg, requireActiveOrgForMutations), org-admin checks
 * (_evalOrgAdmin, isOrgAdminForOrg, requireOrgAdmin, requirePrimaryOrgAdmin),
 * the super-admin predicates and gate, and resolvePrimaryOrgId.
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
const { OrgRoles, isOrgAdminRole, SystemRoles, Permissions } = require('./permissionsCatalog');
const { resolveUserOrgIds } = require('./permissionsResolve');

/**
 * Block writes/operations when an organization is suspended. Returns 402 with
 * a stable error code so the frontend can surface a "Subscription paused"
 * banner. Archived orgs trip a 410. Super-admins are exempt (they need to be
 * able to admin a suspended org). Active orgs (or no-org consumer accounts)
 * pass through.
 *
 * WHICH org is checked is never *selected* by the caller. The gate used to read
 * `req.body.organizationId` as an override "for super-admin routes" — but
 * super-admins have already returned above, so in practice the only callers who
 * could reach that override were ordinary members, i.e. exactly the people the
 * gate exists to stop. Adding one field to the JSON body (even a nonexistent
 * org id, since an unknown org falls through to next()) turned the whole
 * suspension/archive gate off.
 *
 * The rule is therefore: a named org can only ADD a check, never replace one.
 *   - the caller's own (primary) org is ALWAYS evaluated;
 *   - a route param (`/orgs/:orgId/...`, the resource being acted on) is
 *     evaluated in addition when present;
 *   - `req.body.organizationId` is evaluated in addition too, but ONLY when the
 *     caller genuinely belongs to that org. Dropping the body entirely was the
 *     wrong correction: routes/agents/crud.js and routes/knowledgeBases.js do
 *     take the target org from the body, and assertUserCanUseOrg admits any org
 *     in the resolveUserOrgIds union — so a multi-org member whose PRIMARY org
 *     is active could write into a SUSPENDED secondary org unchecked. An org the
 *     caller is not a member of is ignored here (their own org still decides),
 *     which is what keeps the body from being a kill switch.
 */
function requireActiveOrg(opts = {}) {
    const paramName = opts.paramName || 'orgId';
    // failsOpen: on a DB error this returns next() rather than denying (see the
    // catch below). The Access Map must therefore render this axis as `unknown`,
    // never as a truthful deny, when the permission lookup is degraded.
    return tagGate(async (req, res, next) => {
        try {
            if (req.session?.isAdmin || req.session?.user?.role === SystemRoles.SUPER_ADMIN) return next();

            // One membership lookup serves all three sources below (this is the
            // same single lookup resolvePrimaryOrgId performs internally).
            // `null` means super-admin — unreachable here, they returned above.
            const memberOrgIds = await resolveUserOrgIds(req);

            const orgIds = [];
            const paramOrgId = (req.params && req.params[paramName]) || null;
            if (paramOrgId) orgIds.push(paramOrgId);

            // Target org from the body: only honoured as an ADDITIONAL check,
            // and only for an org the caller actually belongs to. A stranger's
            // org id changes nothing — the caller's own org is still evaluated.
            const rawBodyOrgId = req.body && req.body.organizationId;
            const bodyOrgId = typeof rawBodyOrgId === 'string' && rawBodyOrgId ? rawBodyOrgId : null;
            if (bodyOrgId && memberOrgIds && memberOrgIds.has(bodyOrgId) && !orgIds.includes(bodyOrgId)) {
                orgIds.push(bodyOrgId);
            }

            const callerOrgId = (memberOrgIds && memberOrgIds.size > 0) ? Array.from(memberOrgIds)[0] : null;
            if (callerOrgId && !orgIds.includes(callerOrgId)) orgIds.push(callerOrgId);

            if (orgIds.length === 0) return next(); // consumer / no-org → not blocked

            for (const orgId of orgIds) {
                const org = await userStore.getOrganization(orgId);
                if (!org) continue;
                const status = org.status || 'active';
                if (status === 'suspended') {
                    return res.status(402).json({
                        error: 'org_suspended',
                        message: 'Your organization is currently suspended. Please contact your administrator.',
                    });
                }
                if (status === 'archived') {
                    return res.status(410).json({
                        error: 'org_archived',
                        message: 'Your organization is archived and read-only.',
                    });
                }
            }
            return next();
        } catch (e) {
            log.warn('[Auth] requireActiveOrg error:', e.message);
            return next(); // fail-open: don't lock customers out on transient errors
        }
    }, { axis: 'orgStatus', paramName, mutationsOnly: false, failsOpen: true });
}

/**
 * Variant of `requireActiveOrg` that only enforces on non-GET/non-HEAD
 * requests. Use as a top-level `router.use(...)` middleware so a suspended
 * org can still read/export data but cannot mutate. The status check
 * runs server-side; the suspension banner is rendered client-side from
 * the 402 response.
 */
function requireActiveOrgForMutations(opts = {}) {
    const inner = requireActiveOrg(opts);
    return tagGate((req, res, next) => {
        const m = req.method;
        if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return next();
        return inner(req, res, next);
    }, { axis: 'orgStatus', paramName: opts.paramName || 'orgId', mutationsOnly: true, failsOpen: true });
}

/**
 * Pure org-admin decision (DB-free — unit testable): given an already-fetched
 * user row and the full group list, is the user an admin *of orgId*?
 *
 *   - direct: the user's own org is orgId AND their orgRole is an admin role
 *     (strictOrgRole → only the exact ORG_ADMIN; default → any admin variant,
 *     including the legacy 'admin' orgRole via isOrgAdminRole);
 *   - group: the user belongs to a group in orgId that itself carries an
 *     admin permission ('all'/'admin') or admin role ('admin'/'org_admin').
 *
 * This is the group-permission-aware semantics shared by the org-scoped config
 * routes (orgAzureConfig, orgPrivacyShield, houseStyles, talkNotesSettings).
 * It is deliberately DISTINCT from requireOrgAdmin below, which gates on the
 * orgRole then plain group *membership*; reconciling the two is a separate,
 * test-guarded decision — do not silently merge them.
 */
function _evalOrgAdmin(user, allGroups, orgId, { strictOrgRole = false } = {}) {
    if (!user) return false;
    const directAdmin = strictOrgRole
        ? user.orgRole === OrgRoles.ORG_ADMIN
        : isOrgAdminRole(user.orgRole);
    if (user.organizationId === orgId && directAdmin) return true;

    let groupIds = [];
    if (Array.isArray(user.groups)) groupIds = user.groups;
    else { try { groupIds = JSON.parse(user.groups || '[]'); } catch (_) { /* leave [] */ } }

    for (const gid of groupIds) {
        const group = (allGroups || []).find(g => g.id === gid);
        if (group?.organizationId === orgId) {
            const perms = Array.isArray(group.permissions) ? group.permissions : [];
            const roles = Array.isArray(group.roles) ? group.roles : [];
            if (perms.includes(Permissions.ALL) || perms.includes(SystemRoles.SUPER_ADMIN) ||
                roles.includes(SystemRoles.SUPER_ADMIN) || roles.includes(OrgRoles.ORG_ADMIN)) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Is the requesting user an admin of `orgId`? Super admins always pass.
 * Replaces the five hand-rolled `isOrgAdmin(req, orgId)` copies in the
 * org-scoped config routes with one audited copy. Pass `{ strictOrgRole: true }`
 * to require the exact ORG_ADMIN orgRole (orgAzureConfig's stricter variant);
 * default accepts any admin orgRole variant.
 * @param {import('express').Request} req
 * @param {string} orgId
 * @param {{ strictOrgRole?: boolean }} [opts]
 * @returns {Promise<boolean>}
 */
async function isOrgAdminForOrg(req, orgId, opts = {}) {
    if (isSuperAdmin(req)) return true;
    const userId = req.session?.user?.id;
    if (!userId) return false;
    const user = await userStore.getUser(userId);
    if (!user) return false;
    const allGroups = await userStore.getAllGroups();
    return _evalOrgAdmin(user, allGroups, orgId, opts);
}

/**
 * Shared middleware factory: require org admin access for the org
 * specified by req.params[paramName].
 * Use this across all route files instead of local copies.
 */
function requireOrgAdmin(paramName = 'id') {
    // paramDependent: the verdict depends on WHICH org the request names, so a
    // static answer does not exist — the Access Map renders these as
    // "Depends on what is opened" rather than allow/deny.
    return tagGate(async (req, res, next) => {
        if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
        const orgId = req.params[paramName];
        if (!orgId) return res.status(400).json({ error: 'Organization ID required' });

        // Super admin — always allowed
        if (req.session.isAdmin || req.session.user?.role === 'admin') return next();

        const userId = req.session.user.id;
        if (!userId) return res.status(403).json({ error: 'Organization admin access required' });

        const user = await userStore.getUser(userId);
        if (!user || !isOrgAdminRole(user.orgRole)) {
            return res.status(403).json({ error: 'Organization admin access required' });
        }

        // Must belong to the target org
        if (user.organizationId === orgId) return next();

        // Check group-based membership as fallback
        let groupIds = [];
        if (Array.isArray(user.groups)) groupIds = user.groups;
        else { try { groupIds = JSON.parse(user.groups || '[]'); } catch (_) { } }

        const allGroups = await userStore.getAllGroups();
        const isMember = groupIds.some(gid => {
            const g = allGroups.find(gr => gr.id === gid);
            return g?.organizationId === orgId;
        });

        if (!isMember) {
            return res.status(403).json({ error: 'Organization admin access required' });
        }
        next();
    }, { axis: 'scope', kind: 'orgAdminOfParam', param: paramName, paramDependent: true });
}

/**
 * Canonical super-admin predicate. A super (system) admin is a session flagged
 * `isAdmin` or whose user role is 'admin'. This exact expression was spelled
 * inline in ~20 route handlers with ?./non-?. variants — one definition keeps
 * the privilege check from drifting.
 *
 * NOTE: this is distinct from the `orgIds === null` idiom some routes use — that
 * one is *derived* from resolveUserOrgIds() (which returns null for super
 * admins) and stays where it is; do not replace those with this.
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isSuperAdmin(req) {
    return !!(req.session?.isAdmin || req.session?.user?.role === 'admin');
}

/**
 * The same operator test for a user record without a session (an MCP token's
 * user), used by the CMS MCP analytics tools. Keep it in step with the role
 * half of isSuperAdmin above, whose line mobile/src/core/access mirrors.
 */
function isSuperAdminUser(user) {
    return user?.role === 'admin';
}

/**
 * Platform-operator gate — the middleware form of isSuperAdmin().
 *
 * WHY THIS EXISTS SEPARATELY FROM requireAdmin: requireAdmin (:657) passes on
 * the `manage_users` PERMISSION, and config/orgRoles.json grants that to every
 * org_admin. It answers "may manage users", not "runs this installation". Four
 * routers had already noticed and hand-rolled a private copy of this function
 * rather than use it (routes/admin/modules.js, routes/admin/connectorHealth.js,
 * routes/cmsAnalytics.js, routes/cms.js) — each with a comment explaining the
 * trap. This is that copy, promoted to the one place they can all import.
 *
 * Deliberately synchronous and DB-free: unlike requireAdmin it never consults
 * getUserPermissions(), so it cannot be softened by the degraded-lookup
 * fallback (:591) and has no fail-open path. Holding the `all` permission does
 * NOT satisfy it — only users.role === 'admin' does. That asymmetry is what
 * stops the POST /auth/roles → group → 'all' escalation ladder from reaching
 * platform scope.
 *
 * Responses are byte-identical to the four local copies it replaces, so
 * swapping them out is a provable no-op.
 */
const requireSuperAdmin = (req, res, next) => {
    if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
    if (isSuperAdmin(req)) return next();
    return res.status(403).json({ error: 'Operator access required' });
};
// Tagged after definition — see the note on requireAuth about name inference.
// Axis is 'platform', not 'rbac': 'admin' is a users.role value, not a
// SYSTEM_PERMISSIONS id, and tagging it rbac would force a fictional permission
// id into accessRegistry via drift assertion 3.
tagGate(requireSuperAdmin, { axis: 'platform', kind: 'superAdmin' });

/**
 * Resolve the requesting user's primary org ID from the session.
 * Returns the first org they belong to, or null. Super admins return null.
 *
 * Same read as `orgScope`: `orgId` is the account's own org, else the first
 * one a group grants — which is exactly the first member of the union this
 * used to take.
 */
async function resolvePrimaryOrgId(req) {
    const scope = await orgScope(req);
    return scope.isSuperAdmin ? null : scope.orgId;
}

/**
 * Param-less variant of requireOrgAdmin for routes that always operate on the
 * CALLER's own org (no :id in the path): the caller must be an org admin (or
 * super admin) and belong to an organization. Resolves that org and attaches
 * it as `req.primaryOrgId` for the handler. Super admins act on their own
 * primary org too — there is deliberately no cross-org override here.
 */
function requirePrimaryOrgAdmin() {
    return tagGate(async (req, res, next) => {
        if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
        const userId = req.session.user.id;
        const isSuperAdmin = req.session.isAdmin || req.session.user?.role === 'admin';
        if (!isSuperAdmin) {
            const user = await userStore.getUser(userId);
            if (!user || !isOrgAdminRole(user.orgRole)) {
                return res.status(403).json({ error: 'Organization admin access required' });
            }
        }
        const orgId = await resolvePrimaryOrgId(req)
            || req.session.user.organizationId
            || null;
        if (!orgId) return res.status(400).json({ error: 'No organization for this account' });
        req.primaryOrgId = orgId;
        next();
    }, { axis: 'scope', kind: 'orgAdminOfOwnOrg' });
}

module.exports = {
    requireActiveOrg,
    requireActiveOrgForMutations,
    _evalOrgAdmin,
    isOrgAdminForOrg,
    requireOrgAdmin,
    isSuperAdmin,
    isSuperAdminUser,
    requireSuperAdmin,
    resolvePrimaryOrgId,
    requirePrimaryOrgAdmin,
};
