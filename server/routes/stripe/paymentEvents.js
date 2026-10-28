/**
 * Money-movement webhooks: refunds, disputes, invoice.paid and
 * invoice.payment_failed — including the dunning cap and the two idempotent
 * dunning emails it drives.
 */

const stripeService = require('../../services/stripeService');
const userStore = require('../../stores/userStore');
const { findSubscriptionTargetBySubId, findSubscriptionTargetByCustomerId, stripOverriddenFields } = require('./webhookShared');
const appPaths = require('../../utils/appPaths');
const log = require('../../telemetry/log');
const { bestEffort, fallback } = require('../../utils/bestEffort');

/**
 * charge.refunded — flip the subscription's payment_status to 'refunded'.
 * Match by stripe_subscription_id on the charge's invoice → subscription
 * link, falling back to stripe_customer_id.
 */
async function handleChargeRefunded(charge) {
    const subId = charge.invoice ? null : charge.subscription || null;
    // charge.invoice is the typical path; resolve via stripe_subscription_id
    // on the invoice. If we have no link, fall back to the customer.
    let target = null;
    if (subId) {
        target = await findSubscriptionTargetBySubId(subId);
    }
    if (!target && charge.customer) {
        target = await userStore.findSubscriptionByStripeCustomerId(charge.customer);
    }
    if (!target) {
        log.warn(`[Stripe Webhook] charge.refunded could not locate subscription charge_id=${charge.id}`);
        return;
    }
    const payload = { payment_status: 'refunded' };
    if (target.scope === 'organization') {
        await userStore.setOrgSubscription(target.id, payload);
        await userStore.logSubscriptionAudit('refund_processed', 'organization', target.id, 'stripe_webhook', null, { charge_id: charge.id, amount_refunded: charge.amount_refunded });
        log.info(`[Stripe Webhook] stripe.refund.processed scope=org org=${target.id} amount=${charge.amount_refunded}`);
    } else {
        await userStore.setConsumerSubscription(target.id, payload);
        await userStore.logSubscriptionAudit('refund_processed', 'consumer', target.id, 'stripe_webhook', null, { charge_id: charge.id, amount_refunded: charge.amount_refunded });
        log.info(`[Stripe Webhook] stripe.refund.processed scope=consumer user=${target.id} amount=${charge.amount_refunded}`);
    }
}

/**
 * charge.dispute.created — a chargeback was opened. Suspend the subscription
 * defensively; restoration requires manual intervention after the dispute
 * resolves.
 */
async function handleChargeDisputeCreated(dispute) {
    let target = null;
    if (dispute.charge) {
        try {
            const stripe = await stripeService.getClient();
            const charge = await stripe.charges.retrieve(dispute.charge);
            if (charge.customer) {
                target = await userStore.findSubscriptionByStripeCustomerId(charge.customer);
            }
        } catch (e) {
            log.warn('[Stripe Webhook] dispute charge retrieve failed:', /** @type {Error} */ (e).message);
        }
    }
    if (!target && dispute.customer) {
        target = await userStore.findSubscriptionByStripeCustomerId(dispute.customer);
    }
    if (!target) {
        log.warn(`[Stripe Webhook] charge.dispute.created could not locate subscription dispute_id=${dispute.id}`);
        return;
    }
    const payload = { status: 'suspended', payment_status: 'disputed' };
    if (target.scope === 'organization') {
        await userStore.setOrgSubscription(target.id, payload);
        await userStore.logSubscriptionAudit('dispute_opened', 'organization', target.id, 'stripe_webhook', null, { dispute_id: dispute.id, reason: dispute.reason, amount: dispute.amount });
        log.info(`[Stripe Webhook] stripe.dispute.opened scope=org org=${target.id} dispute_id=${dispute.id} reason=${dispute.reason}`);
    } else {
        await userStore.setConsumerSubscription(target.id, payload);
        await userStore.logSubscriptionAudit('dispute_opened', 'consumer', target.id, 'stripe_webhook', null, { dispute_id: dispute.id, reason: dispute.reason, amount: dispute.amount });
        log.info(`[Stripe Webhook] stripe.dispute.opened scope=consumer user=${target.id} dispute_id=${dispute.id} reason=${dispute.reason}`);
    }
}

/**
 * invoice.paid — Payment succeeded. Resets the dunning counter so a
 * subsequent failure starts fresh, and flips back to active/paid.
 *
 * `status` and `payment_status` are admin-controlled columns: while a manual
 * override is live the webhook must not touch them (see `stripOverriddenFields`
 * and `handleSubscriptionUpdated`, which take the same route for the same
 * fields). This handler used to write them through the plain
 * `setOrgSubscription`, so an org an operator had suspended under an override —
 * abuse or chargeback investigation, Stripe subscription deliberately left
 * live — was flipped back to `active` by the next renewal invoice and regained
 * full paid AI access with the override row still visibly in place.
 *
 * The stripped payload is empty (both fields are admin-controlled), so under an
 * active override the override-aware writer performs no write at all. The
 * dunning counter is Stripe-side bookkeeping rather than an admin-controlled
 * field, so it is reset either way — otherwise a stale failure count would
 * outlive the override and shorten the next grace window.
 */
async function handleInvoicePaid(invoice) {
    const subId = invoice.subscription;
    if (!subId) return;
    const target = await findSubscriptionTargetBySubId(subId);
    if (!target) {
        // Stripe does not order events: for a new subscription invoice.paid can
        // beat checkout.session.completed / customer.subscription.created, so no
        // local row carries this subscription id yet. The event is recorded in
        // the idempotency ledger and never redelivered, so the confirmation must
        // go out now. Status and payment_status are left to the events that
        // create the row.
        if (invoice.billing_reason === 'subscription_create' && Number(invoice.amount_paid) > 0) {
            const early = await _resolveEarlyConfirmationTarget(invoice);
            if (early) await _sendSubscriptionConfirmationEmailOnce({ target: early, invoice, subId });
        }
        return;
    }

    const updateData = { status: 'active', payment_status: 'paid' };
    const strippedUpdate = stripOverriddenFields(updateData);

    if (target.scope === 'organization') {
        const result = await userStore.setOrgSubscriptionRespectingOverride(target.id, updateData, strippedUpdate);
        await userStore.resetPaymentFailureForOrg(target.id);
        if (result.overrideActive) {
            log.info(`[Stripe Webhook] stripe.webhook.override_respected scope=org org=${target.id} event=invoice.paid`);
            await userStore.logSubscriptionAudit('manual_override_respected', 'organization', target.id, 'stripe_webhook', null, { event: 'invoice.paid', invoice_id: invoice.id });
        }
        log.info(`[Stripe Webhook] stripe.invoice.paid scope=org org=${target.id} applied=${result.applied}`);
    } else {
        const result = await userStore.setConsumerSubscriptionRespectingOverride(target.id, updateData, strippedUpdate);
        await userStore.resetPaymentFailureForConsumer(target.id);
        if (result.overrideActive) {
            log.info(`[Stripe Webhook] stripe.webhook.override_respected scope=consumer user=${target.id} event=invoice.paid`);
            await userStore.logSubscriptionAudit('manual_override_respected', 'consumer', target.id, 'stripe_webhook', null, { event: 'invoice.paid', invoice_id: invoice.id });
        }
        log.info(`[Stripe Webhook] stripe.invoice.paid scope=consumer user=${target.id} applied=${result.applied}`);
    }

    // The first paid invoice of a subscription is the "payment successful"
    // moment: confirm it to the customer (renewals do not re-send).
    if (invoice.billing_reason === 'subscription_create' && Number(invoice.amount_paid) > 0) {
        await _sendSubscriptionConfirmationEmailOnce({ target, invoice, subId });
    }
}

/**
 * Who to confirm a first payment to when no local row holds the subscription id
 * yet: the metadata Stripe copied from our checkout onto the subscription, then
 * the Stripe customer id. Null when neither names a subscriber.
 */
async function _resolveEarlyConfirmationTarget(invoice) {
    try {
        const meta = invoice.subscription_details?.metadata || null;
        if (meta?.beeflow_subscriber_type === 'consumer' && meta.beeflow_user_id) {
            return { scope: 'consumer', id: meta.beeflow_user_id };
        }
        if (meta?.beeflow_subscriber_type !== 'consumer' && meta?.beeflow_org_id) {
            return { scope: 'organization', id: meta.beeflow_org_id };
        }
        return await findSubscriptionTargetByCustomerId(invoice.customer);
    } catch (e) {
        log.warn('[Stripe Webhook] early subscription confirmation target lookup failed:', /** @type {Error} */ (e).message);
        return null;
    }
}

/**
 * Idempotent customer confirmation after the first successful payment.
 * Claims a per-subscription slot first, so a webhook redelivery never sends
 * twice. Failures are swallowed: a notification must never 5xx Stripe.
 */
async function _sendSubscriptionConfirmationEmailOnce({ target, invoice, subId }) {
    try {
        const targetType = target.scope === 'organization' ? 'organization' : 'consumer';
        const claimed = await userStore.claimNotification(
            targetType, target.id, `subscription_confirmation:${subId}`,
            null, { sub_id: subId, invoice_id: invoice.id },
        );
        if (!claimed) return;

        let recipientEmail = null, displayName = null, orgName = null;
        if (target.scope === 'consumer') {
            const u = await userStore.getUser(target.id).catch((e) => fallback('stripe/payment:userLookup', e, null));
            recipientEmail = u?.email || null;
            displayName = u?.displayName || u?.username || null;
        } else {
            const org = await userStore.getOrganization(target.id).catch((e) => fallback('stripe/payment:orgLookup', e, null));
            orgName = org?.name || null;
            recipientEmail = org?.email || null;
            try {
                const { getAll } = require('../../db');
                const admins = await getAll(
                    `SELECT email FROM users WHERE "organizationId" = $1 AND (role = 'admin' OR "orgRole" IN ('org_admin', 'admin')) AND email IS NOT NULL AND email <> '' LIMIT 1`,
                    [target.id],
                );
                if (admins?.[0]?.email) recipientEmail = admins[0].email;
            } catch (err) { bestEffort('stripe/payment:adminLookup', err); }
        }
        if (!recipientEmail) return;

        const line = invoice.lines?.data?.[0] || null;
        const price = line?.price || null;
        let planName = null;
        let interval = price?.recurring?.interval === 'year' ? 'yearly' : (price?.recurring?.interval ? 'monthly' : null);
        try {
            const plans = await userStore.getAllPlans();
            const plan = price?.id ? plans.find(p => p.stripe_price_id && p.stripe_price_id === price.id) : null;
            if (plan) {
                planName = plan.name;
                interval = plan.billing_interval || interval;
            }
        } catch (err) { bestEffort('stripe/payment:planLookup', err); }
        if (!planName) planName = price?.nickname || line?.description || 'Subscription';

        const periodEnd = line?.period?.end;
        const nextBillingIso = periodEnd ? new Date(periodEnd * 1000).toISOString() : null;

        let portalUrl = `${appPaths.clientHost()}${appPaths.legacyBillingSettingsPath()}`;
        if (!invoice.hosted_invoice_url) {
            try {
                if (invoice.customer) {
                    const portal = await stripeService.createPortalSession(invoice.customer, portalUrl);
                    if (portal?.url) portalUrl = portal.url;
                }
            } catch (err) { bestEffort('stripe/payment:portalSession', err); }
        }

        const { sendSubscriptionConfirmationEmail } = require('../../utils/emailService');
        const result = await sendSubscriptionConfirmationEmail({
            email: recipientEmail,
            displayName,
            orgName,
            planName,
            amount: Number(invoice.amount_paid) / 100,
            currency: invoice.currency || 'eur',
            interval,
            nextBillingIso,
            invoiceUrl: invoice.hosted_invoice_url || null,
            portalUrl,
        });
        if (!result?.success) {
            log.warn(`[Stripe Webhook] subscription confirmation email failed: ${result?.error || 'unknown'}`);
        }
    } catch (e) {
        log.warn('[Stripe Webhook] _sendSubscriptionConfirmationEmailOnce error:', /** @type {Error} */ (e).message);
    }
}

/**
 * invoice.payment_failed — Payment failed. Bump the dunning counter and
 * stamp past_due_since on the first failure. The dunning scheduler in
 * server/index.js sweeps past_due_since older than the grace window and
 * suspends — that's where the actual feature lockout happens.
 */
// Dunning cap. After this many failed retries, stop the per-attempt email
// stream, transition the sub to `manual_action_required`, and send a single
// "final dunning" email. Customer can re-trigger via portal. Stripe Smart
// Retries usually try at ~3, 5, 7, 14 days; capping at 4 keeps the email
// stream short of the typical "this account is dead" point.
const DUNNING_MAX_ATTEMPTS = 4;

async function handleInvoicePaymentFailed(invoice) {
    const subId = invoice.subscription;
    if (!subId) return;
    const target = await findSubscriptionTargetBySubId(subId);
    if (!target) return;

    let attempt = 0;
    if (target.scope === 'organization') {
        await userStore.setOrgSubscription(target.id, { status: 'past_due', payment_status: 'failed' });
        const updated = await userStore.recordPaymentFailureForOrg(target.id);
        attempt = updated?.payment_attempt_count ?? 0;
        await userStore.logSubscriptionAudit('payment_attempt_failed', 'organization', target.id, 'stripe_webhook', null, { attempt_count: attempt, invoice_id: invoice.id });
        log.info(`[Stripe Webhook] stripe.invoice.payment_failed scope=org org=${target.id} attempt=${attempt}`);
    } else {
        await userStore.setConsumerSubscription(target.id, { status: 'past_due', payment_status: 'failed' });
        const updated = await userStore.recordPaymentFailureForConsumer(target.id);
        attempt = updated?.payment_attempt_count ?? 0;
        await userStore.logSubscriptionAudit('payment_attempt_failed', 'consumer', target.id, 'stripe_webhook', null, { attempt_count: attempt, invoice_id: invoice.id });
        log.info(`[Stripe Webhook] stripe.invoice.payment_failed scope=consumer user=${target.id} attempt=${attempt}`);
    }

    // Reached the cap: transition to manual_action_required (silences future
    // per-attempt emails) and send the one final dunning email. The status
    // flip is idempotent — `claimNotification('payment_dunning_capped')`
    // ensures the final email is sent at most once.
    if (attempt >= DUNNING_MAX_ATTEMPTS) {
        try {
            if (target.scope === 'organization') {
                await userStore.setOrgSubscription(target.id, { status: 'manual_action_required' });
            } else {
                await userStore.setConsumerSubscription(target.id, { status: 'manual_action_required' });
            }
            await userStore.logSubscriptionAudit(
                'payment_dunning_capped',
                target.scope === 'organization' ? 'organization' : 'consumer',
                target.id,
                'stripe_webhook',
                null,
                { attempt_count: attempt, cap: DUNNING_MAX_ATTEMPTS },
            );
            await _sendFinalDunningEmailOnce({ target, customerId: invoice.customer || null });
        } catch (e) {
            log.warn('[Stripe Webhook] dunning-cap transition failed:', /** @type {Error} */ (e).message);
        }
        return; // do NOT fire the per-attempt email once we've capped
    }

    // Fire-and-forget "payment failed" email, gated on the attempt counter
    // so each failure (Stripe Smart Retries: ~3, 5, 7 days) gets at most
    // one email — webhook redeliveries claim against the same key.
    await _sendPaymentFailedEmailOnce({
        target,
        attempt,
        customerId: invoice.customer || null,
    });
}

/** @typedef {{ customerId?: string }} _sendFinalDunningEmailOnceArgs */
/**
 * @param {_sendFinalDunningEmailOnceArgs} param0
 */
async function _sendFinalDunningEmailOnce({ target, customerId }) {
    try {
        const targetType = target.scope === 'organization' ? 'organization' : 'consumer';
        const claimed = await userStore.claimNotification(targetType, target.id, 'payment_dunning_capped', null, { cap: DUNNING_MAX_ATTEMPTS });
        if (!claimed) return;

        let recipientEmail = null, displayName = null, orgName = null;
        if (target.scope === 'consumer') {
            const u = await userStore.getUser(target.id).catch((e) => fallback('stripe/payment:userLookup', e, null));
            recipientEmail = u?.email || null;
            displayName = u?.displayName || u?.username || null;
        } else {
            const org = await userStore.getOrganization(target.id).catch((e) => fallback('stripe/payment:orgLookup', e, null));
            orgName = org?.name || null;
            recipientEmail = org?.email || null;
            try {
                const { getAll } = require('../../db');
                const admins = await getAll(
                    `SELECT email FROM users WHERE "organizationId" = $1 AND (role = 'admin' OR "orgRole" IN ('org_admin', 'admin')) AND email IS NOT NULL AND email <> '' LIMIT 1`,
                    [target.id],
                );
                if (admins?.[0]?.email) recipientEmail = admins[0].email;
            } catch (err) { bestEffort('stripe/payment:adminLookup', err); }
        }
        if (!recipientEmail) return;

        const clientHost = appPaths.clientHost();
        let portalUrl = `${clientHost}${appPaths.legacyBillingSettingsPath()}`;
        try {
            if (customerId) {
                const portal = await stripeService.createPortalSession(customerId, portalUrl);
                if (portal?.url) portalUrl = portal.url;
            }
        } catch (err) { bestEffort('stripe/payment:portalSession', err); }

        const { sendSubscriptionSuspendedEmail } = require('../../utils/emailService');
        await sendSubscriptionSuspendedEmail({
            email: recipientEmail,
            displayName,
            orgName,
            portalUrl,
            reason: 'payment_dunning_capped',
        }).catch(e => log.warn('[Stripe Webhook] final dunning email send failed:', e.message));
    } catch (e) {
        log.warn('[Stripe Webhook] _sendFinalDunningEmailOnce error:', /** @type {Error} */ (e).message);
    }
}

/** @typedef {{ attempt: number, customerId?: string }} _sendPaymentFailedEmailOnceArgs */
/**
 * @param {_sendPaymentFailedEmailOnceArgs} param0
 */
async function _sendPaymentFailedEmailOnce({ target, attempt, customerId }) {
    try {
        const targetType = target.scope === 'organization' ? 'organization' : 'consumer';
        const kind = `payment_failed:attempt:${attempt}`;
        const claimed = await userStore.claimNotification(targetType, target.id, kind, null, { attempt });
        if (!claimed) return;

        // Resolve recipient + display name. Mirrors the trial-end helper but
        // tolerates a missing customer id (some failure modes don't include
        // it; we fall back to the org/user record).
        let recipientEmail = null, displayName = null, orgName = null;
        if (target.scope === 'consumer') {
            const u = await userStore.getUser(target.id).catch((e) => fallback('stripe/payment:userLookup', e, null));
            recipientEmail = u?.email || null;
            displayName = u?.displayName || u?.username || null;
        } else {
            const org = await userStore.getOrganization(target.id).catch((e) => fallback('stripe/payment:orgLookup', e, null));
            orgName = org?.name || null;
            recipientEmail = org?.email || null;
            try {
                const { getAll } = require('../../db');
                const admins = await getAll(
                    `SELECT email FROM users WHERE "organizationId" = $1 AND (role = 'admin' OR "orgRole" IN ('org_admin', 'admin')) AND email IS NOT NULL AND email <> '' LIMIT 5`,
                    [target.id],
                );
                const adminEmails = (admins || []).map(a => a.email).filter(Boolean);
                if (adminEmails.length > 0) recipientEmail = adminEmails[0];
            } catch (err) { bestEffort('stripe/payment:adminLookup', err); }
        }
        if (!recipientEmail) return;

        const clientHost = appPaths.clientHost();
        let portalUrl = `${clientHost}${appPaths.legacyBillingSettingsPath()}`;
        try {
            if (customerId) {
                const portal = await stripeService.createPortalSession(customerId, portalUrl);
                if (portal?.url) portalUrl = portal.url;
            }
        } catch (err) { bestEffort('stripe/payment:portalSession', err); }

        const { sendPaymentFailedEmail } = require('../../utils/emailService');
        await sendPaymentFailedEmail({
            email: recipientEmail,
            displayName,
            orgName,
            portalUrl,
            attemptCount: attempt,
        }).catch(e => log.warn('[Stripe Webhook] payment_failed email send failed:', e.message));
    } catch (e) {
        log.warn('[Stripe Webhook] _sendPaymentFailedEmailOnce error:', /** @type {Error} */ (e).message);
    }
}

module.exports = {
    handleChargeRefunded,
    handleChargeDisputeCreated,
    handleInvoicePaid,
    _sendSubscriptionConfirmationEmailOnce,
    DUNNING_MAX_ATTEMPTS,
    handleInvoicePaymentFailed,
    _sendFinalDunningEmailOnce,
    _sendPaymentFailedEmailOnce,
};

/**
 * The fields of the (unexpanded) Stripe webhook objects these handlers read.
 * @typedef {{ id: string, invoice?: string | null, subscription?: string | null, customer?: string | null, amount_refunded?: number }} WebhookCharge
 * @typedef {{ id: string, charge?: string | null, customer?: string | null, reason?: string, amount?: number }} WebhookDispute
 * @typedef {{
 *   id: string,
 *   subscription?: string | null,
 *   customer?: string | null,
 *   billing_reason?: string | null,
 *   amount_paid?: number,
 *   currency?: string,
 *   hosted_invoice_url?: string | null,
 *   subscription_details?: { metadata?: Record<string, string> | null } | null,
 *   lines?: { data?: Array<{ description?: string | null, period?: { end?: number }, price?: { id?: string, nickname?: string | null, recurring?: { interval?: string } | null } | null }> },
 * }} WebhookInvoice
 * @typedef {{ scope: string, id: string }} SubscriptionTarget
 */
