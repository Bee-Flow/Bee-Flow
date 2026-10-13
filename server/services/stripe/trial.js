/**
 * Trials without Checkout, and the automatic_tax backfill for existing
 * subscriptions when the tax toggle is switched on.
 */

const deps = require('./deps');
const log = require('../../telemetry/log');
const { getClient } = require('./client');
const { buildStripeAddress } = require('./customer');

/**
 * Create a Stripe Subscription directly with a trial period, without
 * collecting a payment method up front. Used by the admin "Start Trial"
 * flow so trials can be granted to an org/user without making them
 * complete a Checkout first.
 *
 * If no payment method is added before the trial ends, Stripe will
 * auto-cancel the subscription (`missing_payment_method: 'cancel'`).
 *
 * @param {object} options
 * @param {object} options.plan - BeeFlow plan (must have stripe_price_id)
 * @param {'organization'|'consumer'} options.subscriberType
 * @param {string} options.subscriberId - org id or user id
 * @param {string} [options.orgName] - used as customer.name when org
 * @param {string} [options.userEmail] - used as customer.email
 * @param {string} [options.stripeCustomerId] - reuse if already exists
 * @param {number} options.trialDays
 * @returns {{ stripeCustomerId: string, stripeSubscriptionId: string, trialEnd: string|null, status: string }}
 */
async function createTrialSubscription({ plan, subscriberType, subscriberId, orgName, userEmail, stripeCustomerId, trialDays }) {
    const stripe = await getClient();

    if (!plan.stripe_price_id) {
        throw new Error('Plan has not been synced to Stripe yet. Sync the plan before starting a trial.');
    }
    if (!trialDays || trialDays <= 0) {
        throw new Error('Plan has no trial_days configured.');
    }

    const metadata = {
        beeflow_plan_id: plan.id,
        beeflow_subscriber_type: subscriberType,
    };
    if (subscriberType === 'consumer') metadata.beeflow_user_id = subscriberId;
    else metadata.beeflow_org_id = subscriberId;

    // For org trials, pull the org's stored billing address + phone so the
    // Stripe Customer (and thus the portal) is pre-filled and Stripe Tax has
    // a valid address. Non-fatal lookup.
    let org = null;
    if (subscriberType === 'organization' && subscriberId) {
        try { org = await deps.userStore().getOrganization(subscriberId); }
        catch (e) { /* non-fatal — fall back to name/email only */ }
    }
    const trialAddress = buildStripeAddress(org);

    let customerId = stripeCustomerId || null;
    if (!customerId) {
        const customer = await stripe.customers.create({
            email: userEmail || org?.email || undefined,
            name: orgName || org?.name || undefined,
            phone: org?.phone || undefined,
            ...(trialAddress ? { address: trialAddress } : {}),
            metadata,
        });
        customerId = customer.id;
    } else if (org && (trialAddress || org.phone)) {
        // Reused customer — refresh address/phone so the portal pre-fills.
        try {
            const updates = {};
            if (org.phone) updates.phone = org.phone;
            if (trialAddress) updates.address = trialAddress;
            await stripe.customers.update(customerId, updates);
        } catch (e) {
            log.warn(`[Stripe] trial billing sync for org ${subscriberId} failed: ${e.message}`);
        }
    }

    // BFSF-250: trial-started subscriptions previously never enabled
    // automatic_tax, so they billed WITHOUT the 21% BTW breakdown forever —
    // even after the trial converted to paid — while checkout-started
    // subscriptions did tax correctly. Stripe rejects automatic_tax for
    // customers without a valid address, so only set it when we have one
    // (consumer trials usually have no address source; they stay untaxed
    // until the Dashboard/ops backfill completes their address).
    let automaticTax = false;
    try {
        if (await deps.configStore.getConfig('stripe_tax_enabled')) {
            if (trialAddress) {
                automaticTax = true;
            } else {
                log.warn(`[Stripe] trial for ${subscriberType} ${subscriberId}: stripe_tax_enabled but no billing address — automatic_tax skipped (invoice will lack BTW lines until the address is completed)`);
            }
        }
    } catch (e) { /* non-fatal — behave as before */ }

    const buildTrialParams = (withTax) => ({
        customer: customerId,
        items: [{ price: plan.stripe_price_id }],
        trial_period_days: trialDays,
        trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
        payment_behavior: 'default_incomplete',
        payment_settings: { save_default_payment_method: 'on_subscription' },
        ...(withTax ? { automatic_tax: { enabled: true } } : {}),
        metadata,
    });

    let subscription;
    try {
        subscription = await stripe.subscriptions.create(buildTrialParams(automaticTax));
    } catch (e) {
        // A plan whose Stripe price was synced BEFORE the tax toggle lacks
        // tax_behavior — Stripe then rejects automatic_tax. Degrade to an
        // untaxed trial (the pre-fix behavior) instead of blocking the trial
        // entirely; the admin remedy is a plan re-sync.
        if (automaticTax && /tax_behavior|automatic_tax|tax/i.test(e.message || '')) {
            log.warn(`[Stripe] trial automatic_tax rejected (${e.message?.slice(0, 160)}) — retrying WITHOUT tax. Re-sync the plan so its price carries tax_behavior.`);
            subscription = await stripe.subscriptions.create(buildTrialParams(false));
        } else {
            throw e;
        }
    }

    return {
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscription.id,
        trialEnd: subscription.trial_end ? new Date(subscription.trial_end * 1000).toISOString() : null,
        status: subscription.status,
    };
}

/**
 * BFSF-250: enable automatic_tax on EXISTING active/trialing subscriptions.
 * automatic_tax is per-subscription, so flipping the admin toggle only
 * affects NEW checkouts — subscriptions created before the flip would bill
 * without VAT lines forever. Fired (fire-and-forget, same style as
 * syncSeatQuantityForOrg) from the config route when stripe_tax_enabled
 * transitions false→true. Idempotent: re-enabling automatic_tax on a
 * subscription that already has it is a no-op, so re-running is safe.
 * Customers without a valid address are rejected by Stripe — those are
 * skipped and logged, leaving a mixed fleet until their addresses are
 * completed.
 */
async function enableAutomaticTaxForExistingSubscriptions() {
    const stripe = await getClient();
    const userStore = deps.userStore();
    const rows = [];
    try { rows.push(...(await userStore.getAllOrgSubscriptions() || [])); } catch (e) { log.warn('[Stripe] tax backfill: org subs lookup failed:', e.message); }
    try { rows.push(...(await userStore.getAllConsumerSubscriptions() || [])); } catch (e) { log.warn('[Stripe] tax backfill: consumer subs lookup failed:', e.message); }

    let updated = 0;
    let skipped = 0;
    for (const row of rows) {
        const subId = row.stripe_subscription_id;
        const status = row.status || row.payment_status;
        if (!subId) continue;
        if (!['active', 'trialing', 'paid', 'past_due'].includes(status)) continue;
        try {
            await stripe.subscriptions.update(subId, { automatic_tax: { enabled: true } });
            updated++;
        } catch (e) {
            skipped++;
            log.warn(`[Stripe] tax backfill: ${subId} skipped (${e.message?.slice(0, 160)})`);
        }
    }
    log.info(`[Stripe] automatic_tax backfill done — updated=${updated} skipped=${skipped} of ${rows.length} rows`);
    return { updated, skipped, total: rows.length };
}

module.exports = {
    createTrialSubscription,
    enableAutomaticTaxForExistingSubscriptions,
};
