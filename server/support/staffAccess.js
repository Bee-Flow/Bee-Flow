/**
 * Bee Flow company-support staff gate: the `admin_support` permission check +
 * acting-org resolution used by routes/support.js (and the auto-assigner's
 * eligibility scan). Distinct from support/access.js, which is the per-inbox
 * group ACL for the tenant Support studio — do not merge the two.
 */

const { isSuperAdmin, getUserPermissions, resolveUserOrgIds } = require('../auth/permissions');
const log = require('../telemetry/log');

/**
 * Pure permission-set check. getUserPermissions returns an array of permission
 * strings (or ['all'] for admins); tolerate a Set for future-proofing.
 */
function hasSupportPerms(perms) {
    if (Array.isArray(perms)) return perms.includes('admin_support') || perms.includes('all');
    if (perms instanceof Set) return perms.has('admin_support') || perms.has('all');
    return false;
}

/**
 * May this requester act as Bee Flow support staff? Super admins always;
 * otherwise the user needs the admin_support (or all) permission.
 */
async function hasAdminSupport(req, userId) {
    if (isSuperAdmin(req)) return true;
    if (!userId) return false;
    try {
        // getUserPermissions(userId, session) — pass IDs, not the whole req.
        const perms = await getUserPermissions(userId, req.session || null);
        return hasSupportPerms(perms);
    } catch (e) {
        log.warn('[Support] _hasAdminSupport check failed:', e.message);
        return false;
    }
}

/**
 * Acting org for staff-managed catalogues (tags, canned responses, SLA).
 * Super-admins manage system-wide entries (org = null). Org-scoped support
 * staff manage entries for their own org only.
 */
async function actingOrgId(req) {
    if (isSuperAdmin(req)) return null;
    const orgIds = await resolveUserOrgIds(req);
    if (orgIds === null) return null; // also super-admin
    const first = [...orgIds][0];
    return first || null;
}

module.exports = { hasSupportPerms, hasAdminSupport, actingOrgId };
