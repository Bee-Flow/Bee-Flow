/**
 * Characterisation (golden) test for services/stripeService.js.
 *
 * Pins the Stripe calls, their order and their parameters for the main flows
 * (client caching, plan + PAYG sync, org checkout with customer resolution,
 * VAT and address sync, trial, seat sync, plan switch, downgrade schedule,
 * invoices, promo codes, webhook verification) so the module can be split
 * into services/stripe/* without any observable change.
 *
 * The `stripe` SDK, configStore and userStore are replaced in require.cache by
 * their RESOLVED filename, so the stubs hold no matter which relative path a
 * (split) module uses to require them.
 *
 * Run: cd server && node --test services/stripeService.characterisation.test.js
 */

const assert = require('node:assert');
const { test, beforeEach } = require('node:test');

// ── Fixtures ────────────────────────────────────────────────────────────────
let config = {};
let secrets = {};
let org = null;
let orgSub = null;
let plans = {};
let seatCount = 1;
let calls = [];
let responses = {};
let stripeCtorCalls = [];
const setConfigCalls = [];
const setOrgSubCalls = [];

function reset() {
    config = {};
    secrets = { stripe_secret_key: 'sk_test_abc', stripe_webhook_secret: 'whsec_1' };
    org = null;
    orgSub = null;
    plans = {};
    seatCount = 1;
    calls = [];
    responses = {};
    setConfigCalls.length = 0;
    setOrgSubCalls.length = 0;
}

function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

stub('../stores/configStore', {
    getSecret: async (k) => secrets[k] ?? null,
    getConfig: async (k) => config[k],
    setConfig: async (k, v) => { setConfigCalls.push([k, v]); config[k] = v; },
});

stub('../stores/userStore', {
    getOrganization: async () => org,
    getOrgSubscription: async () => orgSub,
    setOrgSubscription: async (id, patch) => { setOrgSubCalls.push([id, patch]); },
    getPlan: async (id) => plans[id] || null,
    getActiveSeatCount: async () => seatCount,
    getAllOrgSubscriptions: async () => [],
    getAllConsumerSubscriptions: async () => [],
});

// Recording fake SDK: every leaf call is logged as [dotted.path, ...args] and
// answered from `responses[path]` (a value or a function of the args).
function recorder(prefix) {
    return new Proxy(function () { }, {
        get(_t, prop) {
            if (prop === 'then') return undefined;
            return recorder(prefix ? `${prefix}.${String(prop)}` : String(prop));
        },
        apply(_t, _this, args) {
            calls.push([prefix, ...args]);
            const r = responses[prefix];
            const out = typeof r === 'function' ? r(...args) : r;
            return prefix === 'webhooks.constructEvent' ? out : Promise.resolve(out);
        },
    });
}
stub('stripe', function FakeStripe(key, opts) {
    stripeCtorCalls.push([key, opts]);
    return recorder('');
});

const svc = require('./stripeService');

beforeEach(reset);

test('export surface is stable', () => {
    assert.deepStrictEqual(Object.keys(svc), [
        'getClient', 'isEnabled', 'isTestMode', 'escapeSearchValue', 'syncPlanToStripe',
        'ensurePaygMeter', 'syncPaygPlanToStripe', 'PAYG_UNIT_AMOUNT_DECIMAL', 'reportPaygUsage',
        'listLiveSubscriptions', 'LIVE_SUBSCRIPTION_STATUSES', 'createCheckoutSession',
        'createTrialSubscription', 'enableAutomaticTaxForExistingSubscriptions',
        'pushOrgBillingToStripe', 'createPortalSession', 'listInvoices', 'getInvoicePdf',
        'retrieveCheckoutSession', 'syncSeatQuantityForOrg', 'updateSubscriptionPlan',
        'previewPlanChange', 'scheduleDowngradeAtPeriodEnd', 'releaseSubscriptionSchedule',
        'cancelSubscriptionAtPeriodEnd', 'reactivateSubscription', 'constructWebhookEvent',
        'createPromoCode', 'listPromoCodes', 'deactivatePromoCode', 'activatePromoCode',
    ]);
    assert.deepStrictEqual(svc.LIVE_SUBSCRIPTION_STATUSES, ['active', 'trialing', 'past_due', 'unpaid', 'paused']);
    assert.ok(Object.isFrozen(svc.LIVE_SUBSCRIPTION_STATUSES));
});

test('getClient caches per key and rebuilds when the key changes', async () => {
    stripeCtorCalls = [];
    secrets.stripe_secret_key = 'sk_test_cache_1';
    const a = await svc.getClient();
    const b = await svc.getClient();
    assert.strictEqual(a, b);
    secrets.stripe_secret_key = 'sk_live_cache_2_different';
    const c = await svc.getClient();
    assert.notStrictEqual(a, c);
    assert.equal(stripeCtorCalls.length, 2);
    assert.deepStrictEqual(stripeCtorCalls[0][1], { apiVersion: process.env.STRIPE_API_VERSION || '2024-12-18.acacia', appInfo: { name: 'BeeFlow', version: '1.0.0' } });
    secrets.stripe_secret_key = null;
    await assert.rejects(svc.getClient(), /Stripe secret key not configured/);
});

test('isEnabled / isTestMode', async () => {
    assert.equal(await svc.isEnabled(), false);
    config.stripe_enabled = true;
    assert.equal(await svc.isEnabled(), true);
    secrets.stripe_secret_key = null;
    assert.equal(await svc.isEnabled(), false);
    assert.equal(await svc.isTestMode(), false);
    secrets.stripe_secret_key = 'sk_test_x';
    assert.equal(await svc.isTestMode(), true);
});

test('syncPlanToStripe: update product, create taxed price, archive old, set default', async () => {
    config.stripe_tax_enabled = true;
    responses['products.update'] = (id) => ({ id });
    responses['prices.create'] = () => ({ id: 'price_new' });
    const out = await svc.syncPlanToStripe({
        id: 'p1', name: 'Pro', price: 9.99, currency: 'EUR', billing_interval: 'yearly',
        stripe_product_id: 'prod_1', stripe_price_id: 'price_old', max_users: 5,
    });
    assert.deepStrictEqual(out, { productId: 'prod_1', priceId: 'price_new' });
    assert.deepStrictEqual(calls, [
        ['products.update', 'prod_1', { name: 'Pro', description: 'BeeFlow Pro Plan', metadata: { beeflow_plan_id: 'p1', max_messages: '-1', max_users: '5', max_agents: '-1' } }],
        ['prices.create', { product: 'prod_1', currency: 'eur', unit_amount: 999, recurring: { interval: 'year' }, metadata: { beeflow_plan_id: 'p1' }, tax_behavior: 'exclusive' }],
        ['prices.update', 'price_old', { active: false }],
        ['products.update', 'prod_1', { default_price: 'price_new' }],
    ]);
});

test('syncPlanToStripe: missing product is recreated', async () => {
    responses['products.update'] = (id, d) => {
        if (!d.default_price) { const e = new Error('gone'); e.code = 'resource_missing'; throw e; }
        return { id };
    };
    responses['products.create'] = () => ({ id: 'prod_new' });
    responses['prices.create'] = () => ({ id: 'price_x' });
    const out = await svc.syncPlanToStripe({ id: 'p2', name: 'B', stripe_product_id: 'prod_dead' });
    assert.deepStrictEqual(out, { productId: 'prod_new', priceId: 'price_x' });
    assert.deepStrictEqual(calls.map(c => c[0]), ['products.update', 'products.create', 'prices.create', 'products.update']);
});

test('ensurePaygMeter creates and caches when no meter id is stored', async () => {
    responses['billing.meters.create'] = () => ({ id: 'mtr_9', event_name: 'beeflow_payg_usage' });
    const m = await svc.ensurePaygMeter();
    assert.equal(m.id, 'mtr_9');
    assert.deepStrictEqual(setConfigCalls, [['stripe_payg_meter_id', 'mtr_9'], ['stripe_payg_meter_event_name', 'beeflow_payg_usage']]);
    assert.equal(calls[0][0], 'billing.meters.create');
});

test('reportPaygUsage posts a meter event', async () => {
    await svc.reportPaygUsage({ stripeCustomerId: 'cus_1', amountMicroUnits: 1234, identifier: 'row1', eventName: 'ev' });
    assert.equal(calls[0][0], 'billing.meterEvents.create');
    const p = calls[0][1];
    assert.equal(p.event_name, 'ev');
    assert.equal(p.identifier, 'row1');
    assert.deepStrictEqual(p.payload, { stripe_customer_id: 'cus_1', value: '1234' });
    assert.equal(typeof p.timestamp, 'number');
});

test('listLiveSubscriptions filters on live statuses', async () => {
    assert.deepStrictEqual(await svc.listLiveSubscriptions(null), []);
    responses['subscriptions.list'] = () => ({ data: [{ id: 's1', status: 'active' }, { id: 's2', status: 'incomplete' }, { id: 's3', status: 'paused', x: 1 }] });
    assert.deepStrictEqual(await svc.listLiveSubscriptions('cus_1'), [{ id: 's1', status: 'active' }, { id: 's3', status: 'paused' }]);
    assert.deepStrictEqual(calls[0], ['subscriptions.list', { customer: 'cus_1', status: 'all', limit: 100 }]);
});

test('createCheckoutSession (org, per-seat, VAT, address, tax) — call order and session params', async () => {
    config.stripe_tax_enabled = true;
    seatCount = 4;
    org = { name: 'Acme', email: 'a@acme.nl', phone: '+31', vat: 'nl 123.456.789.B01', address: 'Main 1', billing_city: 'Utrecht', billing_postal_code: '1234AB', billing_country: 'nl' };
    responses['customers.search'] = () => ({ data: [] });
    responses['customers.create'] = () => ({ id: 'cus_new' });
    responses['customers.listTaxIds'] = () => ({ data: [] });
    responses['checkout.sessions.create'] = (p) => ({ id: 'cs_1', p });
    const plan = { id: 'p1', stripe_price_id: 'price_1', per_seat: true, billing_interval: 'monthly' };
    const out = await svc.createCheckoutSession({ plan, orgId: "o'1", orgName: 'Acme BV', userEmail: 'u@acme.nl', successUrl: 's', cancelUrl: 'c' });
    assert.equal(out.id, 'cs_1');
    assert.deepStrictEqual(calls.map(c => c[0]), ['customers.search', 'customers.create', 'customers.listTaxIds', 'customers.createTaxId', 'customers.update', 'checkout.sessions.create']);
    assert.deepStrictEqual(calls[0][1], { query: "metadata['beeflow_org_id']:'o\\'1'", limit: 1 });
    assert.deepStrictEqual(calls[1][1], { name: 'Acme BV', email: 'u@acme.nl', metadata: { beeflow_org_id: "o'1" } });
    assert.deepStrictEqual(calls[3].slice(1), ['cus_new', { type: 'eu_vat', value: 'NL123456789B01' }]);
    assert.deepStrictEqual(calls[4].slice(1), ['cus_new', { phone: '+31', address: { country: 'NL', line1: 'Main 1', postal_code: '1234AB', city: 'Utrecht' } }]);
    assert.deepStrictEqual(setOrgSubCalls, [["o'1", { stripe_customer_id: 'cus_new' }]]);
    const p = calls[5][1];
    const md = { beeflow_plan_id: 'p1', beeflow_subscriber_type: 'organization', beeflow_org_id: "o'1" };
    assert.equal(typeof p.subscription_data.billing_cycle_anchor, 'number');
    assert.deepStrictEqual({ ...p, subscription_data: { ...p.subscription_data, billing_cycle_anchor: 'X' } }, {
        mode: 'subscription',
        line_items: [{ price: 'price_1', quantity: 4 }],
        success_url: 's',
        cancel_url: 'c',
        client_reference_id: "o'1",
        metadata: md,
        subscription_data: { metadata: md, billing_cycle_anchor: 'X', proration_behavior: 'create_prorations' },
        customer: 'cus_new',
        automatic_tax: { enabled: true },
        billing_address_collection: 'required',
        tax_id_collection: { enabled: true },
        customer_update: { address: 'auto', name: 'auto' },
        allow_promotion_codes: true,
        locale: 'auto',
        custom_text: { submit: { message: 'Maandabonnement met automatische incasso: je gekozen betaalmethode wordt elke maand automatisch belast tot je opzegt. — Recurring monthly subscription, billed automatically each month until you cancel.' } },
    });
    const anchor = new Date(p.subscription_data.billing_cycle_anchor * 1000);
    assert.equal(anchor.getUTCDate(), 1);
});

test('createCheckoutSession: stored customer + existing VAT skip search/create/createTaxId', async () => {
    org = { name: 'Acme', vat: 'DE123456789' };
    responses['customers.listTaxIds'] = () => ({ data: [{ type: 'eu_vat', value: 'DE123456789' }] });
    responses['checkout.sessions.create'] = () => ({ id: 'cs_2' });
    await svc.createCheckoutSession({ plan: { id: 'p', stripe_price_id: 'pr', trial_days: 7 }, orgId: 'o2', userEmail: 'e', successUrl: 's', cancelUrl: 'c', stripeCustomerId: 'cus_old' });
    assert.deepStrictEqual(calls.map(c => c[0]), ['customers.listTaxIds', 'checkout.sessions.create']);
    const p = calls[1][1];
    assert.equal(p.customer, 'cus_old');
    assert.equal(p.subscription_data.trial_period_days, 7);
    assert.equal(p.subscription_data.billing_cycle_anchor, undefined);
    assert.equal(p.automatic_tax, undefined);
});

test('createCheckoutSession refuses an unsynced plan', async () => {
    await assert.rejects(svc.createCheckoutSession({ plan: { id: 'p' } }), /has not been synced/);
});

test('pushOrgBillingToStripe pushes name/email/phone/address to the subscription customer', async () => {
    org = { name: 'Acme', email: 'a@b', billingCountry: 'be', billingCity: 'Gent' };
    orgSub = { stripe_customer_id: 'cus_7' };
    await svc.pushOrgBillingToStripe('o1');
    assert.deepStrictEqual(calls, [['customers.update', 'cus_7', { name: 'Acme', email: 'a@b', address: { country: 'BE', city: 'Gent' } }]]);
    calls = [];
    orgSub = null;
    await svc.pushOrgBillingToStripe('o1');
    assert.deepStrictEqual(calls, []);
});

test('createTrialSubscription: new customer with address, taxed trial params', async () => {
    config.stripe_tax_enabled = true;
    org = { name: 'Acme', email: 'a@b', phone: '+1', billing_country: 'NL' };
    responses['customers.create'] = () => ({ id: 'cus_t' });
    responses['subscriptions.create'] = () => ({ id: 'sub_t', status: 'trialing', trial_end: 1700000000 });
    const out = await svc.createTrialSubscription({ plan: { id: 'p', stripe_price_id: 'pr' }, subscriberType: 'organization', subscriberId: 'o1', trialDays: 14 });
    assert.deepStrictEqual(out, { stripeCustomerId: 'cus_t', stripeSubscriptionId: 'sub_t', trialEnd: new Date(1700000000 * 1000).toISOString(), status: 'trialing' });
    const md = { beeflow_plan_id: 'p', beeflow_subscriber_type: 'organization', beeflow_org_id: 'o1' };
    assert.deepStrictEqual(calls, [
        ['customers.create', { email: 'a@b', name: 'Acme', phone: '+1', address: { country: 'NL' }, metadata: md }],
        ['subscriptions.create', {
            customer: 'cus_t', items: [{ price: 'pr' }], trial_period_days: 14,
            trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
            payment_behavior: 'default_incomplete',
            payment_settings: { save_default_payment_method: 'on_subscription' },
            automatic_tax: { enabled: true }, metadata: md,
        }],
    ]);
});

test('syncSeatQuantityForOrg updates only when the quantity differs', async () => {
    config.stripe_enabled = true;
    orgSub = { stripe_subscription_id: 'sub_1', plan_id: 'p' };
    plans.p = { per_seat: true };
    seatCount = 3;
    responses['subscriptions.retrieve'] = () => ({ items: { data: [{ id: 'si_1', quantity: 2 }] } });
    await svc.syncSeatQuantityForOrg('o1');
    assert.deepStrictEqual(calls[1], ['subscriptions.update', 'sub_1', { items: [{ id: 'si_1', quantity: 3 }], proration_behavior: 'create_prorations' }]);
    calls = [];
    seatCount = 2;
    await svc.syncSeatQuantityForOrg('o1');
    assert.deepStrictEqual(calls.map(c => c[0]), ['subscriptions.retrieve']);
});

test('plan switch, preview, cancel, reactivate', async () => {
    responses['subscriptions.retrieve'] = () => ({ items: { data: [{ id: 'si_1', price: { currency: 'usd' } }] } });
    responses['subscriptions.update'] = (id, p) => ({ id, p });
    await svc.updateSubscriptionPlan({ stripeSubscriptionId: 'sub_1', newPriceId: 'pr_2', quantity: 0 });
    assert.deepStrictEqual(calls[1], ['subscriptions.update', 'sub_1', { items: [{ id: 'si_1', price: 'pr_2', quantity: 1 }], proration_behavior: 'always_invoice', billing_cycle_anchor: 'unchanged', payment_behavior: 'error_if_incomplete' }]);
    calls = [];
    responses['invoices.createPreview'] = () => ({ lines: { data: [{ proration: true, amount: 500 }, { proration: false, amount: 9999 }, { proration: true, amount: -200 }] } });
    assert.deepStrictEqual(await svc.previewPlanChange({ stripeSubscriptionId: 'sub_1', newPriceId: 'pr_2', quantity: 2 }), { proration_amount: 3, currency: 'USD' });
    assert.deepStrictEqual(calls[1], ['invoices.createPreview', { subscription: 'sub_1', subscription_details: { items: [{ id: 'si_1', price: 'pr_2', quantity: 2 }], proration_behavior: 'always_invoice' } }]);
    calls = [];
    await svc.cancelSubscriptionAtPeriodEnd('sub_1');
    await svc.reactivateSubscription('sub_1');
    assert.deepStrictEqual(calls, [['subscriptions.update', 'sub_1', { cancel_at_period_end: true }], ['subscriptions.update', 'sub_1', { cancel_at_period_end: false }]]);
});

test('scheduleDowngradeAtPeriodEnd builds a two-phase release schedule', async () => {
    responses['subscriptions.retrieve'] = () => ({ schedule: null, items: { data: [{ id: 'si_1' }] } });
    responses['subscriptionSchedules.create'] = () => ({ id: 'sch_1' });
    responses['subscriptionSchedules.retrieve'] = () => ({ phases: [{ start_date: 100, end_date: 200, items: [{ price: 'pr_old', quantity: 3 }] }] });
    responses['subscriptionSchedules.update'] = () => ({ phases: [{}, { start_date: 200 }] });
    const out = await svc.scheduleDowngradeAtPeriodEnd({ stripeSubscriptionId: 'sub_1', newPriceId: 'pr_new', quantity: 2 });
    assert.deepStrictEqual(out, { scheduleId: 'sch_1', effective: new Date(200000).toISOString() });
    assert.deepStrictEqual(calls.map(c => c[0]), ['subscriptions.retrieve', 'subscriptionSchedules.create', 'subscriptionSchedules.retrieve', 'subscriptionSchedules.update']);
    assert.deepStrictEqual(calls[3][2], {
        end_behavior: 'release',
        phases: [
            { items: [{ price: 'pr_old', quantity: 3 }], start_date: 100, end_date: 200, proration_behavior: 'none' },
            { items: [{ price: 'pr_new', quantity: 2 }], proration_behavior: 'none' },
        ],
    });
    calls = [];
    responses['subscriptionSchedules.release'] = () => { throw new Error('nope'); };
    assert.equal(await svc.releaseSubscriptionSchedule('sch_1'), null);
    assert.equal(await svc.releaseSubscriptionSchedule(null), null);
    assert.equal(calls.length, 1);
});

test('portal, session retrieve, invoices list and PDF ownership guard', async () => {
    await svc.createPortalSession('cus_1', 'https://r');
    await svc.retrieveCheckoutSession('cs_1');
    assert.deepStrictEqual(calls, [
        ['billingPortal.sessions.create', { customer: 'cus_1', return_url: 'https://r' }],
        ['checkout.sessions.retrieve', 'cs_1', { expand: ['subscription', 'customer'] }],
    ]);
    assert.deepStrictEqual(await svc.listInvoices(null), []);
    responses['invoices.list'] = () => ({ data: [
        { id: 'in_d', status: 'draft' },
        { id: 'in_1', number: 'N1', created: 1700000000, amount_paid: 1210, amount_due: 0, currency: 'eur', status: 'paid', hosted_invoice_url: 'h', invoice_pdf: 'p' },
    ] });
    assert.deepStrictEqual(await svc.listInvoices('cus_1', { limit: 5 }), [{
        id: 'in_1', number: 'N1', created: new Date(1700000000000).toISOString(), amountPaid: 12.1, amountDue: 0,
        currency: 'EUR', status: 'paid', hostedInvoiceUrl: 'h', invoicePdf: 'p',
    }]);
    responses['invoices.retrieve'] = () => ({ customer: { id: 'cus_other' }, invoice_pdf: 'https://pdf' });
    await assert.rejects(svc.getInvoicePdf('in_1', { customerId: 'cus_1' }), (e) => e.code === 'invoice_forbidden');
    responses['invoices.retrieve'] = () => ({ customer: 'cus_1', number: 'N9', invoice_pdf: 'https://pdf' });
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2]).buffer });
    try {
        const pdf = await svc.getInvoicePdf('in_1', { customerId: 'cus_1' });
        assert.deepStrictEqual({ ...pdf, buffer: [...pdf.buffer] }, { buffer: [1, 2], number: 'N9', filename: 'invoice-N9.pdf' });
    } finally { globalThis.fetch = origFetch; }
});

test('constructWebhookEvent verifies with the configured secret', async () => {
    responses['webhooks.constructEvent'] = () => ({ id: 'evt_1' });
    assert.deepStrictEqual(await svc.constructWebhookEvent('raw', 'sig'), { id: 'evt_1' });
    assert.deepStrictEqual(calls, [['webhooks.constructEvent', 'raw', 'sig', 'whsec_1']]);
    secrets.stripe_webhook_secret = null;
    await assert.rejects(svc.constructWebhookEvent('raw', 'sig'), /Webhook signing secret not configured/);
});

test('promo codes: create, list, (de)activate', async () => {
    responses['coupons.create'] = () => ({ id: 'cp_1' });
    responses['promotionCodes.create'] = (p) => ({ id: 'promo_1', code: p.code });
    const out = await svc.createPromoCode({ code: 'launch 20', discountType: 'fixed', discountValue: 500, currency: 'EUR', duration: 'repeating', durationMonths: 3, maxRedemptions: 10, expiresAt: '2030-01-01T00:00:00Z', firstTimeOnly: true, minAmount: 1000 });
    assert.deepStrictEqual(out, { couponId: 'cp_1', promoCodeId: 'promo_1', code: 'LAUNCH20' });
    assert.deepStrictEqual(calls, [
        ['coupons.create', { duration: 'repeating', name: 'Promo: launch 20', metadata: { beeflow_promo: 'true' }, amount_off: 500, currency: 'eur', duration_in_months: 3 }],
        ['promotionCodes.create', { coupon: 'cp_1', code: 'LAUNCH20', metadata: { beeflow_promo: 'true' }, max_redemptions: 10, expires_at: 1893456000, restrictions: { first_time_transaction: true, minimum_amount: 1000, minimum_amount_currency: 'eur' } }],
    ]);
    calls = [];
    responses['promotionCodes.list'] = () => ({ data: [{ id: 'promo_1', code: 'X', active: true, coupon: { id: 'cp', percent_off: 20, duration: 'once', name: 'n' }, created: 1700000000, restrictions: {} }] });
    const list = await svc.listPromoCodes();
    assert.deepStrictEqual(calls[0], ['promotionCodes.list', { limit: 25, expand: ['data.coupon'] }]);
    assert.deepStrictEqual(list[0], {
        id: 'promo_1', code: 'X', active: true, couponId: 'cp', discountType: 'percent', discountValue: 20,
        currency: 'eur', duration: 'once', durationMonths: undefined, maxRedemptions: undefined, timesRedeemed: undefined,
        expiresAt: null, firstTimeOnly: false, minAmount: null, name: 'n', created: new Date(1700000000000).toISOString(),
    });
    calls = [];
    await svc.deactivatePromoCode('promo_1');
    await svc.activatePromoCode('promo_1');
    assert.deepStrictEqual(calls, [['promotionCodes.update', 'promo_1', { active: false }], ['promotionCodes.update', 'promo_1', { active: true }]]);
});
