/**
 * Subscription lifecycle — the in-app plan change (upgrade / scheduled
 * downgrade), its cost preview, and cancel / reactivate, for orgs and for
 * consumer accounts. The two halves share the Stripe payment-error mapping
 * and the customer-facing error copy, so they stay in one module.
 */

const express = require('express');
const userStore = require('../../stores/userStore');
const { isNcOrg } = require('../../auth/ncAudience');
const { getAdminId } = require('./shared');
const log = require('../../telemetry/log');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

const router = express.Router();

// ── What a caller may send ──────────────────────────────────────────
//
// These routes name the plan `planId`, while the two start-trial routes in
// this same API name it `plan_id`. A truthiness check on one spelling answers
// the other with "planId is required", which reads like a bug in the caller's
// code rather than in its spelling; `.strict()` names the key it did not
// expect instead.

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/** A body that also accepts no body at all: Express 5 leaves `req.body` undefined then. */
const bodyOf = (shape) => z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object(shape).strict());

const PLAN_TEXT = 'planId is required — the plan to change to.';
const PlanChangeBody = z.object({
    planId: worded(PLAN_TEXT).trim().min(1, PLAN_TEXT),
}).strict();

// cancel / reactivate / cancel-downgrade act on the subscription that is
// already there, so they take nothing. Strict, so a caller that thinks it is
// passing a plan or a reason is told the route ignores it.
const NoBody = bodyOf({});

// ── Subscription lifecycle (upgrade / cancel / reactivate) ────────────────
// In-app actions for the org admin. Drives `stripe.subscriptions.update`
// directly so the customer stays on the same subscription (no new Checkout
// session). Downgrades are intentionally rejected — the funnel only opens
// upward and cancellations end the relationship at period boundary.

const lifecycleErrorMessages = {
    same_plan: 'You are already on this plan.',
    no_price_change: 'The selected plan has the same price as your current plan.',
    interval_mismatch: 'Switching between monthly and yearly billing is not available here. Contact info@beeflow.nl.',
    wrong_plan_type: 'This plan does not match your account type.',
    nc_only_plan: 'This plan is only available to organisations connected through Nextcloud.',
    'Subscription is not Stripe-managed': 'This subscription has no active payment yet. Choose a paid plan below to subscribe.',
    'Plan not configured for payment': 'That plan is not available for self-service billing yet.',
};

// Translate Stripe payment errors that surface during a synchronous
// subscription.update — e.g. proration invoice declined — into HTTP 402 so
// the UI can show a clear "update your payment method" prompt instead of a
// generic 500.
function stripePaymentErrorStatus(err) {
    if (!err) return null;
    if (err.statusCode === 402) return 402;
    if (err.code === 'card_declined' || err.code === 'authentication_required') return 402;
    if (err.type === 'StripeCardError') return 402;
    return null;
}

// Generalised in-app plan change. Upgrades (higher price) apply immediately
// with a prorated charge; downgrades (lower price) are scheduled to take
// effect at the end of the current billing period via a Stripe Subscription
// Schedule — no mid-cycle credit. Entitlements for a scheduled downgrade are
// (deliberately) NOT applied now: the customer.subscription.updated webhook
// applies them when the new price actually becomes active at the boundary.
async function performOrgPlanChange(orgId, planId, adminId) {
    const stripeService = require('../../services/stripeService');
    const sub = await userStore.getOrgSubscription(orgId);
    if (!sub) { const e = new Error('No subscription found'); e.status = 404; throw e; }
    if (!sub.stripe_subscription_id) { const e = new Error('Subscription is not Stripe-managed'); e.status = 404; throw e; }
    const newPlan = await userStore.getPlan(planId);
    if (!newPlan) { const e = new Error('Plan not found'); e.status = 404; throw e; }
    if (!newPlan.stripe_price_id) { const e = new Error('Plan not configured for payment'); e.status = 400; throw e; }
    const currentPlan = sub.plan_id ? await userStore.getPlan(sub.plan_id) : null;
    if (!currentPlan) { const e = new Error('Current plan is not resolvable'); e.status = 409; throw e; }

    if (newPlan.id === currentPlan.id) { const e = new Error('same_plan'); e.status = 400; throw e; }
    const newPrice = Number(newPlan.price) || 0;
    const curPrice = Number(currentPlan.price) || 0;
    if (newPrice === curPrice) { const e = new Error('no_price_change'); e.status = 400; throw e; }
    if (newPlan.billing_interval !== currentPlan.billing_interval) { const e = new Error('interval_mismatch'); e.status = 400; throw e; }
    if ((newPlan.plan_type || 'organization') !== (currentPlan.plan_type || 'organization')) { const e = new Error('wrong_plan_type'); e.status = 400; throw e; }
    // The pickers already omit nc_only plans for non-NC orgs, but the plan id is
    // all this route needs, so refuse it here too. A lookup failure throws and
    // aborts the change — the restriction fails closed.
    if (newPlan.nc_only && !(await isNcOrg(orgId))) { const e = new Error('nc_only_plan'); e.status = 403; throw e; }

    const quantity = newPlan.per_seat ? Math.max(1, await userStore.getActiveSeatCount(orgId)) : 1;
    const isUpgrade = newPrice > curPrice;

    if (isUpgrade) {
        // Re-upgrading cancels any pending downgrade cleanly before switching.
        if (sub.stripe_schedule_id) {
            await stripeService.releaseSubscriptionSchedule(sub.stripe_schedule_id);
        }
        let stripeSub;
        try {
            stripeSub = await stripeService.updateSubscriptionPlan({
                stripeSubscriptionId: sub.stripe_subscription_id,
                newPriceId: newPlan.stripe_price_id,
                quantity,
            });
        } catch (e) {
            const status = stripePaymentErrorStatus(e);
            if (status === 402) {
                await userStore.logSubscriptionAudit(
                    'upgrade_subscription_payment_failed', 'organization', orgId, adminId,
                    { plan_id: currentPlan.id },
                    { plan_id: newPlan.id, stripe_subscription_id: sub.stripe_subscription_id, error: String(e.message || e).slice(0, 500) }
                );
                const err = new Error('payment_required'); err.status = 402; throw err;
            }
            throw e;
        }

        // Optimistic local mirror — the customer.subscription.updated webhook
        // will re-confirm shortly. Clear any pending-downgrade bookkeeping.
        await userStore.setOrgSubscription(orgId, {
            plan_id: newPlan.id,
            status: 'active',
            payment_status: 'paid',
            stripe_seat_quantity: quantity,
            pending_plan_id: null,
            pending_plan_effective: null,
            stripe_schedule_id: null,
            ...(stripeSub.current_period_end
                ? { current_period_end: new Date(stripeSub.current_period_end * 1000).toISOString() }
                : {}),
        });

        try {
            await require('../../services/planEntitlements').applyPlanToOrg(orgId, newPlan.id, { mode: 'reset' });
        } catch (e) {
            log.warn('[Subscriptions] applyPlanToOrg (upgrade) failed:', e.message);
        }

        await userStore.logSubscriptionAudit(
            'upgrade_subscription', 'organization', orgId, adminId,
            { plan_id: currentPlan.id },
            { plan_id: newPlan.id, stripe_subscription_id: sub.stripe_subscription_id, quantity }
        );

        return userStore.getOrgSubscription(orgId);
    }

    // DOWNGRADE → schedule the switch at period end.
    const result = await stripeService.scheduleDowngradeAtPeriodEnd({
        stripeSubscriptionId: sub.stripe_subscription_id,
        newPriceId: newPlan.stripe_price_id,
        quantity,
    });
    await userStore.setOrgSubscription(orgId, {
        pending_plan_id: newPlan.id,
        pending_plan_effective: result.effective,
        stripe_schedule_id: result.scheduleId,
    });
    await userStore.logSubscriptionAudit(
        'downgrade_scheduled', 'organization', orgId, adminId,
        { plan_id: currentPlan.id },
        { pending_plan_id: newPlan.id, effective: result.effective, schedule_id: result.scheduleId, quantity }
    );
    return userStore.getOrgSubscription(orgId);
}

// Upgrade OR downgrade — the route name stays /upgrade for back-compat but
// the handler picks the right behaviour from the price delta.
router.post('/orgs/:orgId/upgrade', validate({ body: PlanChangeBody }), async (req, res) => {
    try {
        const { planId } = req.body;
        const result = await performOrgPlanChange(req.params.orgId, planId, getAdminId(req));
        res.json(result);
    } catch (e) {
        const status = e.status || 500;
        if (status === 500) log.error('[Subscriptions] orgs/:orgId/upgrade error:', e);
        const msg = lifecycleErrorMessages[e.message] || e.message;
        res.status(status).json({ error: e.message, message: msg });
    }
});

// Preview the cost impact of a plan change before the customer confirms.
// Upgrades return the prorated charge that will hit today; downgrades return
// the new recurring total and the date it takes effect (no charge now).
router.post('/orgs/:orgId/preview-change', validate({ body: PlanChangeBody }), async (req, res) => {
    try {
        const stripeService = require('../../services/stripeService');
        const { planId } = req.body;
        const orgId = req.params.orgId;
        const sub = await userStore.getOrgSubscription(orgId);
        if (!sub) return res.status(404).json({ error: 'No subscription found' });
        if (!sub.stripe_subscription_id) return res.status(404).json({ error: 'Subscription is not Stripe-managed' });
        const newPlan = await userStore.getPlan(planId);
        if (!newPlan || !newPlan.stripe_price_id) return res.status(400).json({ error: 'Plan not configured for payment' });
        const currentPlan = sub.plan_id ? await userStore.getPlan(sub.plan_id) : null;
        const newPrice = Number(newPlan.price) || 0;
        const curPrice = Number(currentPlan?.price) || 0;
        const quantity = newPlan.per_seat ? Math.max(1, await userStore.getActiveSeatCount(orgId)) : 1;
        const direction = newPrice > curPrice ? 'upgrade' : 'downgrade';
        const nextRenewalTotal = newPrice * quantity;
        const common = {
            direction,
            currency: (newPlan.currency || 'EUR').toUpperCase(),
            plan_name: newPlan.name,
            per_seat: !!newPlan.per_seat,
            seat_quantity: quantity,
            next_renewal_total: nextRenewalTotal,
        };
        if (direction === 'upgrade') {
            const preview = await stripeService.previewPlanChange({
                stripeSubscriptionId: sub.stripe_subscription_id,
                newPriceId: newPlan.stripe_price_id,
                quantity,
            });
            return res.json({ ...common, currency: preview.currency || common.currency, proration_amount: preview.proration_amount, effective: 'now' });
        }
        return res.json({ ...common, proration_amount: 0, effective: sub.current_period_end || null });
    } catch (e) {
        const status = stripePaymentErrorStatus(e) || 500;
        if (status === 500) log.error('[Subscriptions] orgs/:orgId/preview-change error:', e);
        res.status(status).json({ error: e.message });
    }
});

// Undo a scheduled (end-of-period) downgrade — releases the Stripe schedule
// and clears the local pending bookkeeping so the org stays on its plan.
router.post('/orgs/:orgId/cancel-downgrade', validate({ body: NoBody }), async (req, res) => {
    const stripeService = require('../../services/stripeService');
    const orgId = req.params.orgId;
    const sub = await userStore.getOrgSubscription(orgId);
    if (!sub) return res.status(404).json({ error: 'No subscription found' });
    if (!sub.pending_plan_id) return res.status(409).json({ error: 'no_pending_change', message: 'No scheduled change to cancel.' });
    if (sub.stripe_schedule_id) await stripeService.releaseSubscriptionSchedule(sub.stripe_schedule_id);
    await userStore.setOrgSubscription(orgId, { pending_plan_id: null, pending_plan_effective: null, stripe_schedule_id: null });
    await userStore.logSubscriptionAudit(
        'downgrade_cancelled', 'organization', orgId, getAdminId(req),
        { pending_plan_id: sub.pending_plan_id }, null
    );
    res.json(await userStore.getOrgSubscription(orgId));
});

router.post('/orgs/:orgId/cancel', validate({ body: NoBody }), async (req, res) => {
    const stripeService = require('../../services/stripeService');
    const orgId = req.params.orgId;
    const sub = await userStore.getOrgSubscription(orgId);
    if (!sub) return res.status(404).json({ error: 'No subscription found' });
    if (!sub.stripe_subscription_id) return res.status(404).json({ error: 'Subscription is not Stripe-managed' });
    if (sub.cancel_at_period_end) return res.status(409).json({ error: 'already_scheduled', message: 'Cancellation already scheduled.' });

    // A pending downgrade schedule must be released first, otherwise Stripe
    // refuses to cancel a schedule-governed subscription.
    if (sub.stripe_schedule_id) {
        await stripeService.releaseSubscriptionSchedule(sub.stripe_schedule_id);
        await userStore.setOrgSubscription(orgId, { pending_plan_id: null, pending_plan_effective: null, stripe_schedule_id: null });
    }

    const stripeSub = await stripeService.cancelSubscriptionAtPeriodEnd(sub.stripe_subscription_id);
    await userStore.setOrgSubscription(orgId, {
        cancel_at_period_end: true,
        cancel_at: stripeSub.cancel_at ? new Date(stripeSub.cancel_at * 1000).toISOString() : null,
        current_period_end: stripeSub.current_period_end ? new Date(stripeSub.current_period_end * 1000).toISOString() : null,
    });
    await userStore.logSubscriptionAudit(
        'cancel_subscription_scheduled', 'organization', orgId, getAdminId(req), null,
        { stripe_subscription_id: sub.stripe_subscription_id, cancel_at: stripeSub.cancel_at }
    );
    res.json(await userStore.getOrgSubscription(orgId));
});

router.post('/orgs/:orgId/reactivate', validate({ body: NoBody }), async (req, res) => {
    const stripeService = require('../../services/stripeService');
    const orgId = req.params.orgId;
    const sub = await userStore.getOrgSubscription(orgId);
    if (!sub) return res.status(404).json({ error: 'No subscription found' });
    if (!sub.stripe_subscription_id) return res.status(404).json({ error: 'Subscription is not Stripe-managed' });
    if (!sub.cancel_at_period_end) return res.status(409).json({ error: 'not_scheduled', message: 'Subscription is not scheduled to cancel.' });

    await stripeService.reactivateSubscription(sub.stripe_subscription_id);
    await userStore.setOrgSubscription(orgId, {
        cancel_at_period_end: false,
        cancel_at: null,
    });
    await userStore.logSubscriptionAudit(
        'cancel_subscription_undone', 'organization', orgId, getAdminId(req), null,
        { stripe_subscription_id: sub.stripe_subscription_id }
    );
    res.json(await userStore.getOrgSubscription(orgId));
});

// Consumer (individual) lifecycle — mirror of the org trio.

async function performConsumerUpgrade(userId, planId, actorId) {
    const stripeService = require('../../services/stripeService');
    const sub = await userStore.getConsumerSubscription(userId);
    if (!sub) { const e = new Error('No subscription found'); e.status = 404; throw e; }
    if (!sub.stripe_subscription_id) { const e = new Error('Subscription is not Stripe-managed'); e.status = 404; throw e; }
    const newPlan = await userStore.getPlan(planId);
    if (!newPlan) { const e = new Error('Plan not found'); e.status = 404; throw e; }
    if (!newPlan.stripe_price_id) { const e = new Error('Plan not configured for payment'); e.status = 400; throw e; }
    const currentPlan = sub.plan_id ? await userStore.getPlan(sub.plan_id) : null;
    if (!currentPlan) { const e = new Error('Current plan is not resolvable'); e.status = 409; throw e; }

    if (newPlan.id === currentPlan.id) { const e = new Error('same_plan'); e.status = 400; throw e; }
    const newPrice = Number(newPlan.price) || 0;
    const curPrice = Number(currentPlan.price) || 0;
    if (newPrice < curPrice) { const e = new Error('downgrade_not_supported'); e.status = 400; throw e; }
    if (newPrice === curPrice) { const e = new Error('no_price_change'); e.status = 400; throw e; }
    if (newPlan.billing_interval !== currentPlan.billing_interval) { const e = new Error('interval_mismatch'); e.status = 400; throw e; }
    if ((newPlan.plan_type || 'consumer') !== (currentPlan.plan_type || 'consumer')) { const e = new Error('wrong_plan_type'); e.status = 400; throw e; }

    let stripeSub;
    try {
        stripeSub = await stripeService.updateSubscriptionPlan({
            stripeSubscriptionId: sub.stripe_subscription_id,
            newPriceId: newPlan.stripe_price_id,
            quantity: 1,
        });
    } catch (e) {
        const status = stripePaymentErrorStatus(e);
        if (status === 402) {
            await userStore.logSubscriptionAudit(
                'upgrade_subscription_payment_failed', 'consumer', userId, actorId,
                { plan_id: currentPlan.id },
                { plan_id: newPlan.id, stripe_subscription_id: sub.stripe_subscription_id, error: String(e.message || e).slice(0, 500) }
            );
            const err = new Error('payment_required'); err.status = 402; throw err;
        }
        throw e;
    }

    await userStore.setConsumerSubscription(userId, {
        plan_id: newPlan.id,
        status: 'active',
        payment_status: 'paid',
        ...(stripeSub.current_period_end
            ? { current_period_end: new Date(stripeSub.current_period_end * 1000).toISOString() }
            : {}),
    });

    await userStore.logSubscriptionAudit(
        'upgrade_subscription', 'consumer', userId, actorId,
        { plan_id: currentPlan.id },
        { plan_id: newPlan.id, stripe_subscription_id: sub.stripe_subscription_id }
    );

    return userStore.getConsumerSubscription(userId);
}

router.post('/consumer/:userId/upgrade', validate({ body: PlanChangeBody }), async (req, res) => {
    try {
        const { planId } = req.body;
        const result = await performConsumerUpgrade(req.params.userId, planId, getAdminId(req));
        res.json(result);
    } catch (e) {
        const status = e.status || 500;
        if (status === 500) log.error('[Subscriptions] consumer/:userId/upgrade error:', e);
        const msg = lifecycleErrorMessages[e.message] || e.message;
        res.status(status).json({ error: e.message, message: msg });
    }
});

router.post('/consumer/:userId/cancel', validate({ body: NoBody }), async (req, res) => {
    const stripeService = require('../../services/stripeService');
    const userId = req.params.userId;
    const sub = await userStore.getConsumerSubscription(userId);
    if (!sub) return res.status(404).json({ error: 'No subscription found' });
    if (!sub.stripe_subscription_id) return res.status(404).json({ error: 'Subscription is not Stripe-managed' });
    if (sub.cancel_at_period_end) return res.status(409).json({ error: 'already_scheduled', message: 'Cancellation already scheduled.' });

    const stripeSub = await stripeService.cancelSubscriptionAtPeriodEnd(sub.stripe_subscription_id);
    await userStore.setConsumerSubscription(userId, {
        cancel_at_period_end: true,
        cancel_at: stripeSub.cancel_at ? new Date(stripeSub.cancel_at * 1000).toISOString() : null,
        current_period_end: stripeSub.current_period_end ? new Date(stripeSub.current_period_end * 1000).toISOString() : null,
    });
    await userStore.logSubscriptionAudit(
        'cancel_subscription_scheduled', 'consumer', userId, getAdminId(req), null,
        { stripe_subscription_id: sub.stripe_subscription_id, cancel_at: stripeSub.cancel_at }
    );
    res.json(await userStore.getConsumerSubscription(userId));
});

router.post('/consumer/:userId/reactivate', validate({ body: NoBody }), async (req, res) => {
    const stripeService = require('../../services/stripeService');
    const userId = req.params.userId;
    const sub = await userStore.getConsumerSubscription(userId);
    if (!sub) return res.status(404).json({ error: 'No subscription found' });
    if (!sub.stripe_subscription_id) return res.status(404).json({ error: 'Subscription is not Stripe-managed' });
    if (!sub.cancel_at_period_end) return res.status(409).json({ error: 'not_scheduled', message: 'Subscription is not scheduled to cancel.' });

    await stripeService.reactivateSubscription(sub.stripe_subscription_id);
    await userStore.setConsumerSubscription(userId, {
        cancel_at_period_end: false,
        cancel_at: null,
    });
    await userStore.logSubscriptionAudit(
        'cancel_subscription_undone', 'consumer', userId, getAdminId(req), null,
        { stripe_subscription_id: sub.stripe_subscription_id }
    );
    res.json(await userStore.getConsumerSubscription(userId));
});

module.exports = router;
