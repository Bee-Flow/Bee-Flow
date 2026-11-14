// @typecheck
/**
 * The subscription lifecycle and plan routes write the local row AFTER a
 * Stripe call that succeeded. When the database refuses that write the route
 * answers an error that asks for a retry (never success), writes no audit row,
 * and the retry, with the database back, ends in the state a first success
 * would have left. Real routers and real stores on PGlite; Stripe is the
 * stripeService object with its calls recorded.
 *
 * Run: cd server && node --test routes/subscriptions/lifecycle.failedWrite.pg.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { guardedPglitePool, STATUS_WRITE } = require('../../testUtils/stripeWebhookKit');
const { makeSwaps } = require('../../testUtils/swaps');
const h = require('../../testUtils/routeHarness');

const { pg, close, failWrites } = guardedPglitePool();
const userStore = require('../../stores/userStore');
const stripeService = require('../../services/stripeService');
const planEntitlements = require('../../core/entitlements/planEntitlements');
const { swap, restore } = makeSwaps();

const PLAN_WRITE = /UPDATE "?subscription_plans"? SET "/;
const PERIOD_END = Math.floor(Date.now() / 1000) + 86400;
/** Every Stripe call a route made, by name. */
let stripeCalls = [];
const stripe = (name, answer) => swap(stripeService, name, async () => { stripeCalls.push(name); return answer; });

let cheap;
let dear;
let api;

before(async () => {
    await require('../../stores/user/schema').initDB();
    await pg.query(`INSERT INTO organizations (id, name) VALUES ('org1', 'Acme')`);
    await pg.query(`INSERT INTO users (id, username) VALUES ('u1', 'u1')`);
    cheap = await userStore.createPlan({ name: 'Solo', price: 10, stripe_price_id: 'price_cheap', stripe_product_id: 'prod_cheap' });
    dear = await userStore.createPlan({ name: 'Team', price: 20, stripe_price_id: 'price_dear', stripe_product_id: 'prod_dear' });

    stripe('isEnabled', true);
    stripe('updateSubscriptionPlan', { current_period_end: PERIOD_END });
    stripe('scheduleDowngradeAtPeriodEnd', { scheduleId: 'sched_1', effective: new Date(PERIOD_END * 1000).toISOString() });
    stripe('releaseSubscriptionSchedule', null);
    stripe('cancelSubscriptionAtPeriodEnd', { cancel_at: PERIOD_END, current_period_end: PERIOD_END });
    stripe('reactivateSubscription', {});
    stripe('syncPlanToStripe', { productId: 'prod_new', priceId: 'price_new' });
    swap(planEntitlements, 'applyPlanToOrg', async () => {});

    api = h.serve('/', [require('./lifecycle'), require('./plans')]);
});
after(async () => { restore(); await api.close(); await close(); });

const auditActions = async () => (await pg.query('SELECT action FROM subscription_audit_log ORDER BY action')).rows.map((r) => r.action);
const orgSub = () => userStore.getOrgSubscription('org1');
const consumerSub = () => userStore.getConsumerSubscription('u1');

beforeEach(async () => {
    failWrites(null);
    stripeCalls = [];
    for (const t of ['organization_subscriptions', 'consumer_subscriptions', 'subscription_audit_log']) await pg.query(`DELETE FROM ${t}`);
    const seed = { status: 'active', payment_status: 'paid' };
    assert.equal(await userStore.setOrgSubscription('org1', { ...seed, plan_id: cheap.id, stripe_subscription_id: 'sub_A' }), true);
    assert.equal(await userStore.setConsumerSubscription('u1', { ...seed, plan_id: cheap.id, stripe_subscription_id: 'sub_C' }), true);
    await pg.query('DELETE FROM subscription_audit_log');
});

/**
 * Call the route with the subscription write refused, then again with the
 * database back.
 * @returns {Promise<{ refused: any, retried: any }>}
 */
async function refusedThenRetried(url, body) {
    failWrites(STATUS_WRITE);
    const refused = await api.call('POST', url, { body });
    assert.equal(refused.status, 503, refused.text);
    assert.match(refused.text, /could not be saved here\. Please try again\./);
    assert.deepEqual(await auditActions(), [], 'no audit row for a change that was not stored');

    failWrites(null);
    const retried = await api.call('POST', url, { body });
    assert.equal(retried.status, 200, retried.text);
    return { refused, retried };
}

test('organisation upgrade', async () => {
    await refusedThenRetried('/orgs/org1/upgrade', { planId: dear.id });
    assert.equal((await orgSub()).plan_id, dear.id);
    assert.deepEqual(await auditActions(), ['upgrade_subscription']);
    assert.deepEqual(stripeCalls, ['updateSubscriptionPlan', 'updateSubscriptionPlan'], 'the retry repeats the same Stripe update');
});

test('organisation downgrade is scheduled, and its cancellation', async () => {
    assert.equal(await userStore.setOrgSubscription('org1', { plan_id: dear.id }), true);
    await refusedThenRetried('/orgs/org1/upgrade', { planId: cheap.id });
    const scheduled = await orgSub();
    assert.deepEqual([scheduled.plan_id, scheduled.pending_plan_id, scheduled.stripe_schedule_id], [dear.id, cheap.id, 'sched_1']);
    assert.deepEqual(await auditActions(), ['downgrade_scheduled']);

    await pg.query('DELETE FROM subscription_audit_log');
    await refusedThenRetried('/orgs/org1/cancel-downgrade');
    const cleared = await orgSub();
    assert.deepEqual([cleared.pending_plan_id, cleared.stripe_schedule_id], [null, null]);
    assert.deepEqual(await auditActions(), ['downgrade_cancelled']);
});

test('organisation cancel (with a schedule to release first) and reactivate', async () => {
    assert.equal(await userStore.setOrgSubscription('org1', { pending_plan_id: cheap.id, stripe_schedule_id: 'sched_1' }), true);
    await refusedThenRetried('/orgs/org1/cancel');
    const cancelled = await orgSub();
    assert.deepEqual([cancelled.cancel_at_period_end, cancelled.stripe_schedule_id], [true, null]);
    assert.deepEqual(await auditActions(), ['cancel_subscription_scheduled']);
    assert.equal(stripeCalls.includes('cancelSubscriptionAtPeriodEnd'), true);

    await pg.query('DELETE FROM subscription_audit_log');
    await refusedThenRetried('/orgs/org1/reactivate');
    assert.equal((await orgSub()).cancel_at_period_end, false);
    assert.deepEqual(await auditActions(), ['cancel_subscription_undone']);
});

test('consumer upgrade, cancel and reactivate', async () => {
    await refusedThenRetried('/consumer/u1/upgrade', { planId: dear.id });
    assert.equal((await consumerSub()).plan_id, dear.id);
    assert.deepEqual(await auditActions(), ['upgrade_subscription']);

    await pg.query('DELETE FROM subscription_audit_log');
    await refusedThenRetried('/consumer/u1/cancel');
    assert.equal((await consumerSub()).cancel_at_period_end, true);

    await pg.query('DELETE FROM subscription_audit_log');
    await refusedThenRetried('/consumer/u1/reactivate');
    assert.equal((await consumerSub()).cancel_at_period_end, false);
    assert.deepEqual(await auditActions(), ['cancel_subscription_undone']);
});

test('a write that is stored answers 200 on the first call', async () => {
    const res = await api.call('POST', '/orgs/org1/upgrade', { body: { planId: dear.id } });
    assert.equal(res.status, 200);
    assert.equal(res.body.plan_id, dear.id);
    assert.deepEqual(await auditActions(), ['upgrade_subscription']);
});

// ── Plans: the Stripe ids a sync returned ───────────────────────────

test('sync-stripe: ids that could not be stored are an error, and the retry stores them', async () => {
    failWrites(PLAN_WRITE);
    const refused = await api.call('POST', `/plans/${dear.id}/sync-stripe`);
    assert.equal(refused.status, 503, refused.text);
    assert.equal(refused.body.code, 'plan_stripe_ids_not_stored');
    assert.equal((await userStore.getPlan(dear.id)).stripe_price_id, 'price_dear');
    assert.deepEqual(await auditActions(), []);

    failWrites(null);
    const retried = await api.call('POST', `/plans/${dear.id}/sync-stripe`);
    assert.equal(retried.status, 200, retried.text);
    assert.equal((await userStore.getPlan(dear.id)).stripe_price_id, 'price_new');
    assert.deepEqual(await auditActions(), ['update_plan']);
    await userStore.updatePlan(dear.id, { stripe_price_id: 'price_dear', stripe_product_id: 'prod_dear' });
});

test('plan update: the price change is stored, the ids of its Stripe sync are not: an error, not a plan that claims them', async () => {
    const plan = await userStore.createPlan({ name: 'Edit me', price: 5 });
    // The plan row itself is written first; only the second write, the Stripe ids, is refused.
    let writes = 0;
    failWrites({ test: (sql) => PLAN_WRITE.test(sql) && ++writes === 2 });
    const res = await api.call('PUT', `/plans/${plan.id}`, { body: { price: 7 } });
    assert.equal(res.status, 503, res.text);
    assert.equal(res.body.code, 'plan_stripe_ids_not_stored');
    const stored = await userStore.getPlan(plan.id);
    assert.deepEqual([stored.price, stored.stripe_price_id], [7, null]);
});

test('plan create: the plan exists, so the answer is 201 without the ids that were not stored', async () => {
    failWrites(PLAN_WRITE);
    const res = await api.call('POST', '/plans', { body: { name: 'Fresh', price: 9 } });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.stripe_price_id, null);
    assert.equal((await userStore.getPlan(res.body.id)).stripe_price_id, null);
});
