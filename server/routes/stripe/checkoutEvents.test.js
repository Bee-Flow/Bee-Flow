/**
 * checkout.session.completed and the success-page reconcile take the
 * subscription's state from Stripe: an ended subscription is never assigned,
 * the reconcile needs it active or trialing and not older than the local one.
 *
 * Run: cd server && node --test routes/stripe/checkoutEvents.test.js
 */
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const userStore = require('../../stores/userStore');
const stripeService = require('../../services/stripeService');
const { handleCheckoutCompleted } = require('./checkoutEvents');

/** @type {Record<string, any>} */
const saved = {};
/** @param {any} obj @param {string} name @param {any} fn */
const patch = (obj, name, fn) => { const k = `${obj === userStore ? 'u' : 's'}:${name}`; if (!(k in saved)) saved[k] = [obj, name, obj[name]]; obj[name] = fn; };
afterEach(() => { for (const [k, [obj, name, v]] of Object.entries(saved)) { obj[name] = v; delete saved[k]; } });

/** @type {any[]} */
let writes;
/** @type {any} */
let stripeSub;
/** @type {any} */
let existingRow;
beforeEach(() => {
    writes = [];
    stripeSub = null;
    existingRow = null;
    patch(userStore, 'getOrgSubscription', async () => existingRow);
    patch(userStore, 'setOrgSubscription', async (/** @type {string} */ orgId, /** @type {any} */ data, /** @type {any} */ opts) => { writes.push({ orgId, data, opts }); return true; });
    patch(userStore, 'logSubscriptionAudit', async () => {});
    patch(userStore, 'getPlan', async () => null);
    patch(stripeService, 'getClient', async () => ({ subscriptions: { retrieve: async () => stripeSub } }));
});

const SESSION = { id: 'cs_1', metadata: { beeflow_org_id: 'org1', beeflow_plan_id: 'plan_pro' }, customer: 'cus_1', subscription: 'sub_1' };
const now = () => Math.floor(Date.now() / 1000);

test('an active subscription is assigned as active and paid', async () => {
    stripeSub = { id: 'sub_1', status: 'active', created: now() };
    assert.equal(await handleCheckoutCompleted(SESSION), true);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].data.status, 'active');
    assert.equal(writes[0].data.payment_status, 'paid');
});

test('a completed checkout resets stale limit overrides, also on the plan the org already had (BFSF-249)', async () => {
    stripeSub = { id: 'sub_1', status: 'active', created: now() };
    assert.equal(await handleCheckoutCompleted(SESSION), true);
    assert.deepEqual(writes[0].opts, { resetLimits: true });
});

test('a second run for the same Stripe subscription keeps the limit overrides an admin set in between', async () => {
    stripeSub = { id: 'sub_1', status: 'active', created: now() };
    existingRow = { stripe_subscription_id: 'sub_1' };
    assert.equal(await handleCheckoutCompleted(SESSION), true);
    assert.deepEqual(writes[0].opts, { resetLimits: false });
});

test('a different or empty stored subscription id still resets the limits', async () => {
    stripeSub = { id: 'sub_1', status: 'active', created: now() };
    existingRow = { stripe_subscription_id: 'sub_old' };
    await handleCheckoutCompleted(SESSION);
    existingRow = { stripe_subscription_id: null };
    await handleCheckoutCompleted(SESSION);
    assert.deepEqual(writes.map((w) => w.opts), [{ resetLimits: true }, { resetLimits: true }]);
});

test('a trialing subscription keeps its trial state', async () => {
    stripeSub = { id: 'sub_1', status: 'trialing', created: now(), trial_end: now() + 86400 };
    await handleCheckoutCompleted(SESSION);
    assert.equal(writes[0].data.status, 'trialing');
    assert.equal(writes[0].data.payment_status, 'trialing');
    assert.ok(writes[0].data.trial_end_date);
});

for (const status of ['canceled', 'incomplete_expired', 'unpaid']) {
    test(`a ${status} subscription is never assigned`, async () => {
        stripeSub = { id: 'sub_1', status, created: now() };
        assert.equal(await handleCheckoutCompleted(SESSION), false);
        assert.deepEqual(writes, []);
    });
}

test('the reconcile assigns only a live subscription', async () => {
    stripeSub = { id: 'sub_1', status: 'incomplete', created: now() };
    assert.equal(await handleCheckoutCompleted(SESSION, { requireLive: true }), false);
    stripeSub = null; // Stripe lookup failed
    assert.equal(await handleCheckoutCompleted(SESSION, { requireLive: true }), false);
    assert.deepEqual(writes, []);
});

test('the reconcile refuses a subscription older than the local one', async () => {
    stripeSub = { id: 'sub_1', status: 'active', created: now() - 30 * 86400 };
    const notBefore = new Date().toISOString();
    assert.equal(await handleCheckoutCompleted(SESSION, { requireLive: true, notBefore }), false);
    assert.deepEqual(writes, []);
    stripeSub = { id: 'sub_1', status: 'active', created: now() };
    assert.equal(await handleCheckoutCompleted(SESSION, { requireLive: true, notBefore }), true);
    assert.equal(writes.length, 1);
});
