// @typecheck
/**
 * Nextcloud audience helper — single source of truth for "is this caller's
 * organisation a Nextcloud-connector org, and may it therefore see the plans
 * flagged nc_only?".
 *
 * The `nc_only` flag on subscription_plans narrows `is_public`: a public plan
 * carrying it is offered only to organisations that came in through the
 * Nextcloud app. Four surfaces have to apply that rule (billing/offered-plans,
 * stripe/plans, subscriptions upgradeable+changeable, and the checkout guard),
 * so the predicate lives here rather than being re-derived per route — the
 * same reason audience.js exists for published entities.
 *
 * "NC org" is the two-signal definition orgHealthStore already treats as
 * canonical (see getFleetOverview): nc_instance_id set, or registration_source
 * = 'nextcloud_connector'. registration_source is write-once at creation, so it
 * survives an unbind; nc_instance_id covers orgs created before that column
 * existed. Deliberately org-level and not session-level: an NC org admin who
 * logs in at beeflow.nl in a normal browser is still an NC customer.
 */

const userStore = require('../stores/userStore');
const { resolveUserOrgIds } = require('./permissions');

/**
 * @param {string|null} orgId
 * @returns {Promise<boolean>} false for a missing/unknown org — callers gate a
 *   restricted plan on this, so an absent org must not unlock anything.
 */
async function isNcOrg(orgId) {
    if (!orgId) return false;
    const org = await userStore.getOrganization(orgId);
    if (!org) return false;
    return !!(org.nc_instance_id || org.ncInstanceId
        || org.registrationSource === 'nextcloud_connector'
        || org.registration_source === 'nextcloud_connector');
}

/**
 * Resolve the caller's organisation the same way routes/stripe.js does — the
 * session user doesn't always carry organizationId (membership can come via a
 * group), so fall back to the RBAC resolver and finally a DB read.
 *
 * @returns {Promise<string|null>}
 */
async function resolveOrgIdForRequest(req) {
    const user = req.session?.user || {};
    let orgId = user.organizationId || user.orgId || null;
    if (!orgId) {
        try {
            const orgIds = await resolveUserOrgIds(req); // null = super-admin
            if (orgIds && orgIds.size > 0) orgId = Array.from(orgIds)[0];
        } catch (_) { /* fall through */ }
    }
    if (!orgId && user.id) {
        try { const full = await userStore.getUser(user.id); orgId = full?.organizationId || null; } catch (_) { /* ignore */ }
    }
    return orgId;
}

/**
 * Convenience for routes that only have a request: true when the caller's org
 * is NC-connected. Consumer accounts (no org) resolve to false.
 */
async function resolveNcContextForRequest(req) {
    return isNcOrg(await resolveOrgIdForRequest(req));
}

/**
 * Drop nc_only plans unless the caller is an NC org. Keep every listing
 * endpoint going through this so the rule can't drift between them.
 */
function filterNcOnlyPlans(plans, isNc) {
    if (!Array.isArray(plans)) return [];
    return isNc ? plans : plans.filter(p => !p.nc_only);
}

module.exports = {
    isNcOrg,
    resolveOrgIdForRequest,
    resolveNcContextForRequest,
    filterNcOnlyPlans,
};
