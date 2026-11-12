// @typecheck strict
/**
 * The scope every usage read runs under: the period from the query, and the
 * organisation (or, for a caller of none, their own rows) from the session.
 * Split out of routes/usage.js, which holds the routes.
 */

/** @typedef {import('express-serve-static-core').NextFunction} NextFunction */
const auth = require('../auth');
const { resolveUserOrgIds } = auth;
const userStore = require('../stores/userStore');
const log = require('../telemetry/log');
const { HttpError } = require('../core/http/errors');
const { coveredScope } = require('./monitoringOrg.mts');

// Helper to parse days filter
/**
 * @param {string} [daysParam]
 */
function getDateFilters(daysParam = '30') {
    const days = parseInt(daysParam, 10) || 30;
    const now = new Date();
    const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    return { startDate: start.toISOString(), endDate: now.toISOString() };
}

// Resolve org filter for usage queries. Strict: an organisation that could
// not be READ (the store stumbled) is `'__unknown__'`, never a caller of no
// organisation — the two look the same (an empty set) and only the second
// may be answered with the caller's own rows.
//
//   - a platform admin (resolveUserOrgIds answers null for exactly them): the
//     organisation of auth/adminOrg.mts resolveAdminOrgId — `?orgId` — or
//     null, every organisation;
//   - anyone else: their first organisation, which is their HOME organisation
//     whenever they have one (auth/orgScope.js puts it first), so an
//     organisation admin always reads their own. A `?orgId` naming any other
//     organisation is a 403, never a wider or different answer.
// Throws HttpError (400, 403, 404) for a refused `?orgId`.
/** @param {import('express').Request} req */
async function getOrgFilter(req) {
    let orgIds;
    try {
        orgIds = await resolveUserOrgIds(req, { strict: true });
    } catch (e) {
        log.warn('[usage] organisation scope unavailable:', /** @type {Error} */ (e).message);
        return '__unknown__';
    }
    if (orgIds === null) return require('../auth/permissions').resolveAdminOrgId(req);
    const orgId = orgIds.size === 0 ? '__none__' : Array.from(orgIds)[0];
    const named = req.query?.orgId;
    if (named !== undefined && named !== '' && named !== orgId) {
        throw new HttpError(403, 'org_admin_required', 'Organization admin access required');
    }
    return orgId;
}

/**
 * What a usage answer covers, for its `scope` block (routes/monitoringOrg.mts
 * coveredScope): the organisation of the filters, all organisations for a
 * platform admin without one, or the caller's own rows.
 * @param {import('express').Request} req
 */
function usageScopeOf(req) {
    const orgId = typeof req.usageFilters?.organizationId === 'string' ? req.usageFilters.organizationId : null;
    // The isSuperAdmin predicate, spelled as narrowMembersToOwnRows below spells it.
    const platformAdmin = !!(req.session?.isAdmin || req.session?.user?.role === 'admin');
    return coveredScope(orgId, !orgId && platformAdmin, (id) => userStore.getOrganization(id));
}

// Build filters from request query params
/** @param {import('express').Request} req */
function buildRequestFilters(req) {
    // Prefer an explicit absolute window (startDate/endDate) when the client
    // sends one — this makes custom / historical ranges accurate instead of the
    // days-relative window anchored at "now". Falls back to ?days= otherwise.
    // Mirrors the pattern already used in server/routes/terminations.js.
    /** @type {Record<string, any>} */
    const filters = (req.query.startDate && req.query.endDate)
        ? { startDate: req.query.startDate, endDate: req.query.endDate }
        : { ...getDateFilters(/** @type {string | undefined} */ (req.query.days)) };
    if (req.query.user) filters.userId = req.query.user;
    if (req.query.agent) filters.agentId = req.query.agent;
    if (req.query.model) filters.model = req.query.model;
    if (req.query.source) filters.source = req.query.source;
    if (req.query.integration) filters.integrationType = req.query.integration;
    if (req.query.pii) filters.piiCategory = req.query.pii;
    return filters;
}

// Middleware: attach org filter
/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {NextFunction} next
 */
async function attachOrgFilter(req, res, next) {
    const user = req.session?.user;
    if (!req.session?.isAuthenticated || !user) return res.status(401).json({ error: 'Not authenticated' });
    /** @type {string | null} */
    let orgId;
    try {
        orgId = await getOrgFilter(req);
    } catch (err) {
        return next(err);
    }
    if (orgId === '__unknown__') {
        return res.status(403).json({ error: 'Your organisation could not be determined. Please retry.', code: 'org_scope_unavailable' });
    }
    req.usageFilters = buildRequestFilters(req);
    if (orgId === '__none__') {
        // Consumer account — no org. Scope strictly to the caller's own
        // usage so the personal "Usage & Monitoring" panel works, and so a
        // ?user= query param can't be used to peek at someone else's rows.
        req.usageFilters.userId = user.id;
    } else if (orgId) {
        req.usageFilters.organizationId = orgId;
    }
    next();
}

// The consumption views that list or single out people.
const PERSON_LEVEL_PATHS = new Set([
    '/users', '/by-user', '/models-by-user', '/by-conversation', '/by-swarm-run', '/recent',
    '/azure-services/by-user', '/azure-services/recent',
]);

/**
 * Org admins and holders of admin_monitoring see the organisation per person;
 * anyone else in the org sees only their own rows there. Both are decided IN
 * the organisation the filters read (req.usageFilters.organizationId): the
 * orgRole of the caller's home organisation counts for that organisation only,
 * and admin_monitoring must hold there (auth/permissionGrants.mts), not in some
 * other organisation the caller is in. A failed lookup answers no.
 * @param {import('express').Request} req
 * @returns {Promise<boolean>}
 */
async function mayViewColleagues(req) {
    const userId = req.session?.user?.id;
    const orgId = req.usageFilters?.organizationId;
    if (!userId || typeof orgId !== 'string' || !orgId) return false;
    try {
        const user = await userStore.getUser(userId);
        if (user && auth.isOrgAdminRole(user.orgRole) && user.organizationId === orgId) return true;
        return (await auth.resolvePermissionsByOrg(userId, req.session)).holds('admin_monitoring', orgId);
    } catch (e) {
        log.warn('[usage] colleague-view check failed:', /** @type {Error} */ (e).message);
        return false;
    }
}

/**
 * Runs after attachOrgFilter. A member of an organisation who may not view
 * colleagues keeps the organisation totals, but on the per-person views, and
 * wherever ?user= names someone else, the filter is narrowed to the caller.
 * Super admins and callers without an organisation are left as they are.
 * @param {import('express').Request} req
 * @param {import('express').Response} _res
 * @param {NextFunction} next
 */
async function narrowMembersToOwnRows(req, _res, next) {
    const filters = req.usageFilters;
    const me = req.session?.user;
    if (!filters || !me || !filters.organizationId) return next();
    if (req.session?.isAdmin || me.role === 'admin') return next();
    const personLevel = PERSON_LEVEL_PATHS.has(req.path);
    const otherPerson = !!filters.userId && filters.userId !== me.id;
    if (!personLevel && !otherPerson) return next();
    if (await mayViewColleagues(req)) return next();
    filters.userId = me.id;
    next();
}

module.exports = { getDateFilters, getOrgFilter, buildRequestFilters, attachOrgFilter, narrowMembersToOwnRows, mayViewColleagues, usageScopeOf };
