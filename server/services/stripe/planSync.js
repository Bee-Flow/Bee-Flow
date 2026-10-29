/**
 * Plan sync: fixed-price and pay-as-you-go (metered) plans as Stripe Product +
 * Price, the global PAYG Billing Meter, and PAYG meter events.
 */

const deps = require('./deps');
const { getClient } = require('./client');
const { bestEffort } = require('../../utils/bestEffort');

/**
 * Sync a BeeFlow subscription plan to Stripe as a Product + Price.
 * Creates new or updates existing based on stripe_product_id.
 * 
 * @param {DbRow.SubscriptionPlans} plan - The plan object from userStore.getPlan()
 * @returns {{ productId: string, priceId: string }}
 */
async function syncPlanToStripe(plan) {
    const stripe = await getClient();

    const productData = {
        name: plan.name,
        description: plan.description || `BeeFlow ${plan.name} Plan`,
        metadata: {
            beeflow_plan_id: plan.id,
            max_messages: String(plan.max_messages_per_month ?? -1),
            max_users: String(plan.max_users ?? -1),
            max_agents: String(plan.max_agents ?? -1),
        },
    };

    let product;
    if (plan.stripe_product_id) {
        // Update existing product
        try {
            product = await stripe.products.update(plan.stripe_product_id, productData);
        } catch (err) {
            if (err.code === 'resource_missing') {
                // Product was deleted in Stripe — create new
                product = await stripe.products.create(productData);
            } else {
                throw err;
            }
        }
    } else {
        product = await stripe.products.create(productData);
    }

    // Create new price (Stripe prices are immutable — always create new, archive old)
    const priceData = {
        product: product.id,
        currency: (plan.currency || 'eur').toLowerCase(),
        unit_amount: Math.round((plan.price || 0) * 100), // Convert to cents
        recurring: {
            interval: plan.billing_interval === 'yearly' ? 'year' : 'month',
        },
        metadata: { beeflow_plan_id: plan.id },
    };

    // Check for tax behavior
    const taxEnabled = await deps.configStore.getConfig('stripe_tax_enabled');
    if (taxEnabled) {
        priceData.tax_behavior = 'exclusive';
    }

    const price = await stripe.prices.create(priceData);

    // Archive old price if it was different
    if (plan.stripe_price_id && plan.stripe_price_id !== price.id) {
        try {
            await stripe.prices.update(plan.stripe_price_id, { active: false });
        } catch (err) { bestEffort('stripe/planSync:archiveOldPrice', err); }
    }

    // Set the new price as the product's default
    await stripe.products.update(product.id, { default_price: price.id });

    return { productId: product.id, priceId: price.id };
}

/**
 * Ensure the global PAYG Billing Meter exists. Used by every pay-as-you-go
 * Price as their `recurring.meter` reference. Idempotent — looks up the
 * cached ID from configStore first; if missing or stripe returns
 * `resource_missing`, creates a fresh one and caches both the meter id and
 * its event name so the runtime hot path (usageStore.logUsage) can post
 * meter events without an extra Stripe round-trip.
 */
async function ensurePaygMeter() {
    const stripe = await getClient();
    const cachedId = await deps.configStore.getConfig('stripe_payg_meter_id');
    if (cachedId) {
        try { return await stripe.billing.meters.retrieve(cachedId); }
        catch (err) {
            if (err.code !== 'resource_missing') throw err;
            // fall through to recreate
        }
    }
    const meter = await stripe.billing.meters.create({
        display_name: 'BeeFlow PAYG usage',
        event_name: 'beeflow_payg_usage',
        default_aggregation: { formula: 'sum' },
        customer_mapping: { type: 'by_id', event_payload_key: 'stripe_customer_id' },
        value_settings: { event_payload_key: 'value' },
    });
    await deps.configStore.setConfig('stripe_payg_meter_id', meter.id);
    await deps.configStore.setConfig('stripe_payg_meter_event_name', meter.event_name);
    return meter;
}

// Per-meter-unit price of a PAYG Price, in the smallest currency unit (cents),
// as Stripe's `unit_amount_decimal` requires. One meter unit is one micro-unit
// of the plan currency (usageStore.logUsage reports `billedCost * 1_000_000`),
// i.e. 1e-6 EUR — which is 1e-4 cents. Exported so the pricing contract can be
// asserted without a live Stripe account.
const PAYG_UNIT_AMOUNT_DECIMAL = '0.0001';

/**
 * Sync a PAYG (metered) plan to Stripe — parallel to syncPlanToStripe.
 * Creates / updates the Product, ensures the global meter, then creates a
 * metered Price priced at 1 micro-unit of the plan's currency per meter
 * unit. The caller (subscriptions.js) persists meterId / meterEventName
 * onto the plan row alongside stripe_product_id / stripe_price_id.
 */
async function syncPaygPlanToStripe(plan) {
    const stripe = await getClient();

    const productData = {
        name: plan.name,
        description: plan.description || `BeeFlow ${plan.name} Plan (Pay-as-you-go)`,
        metadata: {
            beeflow_plan_id: plan.id,
            beeflow_billing_model: 'metered',
            beeflow_markup_percent: String(plan.markup_percent ?? 0),
        },
    };

    let product;
    if (plan.stripe_product_id) {
        try {
            product = await stripe.products.update(plan.stripe_product_id, productData);
        } catch (err) {
            if (err.code === 'resource_missing') product = await stripe.products.create(productData);
            else throw err;
        }
    } else {
        product = await stripe.products.create(productData);
    }

    const meter = await ensurePaygMeter();

    const priceData = {
        product: product.id,
        currency: (plan.currency || 'eur').toLowerCase(),
        billing_scheme: 'per_unit',
        // 1 micro-unit of currency per meter unit. logUsage reports
        // marked-up cost * 1_000_000, so 1.00 EUR worth of usage = 1_000_000
        // meter units = 1.00 EUR billed.
        //
        // `unit_amount_decimal` is denominated in the SMALLEST currency unit
        // (cents), exactly like the `unit_amount: price * 100` the fixed-plan
        // sync above uses — so one micro-EUR is 1e-6 EUR = 1e-4 cents = 0.0001,
        // NOT 0.000001. The old value was 1e-6 cents and invoiced metered
        // customers 1% of the AI usage they actually consumed (and often 0%,
        // because the total fell under Stripe's minimum charge amount and got
        // carried forward). Stripe prices are immutable, so any metered plan
        // created before this fix must be re-synced via
        // POST /api/subscriptions/plans/:id/sync-stripe and its live
        // subscriptions migrated onto the new price.
        unit_amount_decimal: PAYG_UNIT_AMOUNT_DECIMAL,
        recurring: {
            interval: plan.billing_interval === 'yearly' ? 'year' : 'month',
            usage_type: 'metered',
            meter: meter.id,
        },
        metadata: { beeflow_plan_id: plan.id, beeflow_billing_model: 'metered' },
    };

    const taxEnabled = await deps.configStore.getConfig('stripe_tax_enabled');
    if (taxEnabled) priceData.tax_behavior = 'exclusive';

    const price = await stripe.prices.create(priceData);

    // Archive the previous metered price if it differs.
    if (plan.stripe_price_id && plan.stripe_price_id !== price.id) {
        try { await stripe.prices.update(plan.stripe_price_id, { active: false }); }
        catch (err) { bestEffort('stripe/planSync:archiveOldMeteredPrice', err); }
    }
    await stripe.products.update(product.id, { default_price: price.id });

    return { productId: product.id, priceId: price.id, meterId: meter.id, meterEventName: meter.event_name };
}

/**
 * Push a usage event to the PAYG meter. Called fire-and-forget from
 * usageStore.logUsage after each AI call.
 *
 * `amountMicroUnits` is the marked-up cost expressed in micro-units of the
 * plan's currency (cost * 1_000_000, rounded). `identifier` is the
 * ai_usage_log row id — Stripe uses it for 24h idempotency so accidental
 * double-fires don't double-bill.
 */
async function reportPaygUsage({ stripeCustomerId, amountMicroUnits, identifier, eventName }) {
    const stripe = await getClient();
    return stripe.billing.meterEvents.create({
        event_name: eventName,
        identifier,
        timestamp: Math.floor(Date.now() / 1000),
        payload: {
            stripe_customer_id: stripeCustomerId,
            value: String(amountMicroUnits),
        },
    });
}

module.exports = {
    syncPlanToStripe,
    ensurePaygMeter,
    syncPaygPlanToStripe,
    PAYG_UNIT_AMOUNT_DECIMAL,
    reportPaygUsage,
};
