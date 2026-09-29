// @typecheck
/**
 * Login Routes — the caller's own permission snapshot: permissions, groups,
 * organisations, allowed agent types and the entitlement-derived feature map
 * the SPA gates its UI on. Split out of auth/loginRoutes.js; mounted there
 * first, in the original registration order.
 *
 * No request schema: the answer is the session's own snapshot and nothing is
 * read from the body or the query (the entitlement resolver it calls reads
 * only `req.session`). Every screen of the SPA and the mobile app waits on
 * this one call, and neither sends a parameter.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();

const userStore = require('../../stores/userStore');
const { requireAuth, getUserPermissions } = require('../permissions');

// Get current user's permissions (dynamic)
router.get('/my-permissions', requireAuth, async (req, res) => {
    const userId = req.session.user?.id;
    const perms = await getUserPermissions(userId, req.session);

    // Also resolve user's groups and organizations for frontend scoping
    let userGroups = [];
    let userOrgIds = [];
    let allowedAgentTypes = [];
    let user = null;
    try {
        user = await userStore.getUser(userId);
        if (user) {
            userGroups = Array.isArray(user.groups) ? user.groups : (() => { try { return JSON.parse(user.groups || '[]'); } catch (_) { return []; } })();
            const allGroups = await userStore.getAllGroups();
            const orgSet = new Set();
            const agentTypeSet = new Set();
            for (const gid of userGroups) {
                const group = allGroups.find(g => g.id === gid);
                if (group?.organizationId) orgSet.add(group.organizationId);
                // Merge allowed agent types from all groups
                const types = group?.allowedAgentTypes || [];
                for (const t of types) agentTypeSet.add(t);
            }
            // Include direct org assignment
            if (user.organizationId) orgSet.add(user.organizationId);
            userOrgIds = [...orgSet];
            allowedAgentTypes = [...agentTypeSet];
        }
    } catch (_) { }

    // Derive the beta-feature list AND the canUseFeature map from the ONE unified
    // resolver (the same resolveEntitlements that requireCapability enforces), so
    // the SPA's UI gates agree with every API gate. Previously these were computed
    // from a parallel resolver (getUserBetaFeatures + tier/grant math); that
    // second path could drift, which is what made a page render while its API 403'd.
    let betaFeatures = [];
    const canUseFeature = {};
    try {
        const entitlements = require('../../core/entitlements/entitlements');
        const { listCompoundGatedFeatures } = require('../../core/entitlements/betaFeatures');
        const snap = await entitlements.resolveEntitlements({
            userId,
            orgId: req.session.user?.organizationId || req.session.user?.orgId || null,
            session: req.session,
            req,
        });
        if (snap && !snap.degraded) {
            // The granted beta capabilities (effective.beta) — exactly what the
            // API allows. Drives `user.betaFeatures.includes('X')` UI checks.
            betaFeatures = Array.isArray(snap.effective?.beta) ? snap.effective.beta.slice() : [];
            // canUseFeature[id] = the capability is effective (the compound
            // licence-AND-beta decision is already folded in by the resolver).
            for (const g of listCompoundGatedFeatures()) {
                canUseFeature[g.id] = entitlements.snapshotHas(snap, g.id);
            }
        } else {
            // Transient resolver outage — fall back to the legacy beta list so the
            // UI isn't hard-locked (the API still enforces authoritatively).
            try { betaFeatures = await require('../../core/entitlements/betaFeatures').getUserBetaFeatures(userId, req.session); } catch (_) { /* leave empty */ }
        }
    } catch (err) {
        log.warn('[Auth] my-permissions — entitlement resolution failed:', err?.message);
        try { betaFeatures = await require('../../core/entitlements/betaFeatures').getUserBetaFeatures(userId, req.session); } catch (_) { /* leave empty */ }
    }

    res.json({ permissions: perms, groups: userGroups, organizations: userOrgIds, allowedAgentTypes, betaFeatures, canUseFeature, orgRole: user?.orgRole || '' });
});

module.exports = router;
