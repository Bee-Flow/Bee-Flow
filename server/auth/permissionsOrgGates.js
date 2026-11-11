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
const { HttpError } = require('../shared/httpErrors');
// `?orgId` as one value or null; a repeated one throws the 400 (auth/adminOrg.mts).
const { namedOrgIdOf } = require('./adminOrg.mts');
/** @type {typeof import('./orgScope').orgScope} */
const orgScope = dep('orgScope');
const log = require('../telemetry/log');
const { fallback } = require('../utils/bestEffort');
const { OrgRoles, isOrgAdminRole, SystemRoles, Permissions } = require('./permissionsCatalog');
const { resolveUserOrgIds } = require('./permissionsResolve');

/**
 * Block writes/operations when an organization is suspended. Returns 402 with
 * a stable error code so the frontend can surface a "Subscription paused"
 * banner. Archived orgs trip a 410. Super-admins are exempt (they need to be
 * able to admin a suspended org). Active orgs (or no-org consumer accounts)
 * pass through.
 *
 * WHICH org is checked is never *selected* by the caller. The gate must not read
 * `req.body.organizationId` as an override "for super-admin routes" — super-admins
 * have already returned above, so the only callers who could reach that
 * override are ordinary members, i.e. exactly the people the gate exists to
 * stop. Adding one field to the JSON body (even a nonexistent org id, since an
 * unknown org falls through to next()) would turn the whole suspension/archive
 * gate off.
 *
 * The rule is therefore: a named org can only ADD a check, never replace one.
 *   - the caller's own (primary) org is ALWAYS evaluated;
 *   - a route param (`/orgs/:orgId/...`, the resource being acted on) is
 *     evaluated in addition when present;
 *   - `req.body.organizationId` is evaluated in addition too, but ONLY when the
 *     caller genuinely belongs to that org. Dropping the body entirely would be
 *     wrong: routes/agents/crud.js and routes/knowledgeBases.js do
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
 * This is the ONE answer to "does this user administer orgId". The org-admin
 * gates use it: isOrgAdminForOrg, requireOrgAdmin and requirePrimaryOrgAdmin
 * below, the org-scoped config routes (orgAzureConfig, orgPrivacyShield,
 * houseStyles, talkNotesSettings), and the user/organisation/access guards in
 * auth/admin/orgAdminGuards.js. (Their anti-orphan count counts only the direct
 * half, see countOrgMembers there.) Membership of an
 * ordinary group of orgId is membership, never administration. The decision
 * record is docs/docs/contributing/decisions/org-admin-is-not-platform-admin.md;
 * auth/admin/orgAdminGuards.strict.test.js and the tenant isolation matrix
 * hold it.
 */
function _evalOrgAdmin(user, allGroups, orgId, { strictOrgRole = false } = {}) {
    if (!user) return false;
    const directAdmin = strictOrgRole
        ? user.orgRole === OrgRoles.ORG_ADMIN
        : isOrgAdminRole(user.orgRole);
    if (user.organizationId === orgId && directAdmin) return true;

    let groupIds = [];
    if (Array.isArray(user.groups)) groupIds = user.groups;
    else { try { groupIds = JSON.parse(user.groups || '[]'); } catch (err) { groupIds = fallback('permissionsOrgGates:groups-json', err, []); } }

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
 * A user row's group ids (`groups` is an array off getUser, or its JSON text).
 * @param {{ groups?: unknown }} user
 * @returns {unknown[]}
 */
function groupIdsOfUser(user) {
    if (Array.isArray(user.groups)) return user.groups;
    let parsed;
    try { parsed = JSON.parse(typeof user.groups === 'string' && user.groups ? user.groups : '[]'); } catch (err) { parsed = fallback('permissionsOrgGates:groups-json', err, []); }
    return Array.isArray(parsed) ? parsed : [];
}

/**
 * The organisations the requesting user administers, by the rule of
 * _evalOrgAdmin (home organisation with an admin orgRole, or a group IN that
 * organisation that carries admin rights), among the organisations the user
 * belongs to (home organisation, then the organisations of their groups).
 *
 * For a decision about a resource of one organisation: "is the caller an
 * admin of THIS resource's organisation" is `set.has(resource.organization_id)`.
 * A super admin gets the same per-organisation answer here, not "every
 * organisation": callers answer a super admin before they ask (the
 * `orgIds === null` idiom). Store errors propagate.
 * @param {{ session?: { user?: { id?: string } | null } | null } | null | undefined} req  only the session's user id is read
 * @returns {Promise<Set<string>>}
 */
async function resolveAdminOrgIds(req) {
    const userId = req?.session?.user?.id;
    if (!userId) return new Set();
    const user = await userStore.getUser(userId);
    if (!user) return new Set();
    const allGroups = (await userStore.getAllGroups()) || [];

    /** @type {string[]} */
    const candidates = [];
    if (user.organizationId) candidates.push(user.organizationId);
    for (const gid of groupIdsOfUser(user)) {
        const orgId = allGroups.find((g) => g?.id === gid)?.organizationId;
        if (orgId && !candidates.includes(orgId)) candidates.push(orgId);
    }
    return new Set(candidates.filter((orgId) => _evalOrgAdmin(user, allGroups, orgId)));
}

/**
 * Shared middleware factory: require org admin access for the org
 * specified by req.params[paramName], decided by isOrgAdminForOrg
 * (_evalOrgAdmin above). Use this across all route files instead of local copies.
 */
function requireOrgAdmin(paramName = 'id') {
    // paramDependent: the verdict depends on WHICH org the request names, so a
    // static answer does not exist — the Access Map renders these as
    // "Depends on what is opened" rather than allow/deny.
    return tagGate(async (req, res, next) => {
        if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
        const orgId = req.params[paramName];
        if (!orgId) return res.status(400).json({ error: 'Organization ID required' });
        if (await isOrgAdminForOrg(req, orgId)) return next();
        return res.status(403).json({ error: 'Organization admin access required' });
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
 * one a group grants — which is exactly the first member of the union.
 */
async function resolvePrimaryOrgId(req) {
    const scope = await orgScope(req);
    return scope.isSuperAdmin ? null : scope.orgId;
}

const ORG_ADMIN_REQUIRED = 'Organization admin access required';

/**
 * Param-less variant of requireOrgAdmin for routes that operate on ONE org
 * without an :id in the path. Resolves that org and attaches it as
 * `req.primaryOrgId` for the handler.
 *
 *   - a platform admin (isSuperAdmin: the session flag or users.role 'admin';
 *     the 'all' permission is not one) may name any existing org with
 *     `?orgId` (the organisation chosen in the admin dashboard). An unknown
 *     org is a 404. Without `?orgId` they act on their own org, or get a 400
 *     when they have none.
 *   - anyone else must be an org admin of their primary org: an admin orgRole,
 *     and the primary org must also pass _evalOrgAdmin (it can be the org of
 *     the first group when the account has no own org, and an admin orgRole
 *     plus an ordinary group there administers nothing). A `?orgId` naming any
 *     other org is a 403; naming their own changes nothing.
 * A repeated `?orgId` is a 400 for everyone. The 400/403/404 of `?orgId` go
 * to `next(err)` as HttpError (same `error` text as the 403 below).
 */
function requirePrimaryOrgAdmin() {
    return tagGate(async (req, res, next) => {
        if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
        /** @type {string | null} */
        let named;
        try { named = namedOrgIdOf(req); } catch (err) { return next(err); }
        if (named && isSuperAdmin(req)) {
            if (!(await userStore.getOrganization(named))) {
                return next(new HttpError(404, 'organization_not_found', 'Organization not found'));
            }
            req.primaryOrgId = named;
            return next();
        }
        const own = await ownAdminOrg(req);
        if ('refused' in own) return res.status(own.refused.status).json({ error: own.refused.error });
        if (named && named !== own.orgId) return next(new HttpError(403, 'org_admin_required', ORG_ADMIN_REQUIRED));
        req.primaryOrgId = own.orgId;
        next();
    }, { axis: 'scope', kind: 'orgAdminOfOwnOrg' });
}

/**
 * The caller's own org for requirePrimaryOrgAdmin: their primary org (or the
 * session's org), when they administer it; a platform admin needs no admin
 * right there. Otherwise the refusal (status and `error` text) to answer.
 * @param {import('express').Request} req  a request with a session user
 * @returns {Promise<{ orgId: string } | { refused: { status: number, error: string } }>}
 */
async function ownAdminOrg(req) {
    const sessionUser = req.session.user;
    let user = null;
    if (!isSuperAdmin(req)) {
        user = await userStore.getUser(sessionUser.id);
        if (!user || !isOrgAdminRole(user.orgRole)) return { refused: { status: 403, error: ORG_ADMIN_REQUIRED } };
    }
    const orgId = await resolvePrimaryOrgId(req) || sessionUser.organizationId || null;
    if (!orgId) return { refused: { status: 400, error: 'No organization for this account' } };
    if (user && !_evalOrgAdmin(user, await userStore.getAllGroups(), orgId)) {
        return { refused: { status: 403, error: ORG_ADMIN_REQUIRED } };
    }
    return { orgId };
}

module.exports = {
    requireActiveOrg,
    requireActiveOrgForMutations,
    _evalOrgAdmin,
    isOrgAdminForOrg,
    resolveAdminOrgIds,
    requireOrgAdmin,
    isSuperAdmin,
    isSuperAdminUser,
    requireSuperAdmin,
    resolvePrimaryOrgId,
    requirePrimaryOrgAdmin,
};

