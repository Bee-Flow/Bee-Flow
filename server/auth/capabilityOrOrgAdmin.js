/**
 * A capability gate with an org-admin escape hatch for ORG-level endpoints.
 *
 * Meeting Notes can be rolled out per group (`groupScoped` in
 * core/entitlements/betaFeatures.js). Its settings and summary-template routers
 * mix two kinds of endpoint behind one mount:
 *   - the caller's own settings / templates: these follow the capability, so a
 *     person outside the rollout cannot reach them;
 *   - the org's settings / org + group templates: these are administration. An
 *     org admin who narrowed Meeting Notes to some groups (and is not in one of
 *     them) must still be able to configure it for the people who are.
 *
 * `orgIdFor(req)` names the org a request administers, or null for a personal
 * endpoint. When it names one and the caller is an org admin of it, the
 * capability gate is skipped; the router's own org-admin checks still decide
 * what the call may do. In every other case the capability gate runs as usual.
 */
const { tagGate, readGate } = require('./gateMeta');

function requireCapabilityOrOrgAdmin(capabilityGate, { orgIdFor, isOrgAdminForOrg, log }) {
    const meta = readGate(capabilityGate) || {};
    return tagGate(async function capabilityOrOrgAdminGate(req, res, next) {
        let orgId = null;
        try { orgId = await orgIdFor(req); } catch { orgId = null; }
        if (orgId && req.session?.user) {
            let admin = false;
            try { admin = await isOrgAdminForOrg(req, orgId); } catch (e) {
                log?.warn?.(`[entitlements] org-admin bypass check failed org=${orgId}: ${e.message}`);
            }
            if (admin) return next();
        }
        return capabilityGate(req, res, next);
    }, { ...meta, orgAdminBypass: true });
}

/** The org the session belongs to (what the summary-template router acts on). */
function sessionOrgId(req) {
    const u = req.session?.user;
    return u?.organizationId || u?.orgId || null;
}

/**
 * `/:orgId` endpoints of the Talk / Google Meet settings routers. `/user/me`
 * (and anything deeper) is personal.
 */
function settingsOrgIdFor(req) {
    const parts = String(req.path || '').split('/').filter(Boolean);
    if (parts.length !== 1 || parts[0] === 'user') return null;
    return decodeURIComponent(parts[0]);
}

/**
 * Summary templates: the org list, creating an org/group template, and
 * editing or deleting a template by id (the router's authorizeWrite still
 * limits a user-scope template to its owner). Listing the caller's own
 * templates and creating a personal one stay behind the capability.
 */
function summaryTemplateOrgIdFor(req) {
    const path = String(req.path || '/');
    const method = String(req.method || 'GET').toUpperCase();
    if (method === 'GET') return path === '/org' ? sessionOrgId(req) : null;
    if (method === 'POST') {
        const scope = req.body?.scope;
        return path === '/' && (scope === 'org' || scope === 'group') ? sessionOrgId(req) : null;
    }
    if (method === 'PATCH' || method === 'DELETE') return path !== '/' ? sessionOrgId(req) : null;
    return null;
}

module.exports = { requireCapabilityOrOrgAdmin, settingsOrgIdFor, summaryTemplateOrgIdFor };
