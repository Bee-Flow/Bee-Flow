// @typecheck
/**
 * Starting a checkout is not a subscription. createCheckoutSession stores the
 * organisation's Stripe customer id at once, so a second attempt reuses the
 * customer; for an organisation WITHOUT a subscription row that write was an
 * INSERT, and a row inserted without a status is `active`. With no plan on it
 * every cap is empty, so an organisation that was blocked for having no
 * subscription could chat without limit after opening the Stripe page and
 * closing it again. The real stores and the real limit check, on PGlite; the
 * Stripe client answers from memory.
 *
 * Run: cd server && node --test services/stripe/checkout.unpaidRow.pg.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';
process.env.DEPLOYMENT_MODE = 'cloud';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { usePglitePool } = require('../../testUtils/pglitePool');
const { makeSwaps } = require('../../testUtils/swaps');

const { pg, close } = usePglitePool();
const { swap, restore } = makeSwaps();
const userStore = require('../../stores/userStore');
const stripeService = require('../stripeService');
const deps = require('./deps');
const { checkSubscriptionLimits } = require('../../core/entitlements/limits');

/** @type {Record<string, any>} */
let plans = {};
/** @type {Array<Record<string, any>>} */
let sessions = [];

/** @param {string} orgId */
const startCheckout = (orgId) => stripeService.createCheckoutSession({
    plan: plans.team, orgId, orgName: 'Acme', subscriberType: 'organization', userEmail: 'admin@example.test',
    successUrl: 'https://app.example.test/ok', cancelUrl: 'https://app.example.test/back',
});

before(async () => {
    await require('../../stores/user/schema').initDB();
    await pg.query(`INSERT INTO organizations (id, name) VALUES ('org_none', 'No subscription'), ('org_free', 'On the Free plan'), ('org_retry', 'No subscription, tries twice')`);
    plans = {
        free: await userStore.createPlan({ name: 'Free', price: 0, is_default: true, max_messages_per_month: 10 }),
        team: await userStore.createPlan({ name: 'Team', price: 20, stripe_price_id: 'price_A', stripe_product_id: 'prod_A' }),
    };
    assert.equal(await userStore.setOrgSubscription('org_free', { plan_id: plans.free.id, status: 'active' }), true);

    // The SDK client of a made-up key; every call the checkout makes is answered here.
    swap(deps, 'configStore', /** @type {any} */ ({ getSecret: async () => 'sk_test_made_up', getConfig: async () => null }));
    const stripe = await stripeService.getClient();
    /** @type {Array<{ id: string, metadata: Record<string, string> }>} */
    const customers = [];
    swap(stripe.customers, 'search', /** @type {any} */ (async (/** @type {{ query: string }} */ { query }) => (
        { data: customers.filter((c) => query === `metadata['beeflow_org_id']:'${c.metadata.beeflow_org_id}'`) })));
    swap(stripe.customers, 'create', /** @type {any} */ (async (/** @type {{ metadata: Record<string, string> }} */ { metadata }) => {
        customers.push({ id: `cus_${customers.length + 1}`, metadata });
        return customers[customers.length - 1];
    }));
    swap(stripe.customers, 'update', /** @type {any} */ (async () => ({})));
    swap(stripe.customers, 'listTaxIds', /** @type {any} */ (async () => ({ data: [] })));
    swap(stripe.checkout.sessions, 'create', /** @type {any} */ (async (/** @type {Record<string, any>} */ params) => {
        sessions.push(params);
        return { id: `cs_${sessions.length}`, url: 'https://checkout.example.test/pay' };
    }));
});
after(async () => { restore(); await close(); });

test('an organisation without a subscription has none after a checkout it only started', async () => {
    const blocked = await checkSubscriptionLimits('org_none', 'chat');
    assert.match(String(blocked), /does not have an active subscription/);

    sessions = [];
    await startCheckout('org_none');
    assert.equal(sessions.length, 1, 'the checkout itself is created');
    assert.match(sessions[0].customer, /^cus_/);

    assert.equal(await userStore.getOrgSubscription('org_none'), null);
    assert.equal(await checkSubscriptionLimits('org_none', 'chat'), blocked);
});

test('an organisation that has a subscription gets its Stripe customer stored at once, and keeps its plan', async () => {
    sessions = [];
    await startCheckout('org_free');
    const row = await userStore.getOrgSubscription('org_free');
    assert.deepEqual([row.stripe_customer_id, row.plan_id, row.status], [sessions[0].customer, plans.free.id, 'active']);

    // The second attempt reuses the stored customer.
    await stripeService.createCheckoutSession({
        plan: plans.team, orgId: 'org_free', orgName: 'Acme', subscriberType: 'organization', userEmail: 'admin@example.test',
        successUrl: 'https://app.example.test/ok', cancelUrl: 'https://app.example.test/back', stripeCustomerId: row.stripe_customer_id,
    });
    assert.equal(sessions[1].customer, row.stripe_customer_id);
});

// Nothing local remembers the customer of that started checkout, so Stripe is
// asked for it: the route's duplicate-subscription guard and the next attempt
// both need the customer a first checkout may have been paid on.
test('the customer of a checkout such an organisation started is found again at Stripe', async () => {
    sessions = [];
    await startCheckout('org_retry');
    assert.deepEqual(await stripeService.findOrgCustomerIds('org_retry'), [sessions[0].customer]);
    assert.deepEqual(await stripeService.findOrgCustomerIds('org_nobody'), []);

    await startCheckout('org_retry');
    assert.equal(sessions[1].customer, sessions[0].customer, 'the second attempt mints no second customer');
});
