/**
 * The decisions of customer.subscription.updated (handleSubscriptionUpdated in
 * ./subscriptionEvents.js), without side effects: the local status and payment
 * status of a Stripe status, the fields of the local subscription row that
 * mirror the Stripe subscription, and the local plan a Stripe price belongs to.
 */

export type StripePrice = {
    id?: string;
    product?: string;
    recurring?: { interval?: string } | null;
};

/** The fields of a webhook subscription read here. */
export type StripeSubscriptionFields = {
    id: string;
    status: string;
    items?: { data?: Array<{ quantity?: number }> };
    current_period_start?: number;
    current_period_end?: number | null;
    billing_cycle_anchor?: number;
    trial_end?: number | null;
    cancel_at_period_end?: boolean;
    cancel_at?: number | null;
};

export type PlanRow = {
    id: string;
    stripe_price_id?: string | null;
    stripe_product_id?: string | null;
    billing_interval?: string | null;
};

/** The payload of the local row write; a field left out is not written. */
export type MirroredFields = {
    status: string;
    payment_status: string;
    stripe_subscription_id: string;
    stripe_seat_quantity?: number;
    billing_cycle_start?: string;
    plan_id?: string;
    trial_end_date?: string;
    cancel_at_period_end?: boolean;
    cancel_at?: string | null;
    current_period_end?: string | null;
};

// A customer behind on payments stays past_due (not active), so dunning and
// the suspension sweep can act on it.
const STATUS: Record<string, string> = {
    active: 'active',
    past_due: 'past_due',
    trialing: 'trialing',
    paused: 'paused',
    incomplete: 'incomplete',
    incomplete_expired: 'cancelled',
    canceled: 'cancelled',
    unpaid: 'suspended',
};

const PAYMENT_STATUS: Record<string, string> = {
    active: 'paid',
    past_due: 'past_due',
    trialing: 'trialing',
    paused: 'paused',
    incomplete: 'pending',
    incomplete_expired: 'failed',
    canceled: 'cancelled',
    unpaid: 'failed',
};

/** The Stripe statuses a subscription never leaves. */
const ENDED_FOR_GOOD: ReadonlySet<string> = new Set(['canceled', 'incomplete_expired']);

/**
 * Whether an event reports the end of ANOTHER Stripe subscription than the one
 * the local row holds: `deleted` (customer.subscription.deleted), or a status
 * Stripe never leaves. Stripe does not order its events and redelivers a
 * failed one for days, so the end of an earlier subscription (an abandoned
 * checkout expiring after 23 hours, a cancelled one) can arrive after the
 * checkout of its successor, and it says nothing about that one.
 * A row without a Stripe subscription takes every event, and another
 * subscription that is still live is adopted as before (one created in the
 * Stripe dashboard, or one whose checkout event is still on its way).
 */
export function endOfAnotherSubscription(
    row: { stripe_subscription_id?: string | null } | null | undefined,
    subscription: { id: string; status?: string },
    deleted = false,
): boolean {
    const held = row?.stripe_subscription_id;
    if (!held || held === subscription.id) return false;
    return deleted || ENDED_FOR_GOOD.has(subscription.status || '');
}

/**
 * Whether the snapshot is older than the row. Stripe creates a subscription
 * as `incomplete` and it never returns to that status, so `incomplete` for a
 * subscription the row already holds as active is its first event arriving
 * after its activation: created and updated are sent together at a checkout,
 * and a delivery that failed is retried hours later. Written, it would make a
 * paying subscriber `incomplete`, which the stale-incomplete sweep cancels.
 */
export function returnsToIncomplete(
    row: { stripe_subscription_id?: string | null; status?: string | null } | null | undefined,
    subscription: { id: string; status?: string },
): boolean {
    return subscription.status === 'incomplete' && row?.stripe_subscription_id === subscription.id && row.status === 'active';
}

const isoFromUnix = (seconds: number): string => new Date(seconds * 1000).toISOString();
const isoOrNull = (seconds: number | null | undefined): string | null => (seconds ? isoFromUnix(seconds) : null);

/**
 * The row fields that mirror the subscription. `planId` is the matched local
 * plan; without one the row keeps its plan (the write skips absent fields).
 */
export function mirroredFields(subscription: StripeSubscriptionFields, planId: string | undefined): MirroredFields {
    const fields: MirroredFields = {
        status: STATUS[subscription.status] || 'active',
        payment_status: PAYMENT_STATUS[subscription.status] || subscription.status,
        stripe_subscription_id: subscription.id,
    };

    // The billed seat quantity, so per-seat caps multiply by what the customer
    // pays for. A consumer subscription always bills one.
    const billedQuantity = subscription.items?.data?.[0]?.quantity;
    if (typeof billedQuantity === 'number' && billedQuantity > 0) fields.stripe_seat_quantity = billedQuantity;

    // The usage window (getBillingPeriod in userStore) starts on the date the
    // customer is invoiced from: the current period, or the anchor of a
    // subscription whose first period has not advanced yet.
    const periodStart = subscription.current_period_start || subscription.billing_cycle_anchor || null;
    if (periodStart) fields.billing_cycle_start = isoFromUnix(periodStart);

    if (planId) fields.plan_id = planId;
    if (subscription.trial_end) fields.trial_end_date = isoFromUnix(subscription.trial_end);

    // Informational, for the "cancels on ..." banner; the cancellation itself
    // arrives as customer.subscription.deleted.
    fields.cancel_at_period_end = !!subscription.cancel_at_period_end;
    fields.cancel_at = isoOrNull(subscription.cancel_at);
    fields.current_period_end = isoOrNull(subscription.current_period_end);
    return fields;
}

/**
 * The local plan of a Stripe price: the plan with that exact price id, else
 * the one plan that sells the same product at the same interval (a price an
 * administrator re-created). Several such plans are no answer: guessing would
 * bill the wrong plan. `viaProduct` tells the caller the fallback decided.
 */
/** Stripe's recurring interval in a plan's own vocabulary (services/stripe/planSync.js maps the other way). */
const PLAN_INTERVAL: Readonly<Record<string, string>> = Object.freeze({ month: 'monthly', year: 'yearly' });

export function matchPlan(plans: PlanRow[], price: StripePrice): { plan: PlanRow; viaProduct: boolean } | null {
    const exact = plans.find((p) => p.stripe_price_id === price.id);
    if (exact) return { plan: exact, viaProduct: false };
    if (!price.product) return null;
    const stripeInterval = price.recurring?.interval || null;
    const interval = stripeInterval ? (PLAN_INTERVAL[stripeInterval] ?? stripeInterval) : null;
    const sameProduct = plans.filter((p) => p.stripe_product_id === price.product && (!interval || (p.billing_interval || 'monthly') === interval));
    return sameProduct.length === 1 ? { plan: sameProduct[0], viaProduct: true } : null;
}
