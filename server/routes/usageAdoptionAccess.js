// @typecheck strict
/**
 * Which organisation the Adoption report (routes/usageAdoption.js) reads, and
 * whether the caller holds admin_monitoring IN that organisation.
 *
 * The router's tagged gate, `requirePermission('admin_monitoring')`, checks
 * the union of everything the caller holds: their own orgRole in their home
 * organisation and the orgRole of every group they sit in, whichever
 * organisation that group belongs to (auth/permissionsResolve.js). The report
 * then reads ONE organisation, the first of the caller's (routes/usageScope.js
 * getOrgFilter). A DPO role from a group of organisation B must not open the
 * per-person view, or the name reveal, of organisation A. So after the
 * organisation is known, the permission is resolved again for that
 * organisation only:
 *
 *   - when it is the caller's home organisation: their own orgRole (read
 *     through the organisation's Roles screen, auth/orgRolePolicy.js) and
 *     their direct role;
 *   - the groups of that organisation the caller sits in: the group's
 *     permissions, its roles and its orgRole.
 *
 * A super admin passes. Resolved by the organisation, a super admin has no
 * organisation (auth resolveUserOrgIds is org-blind for them), so the report
 * falls back to the organisation on their own user record, as the guardrail
 * dashboards do (routes/usageMonitoringAuth.js); without one they are refused.
 */

'use strict';

const REPORT_PERMISSION = 'admin_monitoring';
const LEGACY_ADMIN_ORG_ROLE = 'admin';
const ORG_ADMIN_ROLE = 'org_admin';

/**
 * @typedef {{
 *   userStore: {
 *     getUser: (id: string) => Promise<unknown>,
 *     getAllGroups: () => Promise<unknown[]>,
 *     getAllRoles: () => Promise<unknown[]>,
 *   },
 *   orgRoles: { resolveOrgRolePermissions: (orgId: string, defaults: Record<string, string[]>) => Promise<Record<string, string[]>> },
 *   catalog: { getOrgRolePermissions: () => Record<string, string[]> },
 * }} AccessDeps
 * @typedef {{ id?: unknown, organizationId?: unknown, orgRole?: unknown, role?: unknown, groups?: unknown }} UserRecord
 * @typedef {{ id?: unknown, organizationId?: unknown, orgRole?: unknown, permissions?: unknown, roles?: unknown }} GroupRecord
 * @typedef {{ id?: unknown, permissions?: unknown }} RoleRecord
 */

/** @param {unknown} v @returns {string[]} */
const strings = (v) => (Array.isArray(v) ? v.map(String) : []);

/** @param {import('express').Request} req */
function isSuperAdmin(req) {
    return !!(req.session?.isAdmin || req.session?.user?.role === 'admin');
}

/** @param {unknown} groups @returns {string[]} */
function groupIdsOf(groups) {
    if (Array.isArray(groups)) return groups.map(String);
    if (typeof groups !== 'string' || !groups) return [];
    try { return strings(JSON.parse(groups)); } catch { return []; }
}

/**
 * The permissions an orgRole carries in one organisation.
 * @param {AccessDeps} d
 * @param {unknown} orgRole
 * @param {string} orgId
 * @param {Map<string, Record<string, string[]>>} perOrg
 */
async function orgRolePermissions(d, orgRole, orgId, perOrg) {
    if (!orgRole) return [];
    const role = orgRole === LEGACY_ADMIN_ORG_ROLE ? ORG_ADMIN_ROLE : String(orgRole);
    if (!perOrg.has(orgId)) perOrg.set(orgId, await d.orgRoles.resolveOrgRolePermissions(orgId, d.catalog.getOrgRolePermissions()));
    return strings(perOrg.get(orgId)?.[role]);
}

/**
 * Everything the user holds in one organisation.
 * @param {AccessDeps} d
 * @param {UserRecord} user
 * @param {string} orgId
 * @returns {Promise<Set<string>>}
 */
async function permissionsInOrg(d, user, orgId) {
    const home = String(user.organizationId || '');
    const roles = new Map(/** @type {RoleRecord[]} */ (await d.userStore.getAllRoles()).map((r) => [String(r.id), strings(r.permissions)]));
    const mine = new Set(groupIdsOf(user.groups));
    const groups = /** @type {GroupRecord[]} */ (await d.userStore.getAllGroups())
        .filter((g) => mine.has(String(g.id)) && String(g.organizationId || home) === orgId);
    /** @type {Map<string, Record<string, string[]>>} */
    const perOrg = new Map();
    const held = new Set();
    /** @param {string[]} list */
    const add = (list) => { for (const p of list) held.add(p); };
    if (home === orgId) {
        add(await orgRolePermissions(d, user.orgRole, orgId, perOrg));
        if (user.role) add(roles.get(String(user.role)) || []);
    }
    for (const g of groups) {
        add(strings(g.permissions));
        for (const rid of strings(g.roles)) add(roles.get(rid) || []);
        add(await orgRolePermissions(d, g.orgRole, orgId, perOrg));
    }
    return held;
}

/**
 * After attachOrgFilter: the organisation the report reads. A super admin
 * without one from the scope reads the organisation on their user record;
 * a caller of none is refused rather than shown something else.
 * @param {AccessDeps} d
 */
function requireOrganisation(d) {
    /**
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     * @param {import('express').NextFunction} next
     */
    return async (req, res, next) => {
        const filters = req.usageFilters;
        if (filters && !filters.organizationId && !filters.userId && isSuperAdmin(req)) {
            const own = /** @type {UserRecord | null} */ (await d.userStore.getUser(String(req.session?.user?.id)));
            if (own?.organizationId) filters.organizationId = String(own.organizationId);
        }
        if (!filters?.organizationId) {
            return res.status(403).json({ error: 'The adoption report belongs to an organisation; this account has none.', code: 'no_organisation' });
        }
        return next();
    };
}

/**
 * After requireOrganisation: admin_monitoring held in the organisation being
 * reported. A failed lookup is not caught: it answers 500, never the report.
 * @param {AccessDeps} d
 */
function requireMonitoringInOrg(d) {
    /**
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     * @param {import('express').NextFunction} next
     */
    return async (req, res, next) => {
        if (isSuperAdmin(req)) return next();
        const orgId = String(req.usageFilters?.organizationId);
        const user = /** @type {UserRecord | null} */ (await d.userStore.getUser(String(req.session?.user?.id)));
        // The legacy super admin on the record (auth/permissionsResolve.js grants it `all`).
        if (user?.role === 'admin') return next();
        const held = user ? await permissionsInOrg(d, user, orgId) : new Set();
        if (held.has('all') || held.has(REPORT_PERMISSION)) return next();
        return res.status(403).json({
            error: `Permission '${REPORT_PERMISSION}' required in the organisation of this report`,
            code: 'not_in_organisation',
        });
    };
}

module.exports = { requireOrganisation, requireMonitoringInOrg, permissionsInOrg, isSuperAdmin };
