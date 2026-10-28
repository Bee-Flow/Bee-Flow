// @typecheck
/**
 * Live subscriptions: the duplicate-subscription probe, per-seat quantity
 * sync, plan switch (now or at period end), preview, cancel and reactivate.
 */

const log = require('../../telemetry/log');
const { getClient, isEnabled } = require('./client');
const deps = require('./deps');

// Subscription statuses that mean "this customer is still on the hook for
// money". A second Checkout for a customer already in one of these states
// creates a SECOND concurrent subscription on the same card while the product
// only ever tracks one — the older one is orphaned and no code path can ever
// cancel it. `incomplete` / `incomplete_expired` are deliberately excluded:
// they are abandoned or SCA-failed checkouts that Stripe expires by itself,
// and treating them as live would lock an admin out of retrying for 23 hours.
const LIVE_SUBSCRIPTION_STATUSES = Object.freeze(['active', 'trialing', 'past_due', 'unpaid', 'paused']);

/**
 * Subscriptions on a customer that are still billing (see
 * LIVE_SUBSCRIPTION_STATUSES). Returns [] when there is no customer yet.
 * Used by the checkout route to refuse a duplicate subscription before Stripe
 * mints one — asking Stripe rather than trusting the local row is the point:
 * the local mirror is exactly what goes stale in the double-checkout race.
 * @param {string|null} customerId
 * @returns {Promise<Array<{id: string, status: string}>>}
 */
async function listLiveSubscriptions(customerId) {
    if (!customerId) return [];
    const stripe = await getClient();
    const res = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
    return (res?.data || [])
        .filter(s => LIVE_SUBSCRIPTION_STATUSES.includes(s.status))
        .map(s => ({ id: s.id, status: s.status }));
}

/**
 * For per-seat plans, push the org's current active seat count to Stripe so
 * the next invoice bills the right number of seats. Best-effort and silent:
 * if Stripe is disabled, the plan isn't per-seat, or no subscription exists,
 * this is a no-op. The subscription.updated webhook will echo the new
 * quantity back into stripe_seat_quantity on the local row.
 *
 * Call this after any local action that changes the user count (invite,
 * delete, suspend, NC group sync). Don't await it inside the user-creation
 * transaction — kick it off after commit so a Stripe outage can never block
 * a user being created.
 */
async function syncSeatQuantityForOrg(orgId) {
    if (!orgId) return;
    if (!(await isEnabled())) return;
    const userStore = deps.userStore();
    const sub = await userStore.getOrgSubscription(orgId);
    if (!sub?.stripe_subscription_id) return;
    const plan = sub.plan_id ? await userStore.getPlan(sub.plan_id) : null;
    if (!plan?.per_seat) return;

    const stripe = await getClient();
    const quantity = Math.max(1, await userStore.getActiveSeatCount(orgId));

    try {
        const stripeSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
        const item = stripeSub.items?.data?.[0];
        if (!item) {
            log.warn(`[Stripe] syncSeatQuantityForOrg org=${orgId} sub has no items`);
            return;
        }
        if (item.quantity === quantity) return; // already in sync
        await stripe.subscriptions.update(sub.stripe_subscription_id, {
            items: [{ id: item.id, quantity }],
            proration_behavior: 'create_prorations',
        });
        log.info(`[Stripe] seat quantity sync org=${orgId} ${item.quantity} → ${quantity}`);
    } catch (e) {
        log.warn(`[Stripe] syncSeatQuantityForOrg org=${orgId} failed: ${/** @type {Error} */ (e).message}`);
    }
}

/**
 * Switch a subscription to a new price in-place. Used by the upgrade flow —
 * does NOT create a new checkout session. Pro-rates with `always_invoice` so
 * the customer is charged the partial-period difference immediately. The
 * existing billing_cycle_anchor is preserved so the next renewal lands on
 * the same day of month. `payment_behavior: error_if_incomplete` makes
 * Stripe reject the update outright if the proration invoice can't be
 * collected — better a clean 402 than a half-applied plan change.
 */
async function updateSubscriptionPlan({ stripeSubscriptionId, newPriceId, quantity = 1 }) {
    const stripe = await getClient();
    const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId);
    const item = sub.items?.data?.[0];
    if (!item) throw new Error(`Stripe subscription ${stripeSubscriptionId} has no items`);
    return stripe.subscriptions.update(stripeSubscriptionId, {
        items: [{ id: item.id, price: newPriceId, quantity: Math.max(1, quantity) }],
        proration_behavior: 'always_invoice',
        billing_cycle_anchor: 'unchanged',
        payment_behavior: 'error_if_incomplete',
    });
}

/**
 * Schedule the subscription to cancel at the end of the current period.
 * Status stays 'active' (or 'trialing') until cancel_at; the
 * customer.subscription.updated webhook mirrors the flag locally.
 */
async function cancelSubscriptionAtPeriodEnd(stripeSubscriptionId) {
    const stripe = await getClient();
    return stripe.subscriptions.update(stripeSubscriptionId, { cancel_at_period_end: true });
}

/**
 * Undo a scheduled cancel. Only valid while the subscription is still
 * 'active' / 'trialing' and the period hasn't elapsed.
 */
async function reactivateSubscription(stripeSubscriptionId) {
    const stripe = await getClient();
    return stripe.subscriptions.update(stripeSubscriptionId, { cancel_at_period_end: false });
}

/**
 * Preview the cost impact of switching a subscription to a new price *now*.
 * Drives the in-app change-plan modal so the customer sees the prorated
 * charge before confirming. Returns the net proration (new-plan charge minus
 * unused-time credit for the old plan) in MAJOR currency units. Non-proration
 * lines (next period's base fee) are excluded so the figure reflects only
 * "what you pay today". Stripe SDK v22 → invoices.createPreview.
 */
async function previewPlanChange({ stripeSubscriptionId, newPriceId, quantity = 1 }) {
    const stripe = await getClient();
    const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId);
    const item = sub.items?.data?.[0];
    if (!item) throw new Error(`Stripe subscription ${stripeSubscriptionId} has no items`);
    const preview = await stripe.invoices.createPreview({
        subscription: stripeSubscriptionId,
        subscription_details: {
            items: [{ id: item.id, price: newPriceId, quantity: Math.max(1, quantity) }],
            proration_behavior: 'always_invoice',
        },
    });
    const prorationCents = (preview.lines?.data || [])
        .filter(l => l.proration)
        .reduce((sum, l) => sum + (l.amount || 0), 0);
    return {
        proration_amount: prorationCents / 100,
        currency: (preview.currency || item.price?.currency || 'eur').toUpperCase(),
    };
}

/**
 * Schedule a plan switch to take effect at the END of the current billing
 * period (used for downgrades — no mid-cycle refund/credit). Creates a Stripe
 * Subscription Schedule from the live subscription, keeps the current price as
 * phase 1 until period end, then starts the new price as phase 2.
 * end_behavior:'release' hands control back to a plain subscription once
 * phase 2 begins. Returns { scheduleId, effective }.
 */
async function scheduleDowngradeAtPeriodEnd({ stripeSubscriptionId, newPriceId, quantity = 1 }) {
    const stripe = await getClient();
    const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId);
    const item = sub.items?.data?.[0];
    if (!item) throw new Error(`Stripe subscription ${stripeSubscriptionId} has no items`);
    const qty = Math.max(1, quantity);

    // Reuse any schedule already governing this subscription; else create one.
    let scheduleId = sub.schedule;
    if (!scheduleId) {
        const created = await stripe.subscriptionSchedules.create({ from_subscription: stripeSubscriptionId });
        scheduleId = created.id;
    }
    const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId);
    const currentPhase = schedule.phases?.[0];
    if (!currentPhase) throw new Error(`Schedule ${scheduleId} has no current phase`);
    const curItem = currentPhase.items?.[0] || {};
    const updated = await stripe.subscriptionSchedules.update(scheduleId, {
        end_behavior: 'release',
        phases: [
            {
                items: [{ price: curItem.price, quantity: curItem.quantity || qty }],
                start_date: currentPhase.start_date,
                end_date: currentPhase.end_date,
                proration_behavior: 'none',
            },
            {
                items: [{ price: newPriceId, quantity: qty }],
                proration_behavior: 'none',
            },
        ],
    });
    const effective = updated.phases?.[1]?.start_date || currentPhase.end_date || null;
    return { scheduleId, effective: effective ? new Date(effective * 1000).toISOString() : null };
}

/**
 * Release a subscription schedule (undo a pending downgrade), returning the
 * subscription to a normal month-to-month state at its current price.
 * Idempotent: a missing/already-released schedule is a no-op.
 */
async function releaseSubscriptionSchedule(scheduleId) {
    if (!scheduleId) return null;
    const stripe = await getClient();
    try {
        return await stripe.subscriptionSchedules.release(scheduleId);
    } catch (e) {
        log.warn(`[Stripe] releaseSubscriptionSchedule ${scheduleId} failed: ${/** @type {Error} */ (e).message}`);
        return null;
    }
}

module.exports = {
    LIVE_SUBSCRIPTION_STATUSES,
    listLiveSubscriptions,
    syncSeatQuantityForOrg,
    updateSubscriptionPlan,
    cancelSubscriptionAtPeriodEnd,
    reactivateSubscription,
    previewPlanChange,
    scheduleDowngradeAtPeriodEnd,
    releaseSubscriptionSchedule,
};
