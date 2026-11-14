// @typecheck strict
/**
 * Webhook signature verification.
 */

const deps = require('./deps');
const { getClient } = require('./client');

/**
 * Construct and verify a Stripe webhook event.
 *
 * @param {Buffer} rawBody - Raw request body
 * @param {string} signature - Stripe-Signature header
 * @returns {Promise<object>} Verified Stripe event
 */
async function constructWebhookEvent(rawBody, signature) {
    const stripe = await getClient();
    // stripeService fills deps in when it loads, before any webhook arrives.
    const secret = await /** @type {NonNullable<typeof deps.configStore>} */ (deps.configStore).getSecret('stripe_webhook_secret');
    if (!secret) throw new Error('Webhook signing secret not configured');
    return stripe.webhooks.constructEvent(rawBody, signature, secret);
}

module.exports = {
    constructWebhookEvent,
};
