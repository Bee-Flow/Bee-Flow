/**
 * Subscriptions API Routes — Plan and org subscription management
 * All write routes require super admin access. Org members can read their own subscription.
 */

// This file is a thin facade. The routes live in subscriptions/ per resource,
// and the sub-routers are mounted in the SAME order the routes were originally
// registered — Express is first-match, so that order is the contract (the same
// rule routes/stripe.js follows). The two router-level gates stay here: they
// must run in front of every sub-router, and the access helpers they share
// with the sub-routers live once in subscriptions/shared.js.
const express = require('express');

const router = express.Router();
const {
    isSuperAdmin,
    requireAdmin,
    isOrgAdminForOrg,
    requireAuthOrOrgMember,
} = require('./subscriptions/shared');

// Self-hosted installs use license keys, not Stripe subscriptions. Block the
// entire subscriptions API up front so neither the admin Plans CRUD nor
// per-org/consumer reads accidentally bleed cloud SaaS concepts into a
// customer-run server. Cloud (DEPLOYMENT_MODE=cloud, default) is unchanged.
router.use((req, res, next) => {
    if ((process.env.DEPLOYMENT_MODE || 'cloud') === 'self-hosted') {
        return res.status(404).json({ error: 'not_available_in_self_hosted', message: 'Subscriptions are a Bee Flow Cloud feature. Self-hosted installs use license keys.' });
    }
    next();
});

// Admin-only for plans and write operations; org members can read their own
// org sub; org-admins can drive lifecycle actions on their own org.
router.use(async (req, res, next) => {
    // GET /orgs/:orgId and /orgs/:orgId/usage — allow org members
    const orgMatch = req.path.match(/^\/orgs\/([^/]+)(\/usage)?$/);
    if (req.method === 'GET' && orgMatch) {
        req.params.orgId = req.params.orgId || orgMatch[1];
        return requireAuthOrOrgMember(req, res, next);
    }
    // GET /consumer/usage — allow any authenticated user (consumer accounts)
    if (req.method === 'GET' && req.path === '/consumer/usage') {
        if (!req.session?.isAuthenticated) return res.status(401).json({ error: 'Not authenticated' });
        return next();
    }
    // POST /orgs/:orgId/{upgrade|cancel|reactivate} — org-admin of that org
    const orgLifecycle = req.path.match(/^\/orgs\/([^/]+)\/(upgrade|cancel|reactivate)$/);
    if (req.method === 'POST' && orgLifecycle) {
        if (!req.session?.isAuthenticated) return res.status(401).json({ error: 'Not authenticated' });
        if (await isOrgAdminForOrg(req, orgLifecycle[1])) return next();
        return res.status(403).json({ error: 'Org admin access required' });
    }
    // POST /consumer/:userId/{upgrade|cancel|reactivate} — the owner only
    const consumerLifecycle = req.path.match(/^\/consumer\/([^/]+)\/(upgrade|cancel|reactivate)$/);
    if (req.method === 'POST' && consumerLifecycle) {
        if (!req.session?.isAuthenticated) return res.status(401).json({ error: 'Not authenticated' });
        if (req.session.user?.id === consumerLifecycle[1]) return next();
        if (await isSuperAdmin(req)) return next();
        return res.status(403).json({ error: 'Owner access required' });
    }
    // Everything else requires super admin
    return requireAdmin(req, res, next);
});

router.use(require('./subscriptions/plans'));
router.use(require('./subscriptions/orgSubscriptions'));
router.use(require('./subscriptions/licenseReissue'));
router.use(require('./subscriptions/lifecycle'));
router.use(require('./subscriptions/orgUsage'));
router.use(require('./subscriptions/audit'));
router.use(require('./subscriptions/consumerAccount'));
router.use(require('./subscriptions/platformConfig'));

module.exports = router;
