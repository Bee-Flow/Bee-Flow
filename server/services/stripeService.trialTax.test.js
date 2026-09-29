/**
 * BFSF-250 — automatic_tax on trial subscriptions + the enable-toggle backfill.
 *
 * Trial-started subscriptions never set automatic_tax, so they billed without
 * the 21% BTW breakdown forever (a Wet OB 1968 compliance gap for Dutch B2B),
 * while checkout-started subscriptions taxed correctly. Pins: the tax flag is
 * only sent when stripe_tax_enabled AND a billing address exists (Stripe
 * rejects it otherwise); the backfill updates active/trialing rows, skips
 * failures without throwing, and reports counts.
 *
 * Run: cd server && node --test services/stripeService.trialTax.test.js
 */

const assert = require('assert');
const { test } = require('node:test');

// ── Fixtures ─────────────────────────────────────────────────────────
let configFixture = {};
let orgFixture = null;
const subCreates = [];
const subUpdates = [];
let orgSubs = [];
let consumerSubs = [];
let failUpdateFor = null;

function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

stub('../stores/configStore', {
    getSecret: async (key) => (key === 'stripe_secret_key' ? 'sk_test_fake' : null),
    getConfig: async (key) => configFixture[key],
});

stub('../stores/userStore', {
    getOrganization: async () => orgFixture,
    getAllOrgSubscriptions: async () => orgSubs,
    getAllConsumerSubscriptions: async () => consumerSubs,
});

stub('stripe', function FakeStripe() {
    return {
        customers: {
            create: async () => ({ id: 'cus_new' }),
            update: async () => ({}),
        },
        subscriptions: {
            create: async (params) => { subCreates.push(params); return { id: 'sub_1', status: 'trialing', trial_end: 1789999999 }; },
            update: async (id, params) => {
                if (id === failUpdateFor) throw new Error('customer has no address');
                subUpdates.push({ id, params });
                return { id };
            },
        },
        checkout: { sessions: { create: async () => ({ id: 'cs', url: 'u' }) } },
    };
});

const stripeService = require('./stripeService');

const PLAN = { id: 'p1', stripe_price_id: 'price_1', trial_days: 14 };

function reset() {
    configFixture = { stripe_tax_enabled: false };
    // buildStripeAddress requires billing_country and reads address/billing_*.
    orgFixture = { name: 'Org', email: 'o@x.nl', address: 'Straat 1', billing_city: 'Amsterdam', billing_postal_code: '1000AA', billing_country: 'NL' };
    subCreates.length = 0;
    subUpdates.length = 0;
    orgSubs = [];
    consumerSubs = [];
    failUpdateFor = null;
}

test('trial with tax enabled + org address → automatic_tax sent', async () => {
    reset();
    configFixture.stripe_tax_enabled = 'true';
    await stripeService.createTrialSubscription({ plan: PLAN, subscriberType: 'organization', subscriberId: 'orgA', orgName: 'Org', trialDays: 14 });
    assert.strictEqual(subCreates.length, 1);
    assert.deepStrictEqual(subCreates[0].automatic_tax, { enabled: true }, 'trial invoices now carry BTW lines after conversion');
});

test('tax disabled OR no address → automatic_tax omitted (Stripe would reject it)', async () => {
    reset();
    await stripeService.createTrialSubscription({ plan: PLAN, subscriberType: 'organization', subscriberId: 'orgA', orgName: 'Org', trialDays: 14 });
    assert.strictEqual(subCreates[0].automatic_tax, undefined, 'flag off → no tax field');

    reset();
    configFixture.stripe_tax_enabled = 'true';
    orgFixture = { name: 'Org' }; // no address fields
    await stripeService.createTrialSubscription({ plan: PLAN, subscriberType: 'organization', subscriberId: 'orgA', orgName: 'Org', trialDays: 14 });
    assert.strictEqual(subCreates[0].automatic_tax, undefined, 'address-less → skipped, not rejected by Stripe');
});

test('backfill enables tax on active/trialing rows, skips failures without throwing', async () => {
    reset();
    orgSubs = [
        { stripe_subscription_id: 'sub_a', status: 'active' },
        { stripe_subscription_id: 'sub_b', status: 'trialing' },
        { stripe_subscription_id: 'sub_c', status: 'cancelled' },  // ineligible
        { stripe_subscription_id: null, status: 'active' },        // no Stripe sub
    ];
    consumerSubs = [
        { stripe_subscription_id: 'sub_d', payment_status: 'paid' },
        { stripe_subscription_id: 'sub_e', status: 'active' },
    ];
    failUpdateFor = 'sub_e'; // Stripe rejects (customer without address)

    const result = await stripeService.enableAutomaticTaxForExistingSubscriptions();
    const updatedIds = subUpdates.map(u => u.id);
    assert.deepStrictEqual(updatedIds.sort(), ['sub_a', 'sub_b', 'sub_d'], 'eligible rows updated');
    assert.ok(subUpdates.every(u => u.params.automatic_tax.enabled === true));
    assert.strictEqual(result.updated, 3);
    assert.strictEqual(result.skipped, 1, 'the address-less customer is skipped, not fatal');
});
