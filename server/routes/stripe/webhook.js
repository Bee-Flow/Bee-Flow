/**
 * POST /webhook — signature verification, the idempotency ledger, and the
 * event-type routing table that hands each Stripe event to its handler module.
 *
 * NO zod schema, and there cannot be one: the body arrives as the RAW Buffer
 * that `express.raw()` hands over, because Stripe's signature is computed over
 * the exact bytes. Parsing or reshaping it before
 * `stripeService.constructWebhookEvent` would break verification. The event
 * shape is Stripe's, and the signature — not a schema — is what says it is
 * genuine.
 */

const express = require('express');
const stripeService = require('../../services/stripeService');
const userStore = require('../../stores/userStore');
const { handleCheckoutCompleted } = require('./checkoutEvents');
const {
    handleSubscriptionUpdated,
    handleSubscriptionDeleted,
    handleTrialWillEnd,
    _notifyAdminNewSubscriptionOnce,
} = require('./subscriptionEvents');
const {
    handleInvoicePaid,
    handleInvoicePaymentFailed,
    handleChargeRefunded,
    handleChargeDisputeCreated,
} = require('./paymentEvents');
const {
    handleCustomerDeleted,
    handleCustomerTaxIdChange,
    handleCustomerUpdated,
    handleSetupIntentFailed,
    handleSetupIntentSucceeded,
} = require('./customerEvents');
const log = require('../../telemetry/log');

const router = express.Router();

// ── POST /webhook — Handle Stripe Webhook Events ─────────────────────────────
// NOTE: This route needs raw body — handled by mounting express.raw() in index.js

router.post('/webhook', async (req, res) => {
    const signature = req.headers['stripe-signature'];
    if (!signature) return res.status(400).send('Missing stripe-signature header');

    let event;
    try {
        event = await stripeService.constructWebhookEvent(req.body, signature);
    } catch (err) {
        log.error('[Stripe Webhook] Signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Idempotency: Stripe retries on 5xx/timeout, so we record event.id and
    // skip duplicates. Insert wins → first delivery, conflict → already
    // processed. Fails CLOSED: if the ledger is unreachable we cannot tell a
    // first delivery from a replay, and a 500 gets the event redelivered rather
    // than double-applied.
    let firstTime;
    try {
        firstTime = await userStore.recordStripeEventProcessed(event.id, event.type);
    } catch (err) {
        log.error(`[Stripe Webhook] idempotency ledger unavailable event_id=${event.id}:`, err.message);
        return res.status(500).json({ error: 'ledger_unavailable' });
    }
    if (!firstTime) {
        log.info(`[Stripe Webhook] stripe.webhook.duplicate event_id=${event.id} type=${event.type}`);
        return res.json({ received: true, duplicate: true });
    }

    log.info(`[Stripe Webhook] event_id=${event.id} type=${event.type}`);

    try {
        switch (event.type) {
            case 'checkout.session.completed':
                await handleCheckoutCompleted(event.data.object);
                break;

            // Admin-initiated trials (stripeService.createTrialSubscription) and
            // Stripe-dashboard/API direct creates emit `created`, not `updated`.
            // Route through the same handler so the local row reconciles.
            case 'customer.subscription.created':
                await handleSubscriptionUpdated(event.data.object);
                // Notify the configured admin address that a new subscription
                // started — only on `created`, and idempotently per subscription.
                await _notifyAdminNewSubscriptionOnce(event.data.object);
                break;
            case 'customer.subscription.updated':
                await handleSubscriptionUpdated(event.data.object);
                break;

            case 'customer.subscription.deleted':
                await handleSubscriptionDeleted(event.data.object);
                break;

            case 'customer.subscription.trial_will_end':
                await handleTrialWillEnd(event.data.object);
                break;

            case 'invoice.paid':
                await handleInvoicePaid(event.data.object);
                break;

            case 'invoice.payment_failed':
                await handleInvoicePaymentFailed(event.data.object);
                break;

            case 'charge.refunded':
                await handleChargeRefunded(event.data.object);
                break;

            case 'charge.dispute.created':
                await handleChargeDisputeCreated(event.data.object);
                break;

            case 'customer.deleted':
                await handleCustomerDeleted(event.data.object);
                break;

            // Customer VAT/tax ID changes — keep `organizations.vat` in sync
            // with whatever the customer has in Stripe Tax. The org admin
            // can edit VAT via the Stripe Customer Portal; without this
            // handler the local row drifts and the EU reverse-charge logic
            // in createCheckoutSession would re-attach the stale value.
            case 'customer.tax_id.created':
            case 'customer.tax_id.updated':
            case 'customer.tax_id.deleted':
                await handleCustomerTaxIdChange(event.data.object, event.type);
                break;
            case 'customer.updated':
                await handleCustomerUpdated(event.data.object);
                break;

            // Payment-method save attempts from the Customer Portal. Stripe
            // emits these when a user clicks "Add card" outside of a
            // checkout. Without handlers, a declined card on save shows the
            // user a success page but the next invoice fails. Audit both;
            // email only on failure (claimNotification dedupes replays).
            case 'setup_intent.setup_failed':
                await handleSetupIntentFailed(event.data.object);
                break;
            case 'setup_intent.succeeded':
                await handleSetupIntentSucceeded(event.data.object);
                break;

            default:
                log.info(`[Stripe Webhook] stripe.webhook.unhandled type=${event.type} event_id=${event.id}`);
        }
    } catch (err) {
        // Hand the event back for redelivery rather than acknowledging work we
        // did not do. Stripe backs off over ~3 days, which is ample for a
        // transient database or Stripe-API failure. The ledger claim is released
        // first — otherwise the retry would be skipped as a duplicate and the
        // subscription change would be lost for good.
        log.error(`[Stripe Webhook] Error handling ${event.type} (${event.id}):`, err);
        try {
            await userStore.releaseStripeEventProcessed(event.id);
        } catch (releaseErr) {
            log.error(`[Stripe Webhook] could not release ledger row ${event.id} — the retry will replay-skip:`, releaseErr.message);
        }
        return res.status(500).json({ error: 'handler_failed', event_id: event.id });
    }

    res.json({ received: true });
});

module.exports = router;
