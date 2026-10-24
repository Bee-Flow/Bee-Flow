/**
 * Hosted Checkout and the Billing Portal: checkout session creation (org
 * customer resolution, VAT, address, tax, recurring disclosure), session
 * lookup and portal sessions.
 */

const deps = require('./deps');
const log = require('../../telemetry/log');
const { bestEffort } = require('../../utils/bestEffort');
const { getClient, escapeSearchValue } = require('./client');
const { resolveStripeTaxId, buildStripeAddress } = require('./customer');

// Anchor every new subscription's billing cycle to the 1st of next month
// (UTC). Stripe automatically pro-rates the partial period from "now" to
// the anchor, so the first invoice reflects only the days actually used —
// and every org/consumer renews on the same calendar day regardless of
// when they signed up.
function computeBillingCycleAnchor() {
    const now = new Date();
    return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) / 1000);
}

// BFSF-243: bilingual (NL/EN) recurring-billing disclosure rendered under the
// pay button on the hosted Stripe Checkout page. Interval-aware so a yearly
// plan never claims to be a "maandabonnement". Must stay well under Stripe's
// 1200-char custom_text limit; plain text only (no HTML).
function buildRecurringDisclosure(billingInterval) {
    const yearly = billingInterval === 'yearly';
    const nl = yearly
        ? 'Jaarabonnement met automatische incasso: je gekozen betaalmethode wordt elk jaar automatisch belast tot je opzegt.'
        : 'Maandabonnement met automatische incasso: je gekozen betaalmethode wordt elke maand automatisch belast tot je opzegt.';
    const en = yearly
        ? 'Recurring yearly subscription, billed automatically each year until you cancel.'
        : 'Recurring monthly subscription, billed automatically each month until you cancel.';
    return `${nl} — ${en}`;
}

/**
 * Create a Stripe Checkout Session for a plan.
 * Supports both organization and consumer subscriptions.
 * 
 * @param {object} options
 * @param {object} options.plan - BeeFlow plan object
 * @param {string} [options.orgId] - Organization ID (org checkout)
 * @param {string} [options.orgName] - Organization name (org checkout)
 * @param {string} [options.userId] - User ID (consumer checkout)
 * @param {string} [options.subscriberType] - 'organization' or 'consumer'
 * @param {string} options.userEmail - User email for pre-fill
 * @param {string} options.successUrl - Redirect URL on success
 * @param {string} options.cancelUrl - Redirect URL on cancel
 * @param {string} [options.stripeCustomerId] - Existing Stripe customer ID
 * @returns {object} Stripe Checkout Session
 */
async function createCheckoutSession({ plan, orgId, orgName, userId, subscriberType = 'organization', userEmail, successUrl, cancelUrl, stripeCustomerId }) {
    const stripe = await getClient();

    if (!plan.stripe_price_id) {
        throw new Error('Plan has not been synced to Stripe yet. Ask your administrator to sync the plan.');
    }

    const isConsumer = subscriberType === 'consumer';

    // Build metadata based on subscriber type
    const metadata = {
        beeflow_plan_id: plan.id,
        beeflow_subscriber_type: subscriberType,
    };
    if (isConsumer) {
        metadata.beeflow_user_id = userId;
    } else {
        metadata.beeflow_org_id = orgId;
    }

    // Per-seat org plans bill `quantity = active seat count` so Stripe
    // pro-rates as the org grows or shrinks. Consumer plans always
    // bill quantity=1 (they have a single user by definition).
    let quantity = 1;
    if (plan.per_seat && !isConsumer && orgId) {
        try {
            const userStore = deps.userStore();
            quantity = Math.max(1, await userStore.getActiveSeatCount(orgId));
        } catch (e) {
            log.warn('[Stripe] per-seat checkout: seat count lookup failed, defaulting to 1:', e.message);
        }
    }

    const sessionParams = {
        mode: 'subscription',
        line_items: [{ price: plan.stripe_price_id, quantity }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        client_reference_id: isConsumer ? userId : orgId,
        metadata,
        subscription_data: { metadata },
    };

    // For org checkouts, pre-attach the org's stored VAT to a Stripe customer
    // so Stripe Tax can apply reverse charge (EU B2B) without making the
    // org-admin re-enter the number during checkout. We only build/upgrade
    // a customer when the VAT is parseable; otherwise we fall back to the
    // existing email/customer flow and Stripe will collect the VAT inline.
    let effectiveCustomerId = stripeCustomerId || null;
    if (!isConsumer && orgId) {
        try {
            const userStore = deps.userStore();
            const org = await userStore.getOrganization(orgId);

            // Resolve ONE Stripe customer per org so repeated checkout attempts
            // (e.g. before the first one activates) don't mint duplicate
            // customers. Order: stored id → search by metadata.beeflow_org_id →
            // create. The result is persisted immediately so the next attempt
            // reuses it without depending on the (eventually-consistent) search
            // index or the activation webhook.
            if (!effectiveCustomerId) {
                try {
                    const found = await stripe.customers.search({
                        query: `metadata['beeflow_org_id']:'${escapeSearchValue(orgId)}'`,
                        limit: 1,
                    });
                    if (found?.data?.[0]?.id) effectiveCustomerId = found.data[0].id;
                } catch (e) { bestEffort('stripe/checkout:customerSearch', e); }
            }
            if (!effectiveCustomerId) {
                const created = await stripe.customers.create({
                    name: orgName || org?.name || undefined,
                    email: userEmail || org?.email || undefined,
                    metadata: { beeflow_org_id: orgId },
                });
                effectiveCustomerId = created.id;
            }
            if (effectiveCustomerId) {
                try { await userStore.setOrgSubscription(orgId, { stripe_customer_id: effectiveCustomerId }); }
                catch (e) { bestEffort('stripe/checkout:persistCustomerId', e); }
            }

            // Attach the org's VAT id (idempotent) so Stripe Tax can apply EU
            // reverse charge without the admin re-entering it. Non-fatal: the
            // checkout still proceeds and inline tax_id_collection covers it.
            const taxId = org ? resolveStripeTaxId(org.vat) : null;
            if (taxId && effectiveCustomerId) {
                try {
                    const existing = await stripe.customers.listTaxIds(effectiveCustomerId, { limit: 25 });
                    const already = (existing?.data || []).some(t => t.value === taxId.value && t.type === taxId.type);
                    if (!already) await stripe.customers.createTaxId(effectiveCustomerId, taxId);
                } catch (e) {
                    log.warn(`[Stripe] attaching VAT for org ${orgId} failed: ${e.message}`);
                }
            }

            // Sync the org's structured billing address + phone onto the
            // customer so Checkout and the Billing Portal pre-fill, and Stripe
            // Tax has a valid address. Covers reused/pre-existing customers too
            // (the create call above only sets name/email). Non-fatal: checkout
            // still proceeds via billing_address_collection + customer_update.
            if (effectiveCustomerId) {
                try {
                    const billingUpdates = {};
                    if (org?.phone) billingUpdates.phone = org.phone;
                    const address = buildStripeAddress(org);
                    if (address) billingUpdates.address = address;
                    if (Object.keys(billingUpdates).length > 0) {
                        await stripe.customers.update(effectiveCustomerId, billingUpdates);
                    }
                } catch (e) {
                    log.warn(`[Stripe] syncing billing address for org ${orgId} failed: ${e.message}`);
                }
            }
        } catch (e) {
            log.warn(`[Stripe] org customer resolution skipped: ${e.message}`);
        }
    }

    // Re-use existing customer (possibly just created above with VAT) or
    // pre-fill email so Stripe creates one at checkout time.
    if (effectiveCustomerId) {
        sessionParams.customer = effectiveCustomerId;
    } else {
        sessionParams.customer_email = userEmail;
    }

    // Apply trial period if plan has trial days
    if (plan.trial_days && plan.trial_days > 0) {
        sessionParams.subscription_data.trial_period_days = plan.trial_days;
    } else {
        // Anchor the billing cycle to a stable monthly date (1st of next
        // month UTC) so every paying subscription renews on the same day.
        // Stripe rejects billing_cycle_anchor together with
        // trial_period_days (the trial end IS the implicit anchor), so we
        // only set it when there's no trial. `create_prorations` makes
        // Stripe issue a partial-period charge between "now" and the
        // anchor — relevant for per-seat plans entering mid-cycle.
        sessionParams.subscription_data.billing_cycle_anchor = computeBillingCycleAnchor();
        sessionParams.subscription_data.proration_behavior = 'create_prorations';
    }

    // Tax collection
    const taxEnabled = await deps.configStore.getConfig('stripe_tax_enabled');
    if (taxEnabled) {
        sessionParams.automatic_tax = { enabled: true };
        // Collect billing address so Stripe can calculate tax
        sessionParams.billing_address_collection = 'required';
        // Allow B2B customers to enter VAT numbers (covers customers we
        // didn't pre-attach a VAT for above).
        sessionParams.tax_id_collection = { enabled: true };
        // When a Customer is pre-attached, Stripe Tax requires an address ON
        // that Customer. billing_address_collection alone does NOT write the
        // entered address back to an existing Customer — customer_update does.
        // Without this, session creation is rejected with "Automatic tax
        // calculation in Checkout requires a valid address on the Customer".
        // (Invalid alongside customer_email, so guard on `customer`.)
        if (sessionParams.customer) {
            sessionParams.customer_update = { address: 'auto', name: 'auto' };
        }
    }

    // Allow promo codes
    sessionParams.allow_promotion_codes = true;

    // BFSF-243: make the recurring nature explicit on the hosted checkout.
    // Stripe otherwise renders a subscription checkout much like a one-off
    // payment; Dutch business customers expect an explicit "automatische
    // incasso" disclosure to avoid confusion, disputes and chargebacks.
    // `locale: 'auto'` keeps Stripe's own UI in the customer's language; the
    // note under the pay button is kept bilingual (NL/EN) and well under the
    // 1200-char limit. The in-app pre-checkout callout carries the localised
    // version. NOTE: the valid CustomText key is `submit` — `submit_button`
    // does not exist and makes Stripe reject the whole session
    // (invalid_request_error), breaking checkout outright.
    sessionParams.locale = 'auto';
    sessionParams.custom_text = {
        submit: {
            message: buildRecurringDisclosure(plan.billing_interval),
        },
    };

    // Optional ToS consent checkbox on the hosted page. Stripe hard-fails
    // session creation when the Dashboard has no Terms of Service URL
    // configured (dashboard.stripe.com/settings/public), so this is opt-in
    // via config — never unconditional (self-hosters would break checkout).
    if (await deps.configStore.getConfig('stripe_tos_consent_enabled')) {
        sessionParams.consent_collection = { terms_of_service: 'required' };
    }

    return stripe.checkout.sessions.create(sessionParams);
}

/**
 * Synchronous lookup of a Stripe Checkout Session, expanding subscription +
 * customer so the caller can render post-checkout state without waiting
 * for the webhook. Used by GET /api/stripe/sessions/:id.
 */
async function retrieveCheckoutSession(sessionId) {
    const stripe = await getClient();
    return stripe.checkout.sessions.retrieve(sessionId, {
        expand: ['subscription', 'customer'],
    });
}

/**
 * Create a Stripe Customer Portal session for billing management.
 * 
 * @param {string} stripeCustomerId - Stripe customer ID
 * @param {string} returnUrl - URL to return to after portal
 * @returns {object} Portal session with url
 */
async function createPortalSession(stripeCustomerId, returnUrl) {
    const stripe = await getClient();
    return stripe.billingPortal.sessions.create({
        customer: stripeCustomerId,
        return_url: returnUrl,
    });
}

module.exports = {
    computeBillingCycleAnchor,
    buildRecurringDisclosure,
    createCheckoutSession,
    retrieveCheckoutSession,
    createPortalSession,
};
