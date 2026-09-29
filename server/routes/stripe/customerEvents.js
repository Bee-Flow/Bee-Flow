/**
 * Customer-object webhooks: the VAT/tax-id and customer-profile mirrors that
 * keep the local organisation row in step with what the customer maintains in
 * the Stripe portal, the payment-method save attempts (setup_intent), and the
 * customer.deleted cleanup.
 */

const stripeService = require('../../services/stripeService');
const userStore = require('../../stores/userStore');
const { findSubscriptionTargetByCustomerId } = require('./webhookShared');
const appPaths = require('../../utils/appPaths');
const log = require('../../telemetry/log');

/**
 * customer.tax_id.created / updated / deleted — keep the org's stored VAT in
 * sync with what the customer maintains in the Stripe portal. Matching is by
 * stripe_customer_id → organization. Consumers don't have a VAT field so
 * they're skipped. Failures are audit-logged but never surface as 5xx (we
 * always 200 the webhook).
 */
async function handleCustomerTaxIdChange(taxIdObj, eventType) {
    try {
        const customerId = taxIdObj?.customer;
        if (!customerId) return;
        const { getAll } = require('../../db');
        const subs = await getAll(
            `SELECT organization_id FROM organization_subscriptions WHERE stripe_customer_id = $1`,
            [customerId]
        );
        if (!subs?.length) {
            log.info(`[Stripe Webhook] tax_id.${eventType.split('.').pop()} for unknown customer=${customerId}`);
            return;
        }
        const orgId = subs[0].organization_id;
        // For deletions clear the VAT; for create/update prefer the new value.
        const value = eventType === 'customer.tax_id.deleted' ? '' : (taxIdObj.value || '');
        await require('../../stores/userStore').updateOrganization(orgId, { vat: value });
        await userStore.logSubscriptionAudit(
            'tax_id_synced',
            'organization',
            orgId,
            'stripe_webhook',
            null,
            { event: eventType, customer: customerId, type: taxIdObj.type, value }
        );
        log.info(`[Stripe Webhook] tax_id synced org=${orgId} type=${taxIdObj.type} value=${value || '(cleared)'}`);
    } catch (e) {
        log.warn('[Stripe Webhook] handleCustomerTaxIdChange error:', e.message);
    }
}

/**
 * customer.updated — Stripe customers carry name, email, address, tax_exempt.
 * Today we only need to mirror address changes that affect tax calculation:
 * specifically, sync `organizations.email` when the billing email is changed
 * via the customer portal. Light touch — most fields stay Stripe-owned.
 */
async function handleCustomerUpdated(customer) {
    try {
        const { getAll } = require('../../db');
        const subs = await getAll(
            `SELECT organization_id FROM organization_subscriptions WHERE stripe_customer_id = $1`,
            [customer.id]
        );
        if (!subs?.length) return;
        const orgId = subs[0].organization_id;
        const updates = {};
        if (customer.email) updates.email = customer.email;
        if (customer.phone) updates.phone = customer.phone;
        // Mirror an address edited in the Billing Portal back to the org's
        // structured columns (legacy `address` = line1) so Org Info stays in
        // sync. Only write the parts Stripe actually returned.
        const a = customer.address;
        if (a && (a.line1 || a.postal_code || a.city || a.country)) {
            if (a.line1 != null) updates.address = a.line1;
            updates.billingLine2 = a.line2 || '';
            updates.billingPostalCode = a.postal_code || '';
            updates.billingCity = a.city || '';
            updates.billingCountry = a.country || '';
        }
        if (Object.keys(updates).length === 0) return;
        await require('../../stores/userStore').updateOrganization(orgId, updates);
        await userStore.logSubscriptionAudit(
            'customer_synced',
            'organization',
            orgId,
            'stripe_webhook',
            null,
            { customer: customer.id, fields: Object.keys(updates) }
        );
    } catch (e) {
        log.warn('[Stripe Webhook] handleCustomerUpdated error:', e.message);
    }
}

/**
 * setup_intent.setup_failed — Customer tried to save a new payment method
 * (typically from the Customer Portal) and the card was declined or
 * abandoned mid-3DS. Audit the failure and email the customer so they
 * don't only find out at the next invoice. claimNotification deduplicates
 * webhook replays.
 */
async function handleSetupIntentFailed(setupIntent) {
    try {
        const customerId = setupIntent.customer;
        if (!customerId) return;
        const target = await findSubscriptionTargetByCustomerId(customerId);
        if (!target) {
            log.info(`[Stripe Webhook] setup_intent.failed for unknown customer=${customerId}`);
            return;
        }
        const targetType = target.scope === 'organization' ? 'organization' : 'consumer';
        await userStore.logSubscriptionAudit(
            'setup_intent_failed',
            targetType,
            target.id,
            'stripe_webhook',
            null,
            { setup_intent_id: setupIntent.id, last_setup_error: setupIntent.last_setup_error?.message || null },
        );

        // One email per setup_intent id (so 3DS retries and webhook replays
        // don't double-send).
        const claimed = await userStore.claimNotification(targetType, target.id, `setup_intent_failed:${setupIntent.id}`, null, { setup_intent_id: setupIntent.id });
        if (!claimed) return;

        let recipientEmail = null;
        let displayName = null;
        let orgName = null;
        if (target.scope === 'consumer') {
            const u = await userStore.getUser(target.id).catch(() => null);
            recipientEmail = u?.email || null;
            displayName = u?.displayName || u?.username || null;
        } else {
            const org = await userStore.getOrganization(target.id).catch(() => null);
            orgName = org?.name || null;
            recipientEmail = org?.email || null;
        }
        if (!recipientEmail) return;

        const clientHost = appPaths.clientHost();
        let portalUrl = `${clientHost}${appPaths.legacyBillingSettingsPath()}`;
        try {
            const portal = await stripeService.createPortalSession(customerId, portalUrl);
            if (portal?.url) portalUrl = portal.url;
        } catch (_) { /* fall back */ }

        const { sendPaymentFailedEmail } = require('../../utils/emailService');
        await sendPaymentFailedEmail({
            email: recipientEmail,
            displayName,
            orgName,
            portalUrl,
            attemptCount: 0,
        }).catch(e => log.warn('[Stripe Webhook] setup_intent_failed email failed:', e.message));
    } catch (e) {
        log.warn('[Stripe Webhook] handleSetupIntentFailed error:', e.message);
    }
}

/**
 * setup_intent.succeeded — Card saved successfully. Audit only; no email
 * (Stripe sends its own confirmation if the customer opts in).
 */
async function handleSetupIntentSucceeded(setupIntent) {
    try {
        const customerId = setupIntent.customer;
        if (!customerId) return;
        const target = await findSubscriptionTargetByCustomerId(customerId);
        if (!target) return;
        await userStore.logSubscriptionAudit(
            'setup_intent_succeeded',
            target.scope === 'organization' ? 'organization' : 'consumer',
            target.id,
            'stripe_webhook',
            null,
            { setup_intent_id: setupIntent.id, payment_method: setupIntent.payment_method || null },
        );
    } catch (e) {
        log.warn('[Stripe Webhook] handleSetupIntentSucceeded error:', e.message);
    }
}

/**
 * customer.deleted — Stripe customer was removed (rare; usually triggered
 * manually by an admin). Null the local stripe_customer_id so the next
 * checkout creates a fresh customer instead of failing on an invalid id.
 */
async function handleCustomerDeleted(customer) {
    const target = await userStore.findSubscriptionByStripeCustomerId(customer.id);
    if (!target) return;
    if (target.scope === 'organization') {
        await userStore.clearStripeCustomerIdForOrg(target.id);
        await userStore.logSubscriptionAudit('stripe_customer_deleted', 'organization', target.id, 'stripe_webhook', null, { stripe_customer_id: customer.id });
        log.info(`[Stripe Webhook] stripe.customer.deleted scope=org org=${target.id} customer_id=${customer.id}`);
    } else {
        await userStore.clearStripeCustomerIdForConsumer(target.id);
        await userStore.logSubscriptionAudit('stripe_customer_deleted', 'consumer', target.id, 'stripe_webhook', null, { stripe_customer_id: customer.id });
        log.info(`[Stripe Webhook] stripe.customer.deleted scope=consumer user=${target.id} customer_id=${customer.id}`);
    }
}

module.exports = {
    handleCustomerTaxIdChange,
    handleCustomerUpdated,
    handleSetupIntentFailed,
    handleSetupIntentSucceeded,
    handleCustomerDeleted,
};
