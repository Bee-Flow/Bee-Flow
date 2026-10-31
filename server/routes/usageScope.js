// @typecheck strict
/**
 * The scope every usage read runs under: the period from the query, and the
 * organisation (or, for a caller of none, their own rows) from the session.
 * Split out of routes/usage.js, which holds the routes.
 */

/** @typedef {import('express-serve-static-core').NextFunction} NextFunction */
const { resolveUserOrgIds } = require('../auth');
const log = require('../telemetry/log');

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
/** @param {import('express').Request} req */
async function getOrgFilter(req) {
    let orgIds;
    try {
        orgIds = await resolveUserOrgIds(req, { strict: true });
    } catch (e) {
        log.warn('[usage] organisation scope unavailable:', /** @type {Error} */ (e).message);
        return '__unknown__';
    }
    if (orgIds === null) return null;
    if (orgIds.size === 0) return '__none__';
    return Array.from(orgIds)[0];
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
    const orgId = await getOrgFilter(req);
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

module.exports = { getDateFilters, getOrgFilter, buildRequestFilters, attachOrgFilter };
