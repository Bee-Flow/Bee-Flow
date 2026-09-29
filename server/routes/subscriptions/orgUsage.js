/**
 * Org subscription teardown and read-outs — removing the subscription, the
 * current-period usage against the effective limits, and the resolved
 * effective-access view of the compound-gated features.
 *
 * All three read `:orgId` off the path and nothing else.
 *
 *   DELETE takes an empty body, pinned: a removal that carries `{ reason }` or
 *   `{ at_period_end: true }` is a caller that believes it is scheduling or
 *   annotating one, and it would be answered with an immediate removal.
 *
 *   The two GETs stay open, deliberately. They read no query at all, so a
 *   `.strict()` could only refuse the cache-busting parameters clients add to
 *   a GET, and the gate that matters there is requireAuthOrOrgMember, not a
 *   shape.
 */

const express = require('express');
const userStore = require('../../stores/userStore');
const usageStore = require('../../stores/usageStore');
const { getAdminId, requireAuthOrOrgMember } = require('./shared');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

const router = express.Router();

const WHY = 'removing a subscription is immediate and takes nothing but the organisation on the path.';

/**
 * No body at all (Express 5 leaves `req.body` undefined then), or an empty
 * one. Every refusal is a sentence that names the keys it would have ignored.
 */
const NoBody = z.preprocess(
    (v) => (v === undefined || v === null ? {} : v),
    z.object({}, {
        errorMap: (issue) => ({
            message: issue.code === 'unrecognized_keys'
                ? `This request takes no body, so ${issue.keys.map((k) => `'${k}'`).join(', ')} would change nothing: ${WHY}`
                : `This request takes no body: ${WHY}`,
        }),
    }).strict(),
);

// DELETE /api/subscriptions/orgs/:orgId
router.delete('/orgs/:orgId', validate({ body: NoBody }), async (req, res) => {
    const oldSub = await userStore.getOrgSubscription(req.params.orgId);
    const ok = await userStore.deleteOrgSubscription(req.params.orgId);
    if (!ok) return res.status(404).json({ error: 'No subscription found' });

    await userStore.logSubscriptionAudit('remove_subscription', 'org_subscription', req.params.orgId, getAdminId(req), oldSub, null);
    res.json({ success: true });
});

// GET /api/subscriptions/orgs/:orgId/usage — current period usage vs limits
router.get('/orgs/:orgId/usage', async (req, res) => {
    const sub = await userStore.getOrgSubscription(req.params.orgId);
    const effective = await userStore.getEffectiveLimits(req.params.orgId);
    if (!effective) return res.status(404).json({ error: 'No subscription' });

    // Use billing period instead of calendar month
    const period = userStore.getBillingPeriod(sub);
    const usage = await usageStore.getUsageSummary({ startDate: period.startDate, endDate: new Date().toISOString(), organizationId: req.params.orgId });

    // getUsageSummary aliases SUM(estimated_cost) AS **total_estimated_cost**
    // (stores/usageStore.js) — there is no `estimated_cost` key on the row.
    // Reading the wrong name made this endpoint report cost 0 (and 0% of the
    // cost cap) no matter how much the org had actually spent. Raw (un-marked-
    // up) cost is deliberate: core/limits.js gates on the same raw sum, so the
    // percentage here matches the number that actually triggers the block.
    const cost = Number(usage.total_estimated_cost) || 0;

    res.json({
        limits: effective,
        billing_period: period,
        billing_model: sub?.billing_model || 'fixed',
        usage: {
            messages: usage.total_calls || 0,
            tokens: usage.total_tokens || 0,
            cost,
        },
        percentages: {
            messages: effective.max_messages_per_month ? Math.round((usage.total_calls || 0) / effective.max_messages_per_month * 100) : null,
            tokens: effective.max_tokens_per_month ? Math.round((usage.total_tokens || 0) / effective.max_tokens_per_month * 100) : null,
            cost: effective.max_cost_per_month ? Math.round(cost / effective.max_cost_per_month * 100) : null,
        }
    });
});

// GET /api/subscriptions/orgs/:orgId/effective-access — resolved, read-only
// view of which compound-gated features actually WORK for the org under its
// current plan. Mirrors the `canUseFeature` derivation in
// loginRoutes.js (/auth/my-permissions) exactly — reuses the same helpers so
// the admin view never drifts from what users really get.
router.get('/orgs/:orgId/effective-access', requireAuthOrOrgMember, async (req, res) => {
    const { orgId } = req.params;
    const license = require('../../license');
    const licenseTiers = require('../../license/tiers');
    const { listCompoundGatedFeatures, getEffectiveOrgBetaAllowList } = require('../../core/entitlements/betaFeatures');

    const tier = await license.resolveTier({ organizationId: orgId });
    // getOrgGrantedFeatures already unions the plan's allowed_features AND
    // (on cloud) the licence features derived from the plan's beta
    // allow-list — same source the licence gate reads.
    const granted = new Set(await license.getOrgGrantedFeatures(orgId));
    const betaAllow = new Set(await getEffectiveOrgBetaAllowList(orgId));

    // Module layer: features owned by an un-imported platform module must
    // not surface here either (same contract as /registries — the
    // capability behaves as if it doesn't exist on the instance).
    let inactiveModuleCaps = new Set();
    try { inactiveModuleCaps = await require('../../modules').listInactiveCapabilityIds(); } catch (_) {}

    const features = listCompoundGatedFeatures().filter(g => !inactiveModuleCaps.has(g.id)).map(g => {
        const hasLicense = licenseTiers.tierHasFeature(tier, g.licenseFeature) || granted.has(g.licenseFeature);
        const betaAllowed = betaAllow.has(g.id);
        return {
            id: g.id,
            name: g.name,
            licenseFeature: g.licenseFeature,
            hasLicense,
            betaAllowed,
            effective: hasLicense && betaAllowed,
        };
    });
    res.json({ tier, features });
});

module.exports = router;
