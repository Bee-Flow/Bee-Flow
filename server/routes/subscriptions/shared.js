/**
 * Shared access gates for the subscriptions routers — the super-admin check,
 * the org-admin/org-member checks and the audit actor id.
 *
 * They live here once so the router-level gate in routes/subscriptions.js and
 * the sub-routers resolve the SAME functions; a second copy would be a second
 * answer to "who may touch this subscription".
 */

const {
    isSuperAdmin: isPlatformAdmin,
    isOrgAdminForOrg: isOrgAdminForOrgCanonical,
    resolveUserOrgIds,
} = require('../../auth/permissions');

// Operational gate for write routes (plan CRUD, audit, etc.) — platform
// operator only.
//
// This used to resolve `hasPermission(userId, 'admin_subscriptions')`, which
// config/orgRoles.json grants to every org_admin. A function named
// `isSuperAdmin` therefore returned true for any self-registered org admin,
// handing them global CRUD over subscription_plans through the fallthrough at
// the bottom of the router-level gate. The name read as correct, which is
// exactly what made it survive review. It now delegates to the single
// definition in auth/permissions.js (users.role === 'admin' / session.isAdmin).
//
// The three non-gate callers below use it as a cross-org override, so they are
// tightened by the same change. Org admins keep their own org's lifecycle
// rights via the explicit orgRole check in isOrgAdminForOrg.
async function isSuperAdmin(req) {
    return isPlatformAdmin(req);
}

async function requireAdmin(req, res, next) {
    if (!(await isSuperAdmin(req))) return res.status(403).json({ error: 'Admin access required' });
    next();
}

// Lifecycle actions (upgrade/cancel/reactivate) are allowed for org-admins of
// the same org plus super-admins. Distinct from `requireAuthOrOrgMember` —
// regular org members can read the subscription but must not be able to
// change the billing relationship.
//
// Resolved against the DATABASE, not the session. An SSO session's `user`
// object holds only { id, email, picture, firstName, lastName, displayName,
// provider } — no role, orgRole, organizationId or permissions — so the old
// session-field comparison silently denied every SSO org admin. It only
// appeared to work because the previous isSuperAdmin() did a DB permission
// lookup that happened to admit them (and, being 'admin_subscriptions', admitted
// them to the platform-wide routes as well — the hole this file was fixed for).
async function isOrgAdminForOrg(req, orgId) {
    return isOrgAdminForOrgCanonical(req, orgId);
}

// Allow authenticated users to read their own org's subscription, super admins can access all
async function requireAuthOrOrgMember(req, res, next) {
    if (!req.session?.isAuthenticated) return res.status(401).json({ error: 'Not authenticated' });
    if (await isSuperAdmin(req)) return next();
    const orgId = req.params.orgId;
    if (orgId) {
        // null => platform admin (no org filter); otherwise the set of orgs the
        // user belongs to, via their own row and their groups.
        const orgIds = await resolveUserOrgIds(req);
        if (orgIds === null || orgIds.has(orgId)) return next();
    }
    return res.status(403).json({ error: 'Admin access required' });
}

function getAdminId(req) {
    return req.session?.user?.id || req.session?.user?.username || 'unknown';
}

module.exports = {
    isSuperAdmin,
    requireAdmin,
    isOrgAdminForOrg,
    requireAuthOrOrgMember,
    getAdminId,
};
