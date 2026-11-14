// @typecheck
/**
 * Hosted Checkout and the Billing Portal: checkout session creation (org
 * customer resolution, VAT, address, tax, recurring disclosure), session
 * lookup and portal sessions.
 */

const deps = require('./deps');
const log = require('../../telemetry/log');
const { bestEffort } = require('../../utils/bestEffort');
const { assertStored } = require('../../stores/user/assertStored');
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
/**
 * @param {string} billingInterval
 */
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
 * @typedef {Awaited<ReturnType<typeof getClient>>} StripeClient
 * @typedef {Parameters<typeof buildStripeAddress>[0] & { vat?: string | null, phone?: string | null, name?: string | null, email?: string | null }} OrgBillingRow
 */

/**
 * The quantity billed. Per-seat org plans bill the active seat count so
 * Stripe pro-rates as the org grows or shrinks; a consumer is always one.
 * @param {DbRow.SubscriptionPlans} plan
 * @param {boolean} isConsumer
 * @param {string | undefined} orgId
 */
async function billedSeatCount(plan, isConsumer, orgId) {
    if (!plan.per_seat || isConsumer || !orgId) return 1;
    try {
        return Math.max(1, await deps.userStore().getActiveSeatCount(orgId));
    } catch (e) {
        log.warn('[Stripe] per-seat checkout: seat count lookup failed, defaulting to 1:', /** @type {Error} */ (e).message);
        return 1;
    }
}

/**
 * The org's customer found by its metadata, or null (the search index is
 * eventually consistent and may also fail).
 * @param {StripeClient} stripe
 * @param {string} orgId
 */
async function searchOrgCustomer(stripe, orgId) {
    try {
        const found = await stripe.customers.search({
            query: `metadata['beeflow_org_id']:'${escapeSearchValue(orgId)}'`,
            limit: 1,
        });
        if (found?.data?.[0]?.id) return found.data[0].id;
    } catch (e) { bestEffort('stripe/checkout:customerSearch', e); }
    return null;
}

/**
 * Attach the org's VAT id (idempotent) so Stripe Tax can apply EU reverse
 * charge without the admin re-entering it. Non-fatal: inline
 * tax_id_collection covers it.
 * @param {StripeClient} stripe
 * @param {string | null} customerId
 * @param {OrgBillingRow | null | undefined} org
 * @param {string} orgId
 */
async function attachOrgVat(stripe, customerId, org, orgId) {
    const taxId = org ? resolveStripeTaxId(org.vat) : null;
    if (!taxId || !customerId) return;
    try {
        const existing = await stripe.customers.listTaxIds(customerId, { limit: 25 });
        const already = (existing?.data || []).some((/** @type {{ value: string; type: string; }} */ t) => t.value === taxId.value && t.type === taxId.type);
        if (!already) await stripe.customers.createTaxId(customerId, taxId);
    } catch (e) {
        log.warn(`[Stripe] attaching VAT for org ${orgId} failed: ${/** @type {Error} */ (e).message}`);
    }
}

/**
 * Sync the org's structured billing address + phone onto the customer so
 * Checkout and the Billing Portal pre-fill and Stripe Tax has a valid
 * address, for reused customers too (create only sets name/email).
 * Non-fatal: billing_address_collection + customer_update cover it.
 * @param {StripeClient} stripe
 * @param {string} customerId
 * @param {OrgBillingRow | null | undefined} org
 * @param {string} orgId
 */
async function syncOrgBillingAddress(stripe, customerId, org, orgId) {
    try {
        /** @type {Record<string, unknown>} */
        const billingUpdates = {};
        if (org?.phone) billingUpdates.phone = org.phone;
        const address = buildStripeAddress(org);
        if (address) billingUpdates.address = address;
        if (Object.keys(billingUpdates).length > 0) {
            await stripe.customers.update(customerId, billingUpdates);
        }
    } catch (e) {
        log.warn(`[Stripe] syncing billing address for org ${orgId} failed: ${/** @type {Error} */ (e).message}`);
    }
}

/**
 * ONE Stripe customer per org, so repeated checkout attempts (before the
 * first one activates) don't mint duplicates: the stored id, else a search
 * by metadata.beeflow_org_id, else a new one. It is stored at once, so the
 * next attempt reuses it without the search index or the activation
 * webhook. The org's VAT and billing address go onto it, so Stripe Tax can
 * apply reverse charge (EU B2B) without the admin re-entering the number.
 * Any failure here leaves the customer found so far (or none: Checkout then
 * collects the e-mail).
 * @param {StripeClient} stripe
 * @param {{ orgId: string, orgName?: string, userEmail: string, stripeCustomerId?: string }} ctx
 */
async function resolveOrgCustomer(stripe, { orgId, orgName, userEmail, stripeCustomerId }) {
    let customerId = stripeCustomerId || null;
    try {
        const userStore = deps.userStore();
        const org = await userStore.getOrganization(orgId);
        if (!customerId) customerId = await searchOrgCustomer(stripe, orgId);
        if (!customerId) {
            const created = await stripe.customers.create({
                name: orgName || org?.name || undefined,
                email: userEmail || org?.email || undefined,
                metadata: { beeflow_org_id: orgId },
            });
            customerId = created.id;
        }
        if (customerId) {
            try { assertStored(await userStore.setOrgSubscription(orgId, { stripe_customer_id: customerId }), `Stripe customer id of organization ${orgId}`); }
            catch (e) { bestEffort('stripe/checkout:persistCustomerId', e); }
        }
        await attachOrgVat(stripe, customerId, org, orgId);
        if (customerId) await syncOrgBillingAddress(stripe, customerId, org, orgId);
    } catch (e) {
        log.warn(`[Stripe] org customer resolution skipped: ${/** @type {Error} */ (e).message}`);
    }
    return customerId;
}

/**
 * A trial, or a billing cycle anchored to the 1st of next month (UTC) so every
 * paying subscription renews on the same day. Stripe rejects
 * billing_cycle_anchor together with trial_period_days (the trial end IS the
 * anchor). `create_prorations` charges the partial period up to the anchor,
 * which matters for per-seat plans entering mid-cycle.
 * @param {Record<string, unknown>} subscriptionData
 * @param {DbRow.SubscriptionPlans} plan
 */
function applyTrialOrAnchor(subscriptionData, plan) {
    if (plan.trial_days && plan.trial_days > 0) {
        subscriptionData.trial_period_days = plan.trial_days;
    } else {
        subscriptionData.billing_cycle_anchor = computeBillingCycleAnchor();
        subscriptionData.proration_behavior = 'create_prorations';
    }
}

/**
 * Stripe Tax: a billing address, and VAT numbers for B2B customers we did not
 * pre-attach one for. With a customer attached, Stripe Tax needs the address
 * ON that customer, which billing_address_collection alone does not write
 * back: customer_update does (invalid alongside customer_email). Without it
 * the session is rejected ("Automatic tax calculation in Checkout requires a
 * valid address on the Customer").
 * @param {Record<string, unknown>} sessionParams
 */
function applyTaxCollection(sessionParams) {
    sessionParams.automatic_tax = { enabled: true };
    sessionParams.billing_address_collection = 'required';
    sessionParams.tax_id_collection = { enabled: true };
    if (sessionParams.customer) {
        sessionParams.customer_update = { address: 'auto', name: 'auto' };
    }
}

/**
 * Create a Stripe Checkout Session for a plan.
 * Supports both organization and consumer subscriptions.
 *
 * `options`: `plan` is the BeeFlow plan row; `orgId`/`orgName` are set for an
 * org checkout, `userId` for a consumer checkout; `subscriberType` is
 * 'organization' (default) or 'consumer'; `userEmail` pre-fills the form;
 * `successUrl`/`cancelUrl` are the redirect URLs; `stripeCustomerId` an
 * existing Stripe customer ID.
 *
 * @param {{ plan: DbRow.SubscriptionPlans, orgId?: string | null, orgName?: string | null, userId?: string | null,
 *   subscriberType?: 'organization' | 'consumer' | string, userEmail?: string, successUrl: string, cancelUrl: string,
 *   stripeCustomerId?: string | null }} options
 * @returns {Promise<import('stripe').Checkout.Session>} Stripe Checkout Session
 */
async function createCheckoutSession({ plan, orgId, orgName, userId, subscriberType = 'organization', userEmail, successUrl, cancelUrl, stripeCustomerId }) {
    const stripe = await getClient();

    if (!plan.stripe_price_id) {
        throw new Error('Plan has not been synced to Stripe yet. Ask your administrator to sync the plan.');
    }

    const isConsumer = subscriberType === 'consumer';
    const metadata = {
        beeflow_plan_id: plan.id,
        beeflow_subscriber_type: subscriberType,
        ...(isConsumer ? { beeflow_user_id: userId } : { beeflow_org_id: orgId }),
    };
    const quantity = await billedSeatCount(plan, isConsumer, orgId);

    /** @type {Record<string, any>} */
    const sessionParams = {
        mode: 'subscription',
        line_items: [{ price: plan.stripe_price_id, quantity }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        client_reference_id: isConsumer ? userId : orgId,
        metadata,
        subscription_data: { metadata },
    };

    // An existing customer (for an org possibly just created with its VAT),
    // else the e-mail, and Stripe creates the customer at checkout.
    const customerId = !isConsumer && orgId
        ? await resolveOrgCustomer(stripe, { orgId, orgName, userEmail, stripeCustomerId })
        : stripeCustomerId || null;
    if (customerId) {
        sessionParams.customer = customerId;
    } else {
        sessionParams.customer_email = userEmail;
    }

    applyTrialOrAnchor(sessionParams.subscription_data, plan);
    if (await deps.configStore.getConfig('stripe_tax_enabled')) applyTaxCollection(sessionParams);

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
 * @returns {Promise<import('stripe').BillingPortal.Session>} Portal session with url
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
