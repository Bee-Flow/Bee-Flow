// @typecheck noImplicitAny
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
    const secret = await deps.configStore.getSecret('stripe_webhook_secret');
    if (!secret) throw new Error('Webhook signing secret not configured');
    return stripe.webhooks.constructEvent(rawBody, signature, secret);
}

module.exports = {
    constructWebhookEvent,
};
