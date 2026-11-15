// @typecheck strict
/**
 * The duplicate-subscription guard of POST /api/stripe/checkout: what Stripe
 * says about the subscriber's customers decides whether a new checkout may be
 * created. Answers `null` to proceed, or the status and body to refuse with.
 */

const stripeService = require('../../services/stripeService');
const log = require('../../telemetry/log');

// Guard against a SECOND checkout for a subscriber Stripe still considers
// subscribed. Checkout in `mode: 'subscription'` always mints a NEW
// subscription on the customer; `handleCheckoutCompleted` then overwrites the
// single local `stripe_subscription_id` with it. The previous subscription is
// neither cancelled nor recorded anywhere, so the customer is billed twice
// while the product knows about one, the orphan is invisible in the app, and no
// code path can ever cancel it — and the local row flaps between the two as
// both subscriptions' webhooks arrive.
//
// The question is asked of STRIPE, not of the local row: the local mirror going
// stale (a second tab, a second admin, a webhook still in flight) is exactly
// the situation this must catch. Changing plans on a live subscription has its
// own route — POST /api/subscriptions/orgs/:orgId/upgrade — plus the Customer
// Portal; neither creates a duplicate.
/**
 * @param {string | null | undefined} stripeCustomerId
 * @param {{ scope: string, targetId: string }} opts
 * @returns {Promise<null | { status: number, body: Record<string, string> }>} null = proceed
 */
async function blockIfAlreadySubscribed(stripeCustomerId, { scope, targetId }) {
    if (!stripeCustomerId) return null;   // no customer yet ⇒ nothing to duplicate
    let live;
    try {
        live = await stripeService.listLiveSubscriptions(stripeCustomerId);
    } catch (e) {
        // Fail CLOSED, for the same reason the allowed-plans lookup of the
        // checkout route does: undoing a duplicate subscription costs far more
        // than a retry does.
        log.error(`[Stripe] live-subscription check failed scope=${scope} target=${targetId} customer=${stripeCustomerId}:`, e.message);
        return {
            status: 503,
            body: {
                error: 'subscription_state_unavailable',
                message: 'Could not verify your current subscription right now. Please try again in a moment.',
            },
        };
    }
    if (live.length === 0) return null;
    log.warn(`[Stripe] duplicate checkout refused scope=${scope} target=${targetId} live=${live.map(s => `${s.id}:${s.status}`).join(',')}`);
    return {
        status: 409,
        body: {
            error: 'already_subscribed',
            message: 'This account already has an active subscription. Change your plan from the subscription panel, or manage it in the billing portal.',
            subscription_status: live[0].status,
        },
    };
}

/**
 * The Stripe customers a new checkout of the organisation could mint a second
 * subscription on; the first is the one the checkout reuses. Normally that is
 * the customer on the subscription row, stored when a checkout starts. Two
 * kinds of organisation have none there while Stripe may already bill them:
 * one WITHOUT a row (a started checkout is not a subscription and stores
 * nothing for it), and one whose row was created by a subscription event,
 * which carries no customer, before the checkout event that brings it. Both
 * are a first checkout that was paid while its webhooks are still on their
 * way, so their customers are asked of Stripe. A row that holds neither a
 * customer nor a subscription never reached Stripe: nothing to ask.
 * @param {string} orgId
 * @param {{ stripe_customer_id?: string | null, stripe_subscription_id?: string | null } | null | undefined} existingSub
 * @returns {Promise<string[]>}
 */
async function orgCheckoutCustomers(orgId, existingSub) {
    if (existingSub?.stripe_customer_id) return [existingSub.stripe_customer_id];
    if (existingSub && !existingSub.stripe_subscription_id) return [];
    return stripeService.findOrgCustomerIds(orgId);
}

/**
 * The guard above over each of the customers; the first refusal decides.
 * @param {string[]} customerIds
 * @param {{ scope: string, targetId: string }} opts
 */
async function blockIfAnyAlreadySubscribed(customerIds, opts) {
    for (const customerId of customerIds) {
        const blocked = await blockIfAlreadySubscribed(customerId, opts);
        if (blocked) return blocked;
    }
    return null;
}

module.exports = { blockIfAlreadySubscribed, orgCheckoutCustomers, blockIfAnyAlreadySubscribed };
