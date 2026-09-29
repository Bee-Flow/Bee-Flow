/**
 * Manual license re-issue for an existing org or consumer subscription — the
 * Retry behind a `license_issuance_failed` audit row.
 *
 * The retry takes its whole input from the stored subscription (plan, tier,
 * Stripe ids) and the `:orgId` / `:userId` on the path. The body is therefore
 * pinned EMPTY rather than left open: a caller that sends `{ planId }` or
 * `{ tier }` believes it is choosing what gets issued, and used to be answered
 * with a 200 for a licence minted from the stored plan instead.
 */

const express = require('express');
const userStore = require('../../stores/userStore');
const { getAdminId } = require('./shared');
const { HttpError } = require('../../core/http/errors');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

const router = express.Router();

const WHY = 'the retry issues the licence for the plan on the stored subscription.';

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

// POST /api/subscriptions/orgs/:orgId/reissue-license — manually re-attempt
// the license server call for an existing org subscription. Use when a
// previous issuance failed (the audit log will have a `license_issuance_failed`
// row); calling this retries against the current subscription state.
router.post('/orgs/:orgId/reissue-license', validate({ body: NoBody }), async (req, res, next) => {
    const orgId = req.params.orgId;
    const sub = await userStore.getOrgSubscription(orgId);
    if (!sub) return res.status(404).json({ error: 'No subscription found' });
    const planId = sub.plan_id;
    if (!planId) return res.status(400).json({ error: 'Subscription has no plan_id' });
    const plan = await userStore.getPlan(planId);
    const { issueLicenseFromCheckout, resolveTierForPlan } = require('../../license/issuance');
    const tier = resolveTierForPlan(plan);
    if (!tier) return res.status(400).json({ error: 'Plan does not map to a license tier' });
    try {
        const result = await issueLicenseFromCheckout({
            scope: 'organization',
            organizationId: orgId,
            planId,
            tier,
            stripeCustomerId: sub.stripe_customer_id || null,
            stripeSubscriptionId: sub.stripe_subscription_id || null,
        });
        await userStore.logSubscriptionAudit(
            'license_issuance_succeeded', 'organization', orgId, getAdminId(req), null,
            { plan_id: planId, tier, stripe_subscription_id: sub.stripe_subscription_id || null, license_id: result?.licenseId || null, manual: true }
        );
        res.json({ success: true, license_id: result?.licenseId || null });
    } catch (e) {
        await userStore.logSubscriptionAudit(
            'license_issuance_failed', 'organization', orgId, getAdminId(req), null,
            { plan_id: planId, error_code: e.code || null, error: String(e.message || e).slice(0, 500), stripe_subscription_id: sub.stripe_subscription_id || null, manual: true }
        );
        next(new HttpError(502, e.code || 'license_issuance_failed', e.message));
    }
});

// POST /api/subscriptions/consumer/:userId/reissue-license — same as above for
// individual / consumer subscriptions.
router.post('/consumer/:userId/reissue-license', validate({ body: NoBody }), async (req, res, next) => {
    const userId = req.params.userId;
    const sub = await userStore.getConsumerSubscription(userId);
    if (!sub) return res.status(404).json({ error: 'No subscription found' });
    const planId = sub.plan_id;
    if (!planId) return res.status(400).json({ error: 'Subscription has no plan_id' });
    const plan = await userStore.getPlan(planId);
    const { issueLicenseFromCheckout, resolveTierForPlan } = require('../../license/issuance');
    const tier = resolveTierForPlan(plan);
    if (!tier) return res.status(400).json({ error: 'Plan does not map to a license tier' });
    try {
        const result = await issueLicenseFromCheckout({
            scope: 'consumer',
            userId,
            planId,
            tier,
            stripeCustomerId: sub.stripe_customer_id || null,
            stripeSubscriptionId: sub.stripe_subscription_id || null,
        });
        await userStore.logSubscriptionAudit(
            'license_issuance_succeeded', 'consumer', userId, getAdminId(req), null,
            { plan_id: planId, tier, stripe_subscription_id: sub.stripe_subscription_id || null, license_id: result?.licenseId || null, manual: true }
        );
        res.json({ success: true, license_id: result?.licenseId || null });
    } catch (e) {
        await userStore.logSubscriptionAudit(
            'license_issuance_failed', 'consumer', userId, getAdminId(req), null,
            { plan_id: planId, error_code: e.code || null, error: String(e.message || e).slice(0, 500), stripe_subscription_id: sub.stripe_subscription_id || null, manual: true }
        );
        next(new HttpError(502, e.code || 'license_issuance_failed', e.message));
    }
});

module.exports = router;
