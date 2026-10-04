/**
 * Authorization for the monitoring read endpoints (/api/usage/guardrails/*,
 * /api/usage/integrations/*).
 *
 * These endpoints expose the org's egress ledger and guardrail events —
 * per-user violation counts, detected PII categories, destinations. Until this
 * middleware existed they were readable by ANY authenticated org member: the
 * mount-level gate in index.js checks the licence capability
 * (advanced_usage_monitoring), not a role, and attachOrgFilter checks only
 * `isAuthenticated`. routes/terminations.js had the correct rule all along
 * (requireOwnOrgAdminScope); this is that rule, applied here.
 *
 * Scope matrix:
 *   org member, org_admin role  → 200, scoped to the session org
 *   org member, plain member    → 403
 *   super admin WITH an org     → 200, scoped to their OWN org (resolved from
 *                                  their user record — resolveUserOrgIds
 *                                  returns null for admins, deliberately
 *                                  org-blind, so the record is the only source)
 *   super admin, no org at all  → 403 (per-org dashboards, not a global console)
 *   consumer (no org)           → 200, scoped to their OWN rows only; the
 *                                  personal privacy panel keeps working and a
 *                                  ?user= param can't widen the scope
 *
 * Also stamps `excludeDryRun` on the filters: every consumer of this
 * middleware is a dashboard, and dry-run automation traffic is rehearsal, not
 * egress — the compliance checks already excluded it, the dashboards did not.
 *
 * Runs AFTER usage.js's attachOrgFilter, which owns 401 + filter construction.
 */

const { resolveUserOrgIds, isOrgAdminRole } = require('../auth');
const userStore = require('../stores/userStore');
const log = require('../telemetry/log');

async function requireMonitoringScope(req, res, next) {
    try {
        if (!req.session?.isAuthenticated || !req.session?.user) {
            return res.status(401).json({ error: 'Not authenticated' });
        }
        const isSuperAdmin = req.session.isAdmin || req.session.user?.role === 'admin';
        const orgIds = await resolveUserOrgIds(req);

        // Consumer account — no org. attachOrgFilter already forced
        // usageFilters.userId to the session user; re-force it here so this
        // middleware is safe even if route wiring changes.
        if (orgIds !== null && orgIds.size === 0) {
            if (req.usageFilters) {
                req.usageFilters.userId = req.session.user.id;
                delete req.usageFilters.organizationId;
                req.usageFilters.excludeDryRun = true;
            }
            return next();
        }

        let orgId = orgIds && orgIds.size > 0 ? Array.from(orgIds)[0] : null;
        if (!orgId && isSuperAdmin) {
            // resolveUserOrgIds returns null for EVERY super admin (it is
            // deliberately org-blind for them), so "super admin with an org"
            // is only knowable from their own user record. Without this, the
            // platform operator got 403 on every monitoring dashboard.
            const admin = await userStore.getUser(req.session.user.id).catch(() => null);
            orgId = admin?.organizationId || null;
        }
        if (!orgId) return res.status(403).json({ error: 'No organisation context' });

        if (!isSuperAdmin) {
            const user = await userStore.getUser(req.session.user.id);
            if (!user || !isOrgAdminRole(user.orgRole)) {
                return res.status(403).json({ error: 'Organization admin access required' });
            }
        }
        if (req.usageFilters) {
            // The org always comes from the session — never from the query.
            req.usageFilters.organizationId = orgId;
            req.usageFilters.excludeDryRun = true;
        }
        return next();
    } catch (err) {
        log.error('[UsageMonitoringAuth] scope check failed:', err.message);
        return res.status(500).json({ error: 'Authorization check failed' });
    }
}

module.exports = { requireMonitoringScope };
