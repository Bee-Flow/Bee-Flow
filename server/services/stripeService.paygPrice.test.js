/**
 * PAYG metered Price — the per-meter-unit amount must be in CENTS.
 *
 * The regression this guards: syncPaygPlanToStripe created the metered Price
 * with `unit_amount_decimal: '0.000001'`. Stripe denominates that field in the
 * smallest currency unit (cents) — the fixed-plan sync in the same file proves
 * the codebase knows this (`unit_amount: Math.round(plan.price * 100)`), so the
 * value meant 1e-6 cents = 1e-8 EUR per meter unit. usageStore.logUsage reports
 * `Math.round(billedCost * 1_000_000)` meter units, so 1.00 EUR of consumed AI
 * usage was invoiced as 1 cent — every PAYG customer collected at 1% (or 0%,
 * once the total fell under Stripe's minimum charge amount). One micro-EUR is
 * 1e-4 cents, i.e. '0.0001'.
 *
 * DB-free and Stripe-free: the `stripe` module and configStore are stubbed and
 * we assert on the object handed to prices.create.
 *
 * Run: cd server && node --test services/stripeService.paygPrice.test.js
 */

const assert = require('assert');
const { test } = require('node:test');

const { installResolveStub } = require('../testUtils/stubRequire');

const priceCreates = [];
const priceUpdates = [];

const restore = installResolveStub({
    '../stores/configStore': {
        getSecret: async (k) => (k === 'stripe_secret_key' ? 'sk_test_fake' : null),
        getConfig: async (k) => (k === 'stripe_payg_meter_id' ? 'mtr_1' : null),
        setConfig: async () => { },
    },
    'stripe': function FakeStripe() {
        return {
            products: {
                create: async (d) => ({ id: 'prod_1', ...d }),
                update: async (id, d) => ({ id, ...d }),
            },
            prices: {
                create: async (d) => { priceCreates.push(d); return { id: 'price_new' }; },
                update: async (id, d) => { priceUpdates.push({ id, d }); return { id }; },
            },
            billing: {
                meters: {
                    retrieve: async () => ({ id: 'mtr_1', event_name: 'beeflow_payg_usage' }),
                    create: async () => ({ id: 'mtr_1', event_name: 'beeflow_payg_usage' }),
                },
            },
        };
    },
});

const stripeService = require('./stripeService');

test.after(() => restore());
test.beforeEach(() => { priceCreates.length = 0; priceUpdates.length = 0; });

const paygPlan = (extra = {}) => ({
    id: 'plan_payg',
    name: 'Pay as you go',
    currency: 'eur',
    billing_model: 'metered',
    billing_interval: 'monthly',
    ...extra,
});

test('a metered Price bills one micro-unit of currency per meter unit', async () => {
    await stripeService.syncPaygPlanToStripe(paygPlan());

    assert.strictEqual(priceCreates.length, 1, 'exactly one Price created');
    const price = priceCreates[0];
    assert.strictEqual(price.unit_amount_decimal, '0.0001',
        'unit_amount_decimal is in cents: 1e-6 EUR = 1e-4 cents');
    assert.strictEqual(price.billing_scheme, 'per_unit');
    assert.strictEqual(price.recurring.usage_type, 'metered');
    assert.strictEqual(price.recurring.meter, 'mtr_1');
});

test('1.00 EUR of consumed usage invoices 1.00 EUR, not 1 cent', async () => {
    await stripeService.syncPaygPlanToStripe(paygPlan());
    const perUnitCents = Number(priceCreates[0].unit_amount_decimal);

    // usageStore.logUsage enqueues Math.round(billedCost * 1_000_000) units.
    const meterUnits = Math.round(1.0 * 1_000_000);
    const invoicedEur = (meterUnits * perUnitCents) / 100;

    assert.ok(Math.abs(invoicedEur - 1.0) < 1e-9,
        `1.00 EUR of usage must invoice 1.00 EUR, got ${invoicedEur}`);
});

test('the exported constant is the single source of the per-unit amount', async () => {
    await stripeService.syncPaygPlanToStripe(paygPlan());
    assert.strictEqual(
        priceCreates[0].unit_amount_decimal,
        stripeService.PAYG_UNIT_AMOUNT_DECIMAL,
        'the Price uses the exported constant',
    );
});

test('the previous metered Price is archived when it differs', async () => {
    await stripeService.syncPaygPlanToStripe(paygPlan({ stripe_price_id: 'price_old' }));
    assert.deepStrictEqual(
        priceUpdates.map(u => [u.id, u.d.active]),
        [['price_old', false]],
        'Stripe prices are immutable — the stale one is deactivated',
    );
});
