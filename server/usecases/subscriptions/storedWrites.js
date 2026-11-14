// @typecheck strict
'use strict';

/**
 * Local writes that FOLLOW a Stripe call which already succeeded. When the
 * database refuses one, Stripe and the local row disagree. Answering success
 * would hide that, so both helpers log what is needed to reconcile (ids only)
 * and throw an error that tells the admin to run the action again: every
 * caller's Stripe call is safe to repeat (an update to the same price or flag,
 * a schedule that is reused, a release that tolerates a released schedule).
 */

const userStore = require('../../stores/userStore');
const log = require('../../telemetry/log');
const { HttpError } = require('../../core/http/errors');

const RETRY_TEXT = 'The change was made at the payment provider but could not be saved here. Please try again.';

/**
 * @param {unknown} result  what setOrgSubscription / setConsumerSubscription answered
 * @param {string} action  the lifecycle action, e.g. 'upgrade'
 * @param {string} subscriber  `organization <id>` or `consumer <id>`
 * @param {string | null | undefined} stripeSubscriptionId
 */
function storedAfterStripe(result, action, subscriber, stripeSubscriptionId) {
    if (result !== false) return;
    log.error(`[Subscriptions] stripe.local_write_failed action=${action} subscriber=${subscriber} stripe_subscription_id=${stripeSubscriptionId || 'none'}: Stripe holds the change, the local row does not`);
    throw new HttpError(503, 'subscription_not_stored', RETRY_TEXT);
}

/**
 * Store the Stripe ids a plan sync returned. The sync has already archived the
 * plan's previous price, so ids that are not stored leave the plan pointing at
 * a price nobody can buy.
 * @param {string} planId
 * @param {{ stripe_product_id: string, stripe_price_id: string, stripe_meter_id?: string, stripe_meter_event_name?: string }} updates
 */
async function storePlanStripeIds(planId, updates) {
    if (await userStore.updatePlan(planId, updates) !== false) return;
    log.error(`[Subscriptions] stripe.plan_ids_not_stored plan=${planId} stripe_product_id=${updates.stripe_product_id} stripe_price_id=${updates.stripe_price_id}: Stripe holds the product and price, the plan does not`);
    throw new HttpError(503, 'plan_stripe_ids_not_stored', 'The plan was synced to Stripe, but its Stripe ids could not be saved. Run "Sync to Stripe" on the plan again.');
}

module.exports = { storedAfterStripe, storePlanStripeIds };
