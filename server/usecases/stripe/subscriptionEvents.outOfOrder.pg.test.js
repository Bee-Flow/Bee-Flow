// @typecheck
/**
 * Stripe does not order its events and redelivers a failed one for days. Two
 * kinds of old news must not be written over the row of a paying subscriber:
 *
 *   - The END of an earlier subscription (an abandoned checkout that expires
 *     after 23 hours, a cancelled one whose `deleted` event is retried) that
 *     arrives after the checkout of its successor. It says nothing about the
 *     subscription the row holds by now.
 *   - The FIRST snapshot of the row's own subscription. Stripe creates a
 *     subscription as `incomplete` and it never returns to that status;
 *     created (incomplete) and updated (active) are sent together at a
 *     checkout. Written after the activation, it makes a paying subscriber
 *     `incomplete`, which the stale-incomplete sweep cancels.
 *
 * The real webhook route and the real stores, on PGlite.
 *
 * Run: cd server && node --test usecases/stripe/subscriptionEvents.outOfOrder.pg.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const kit = require('../../testUtils/stripeWebhookKit').stripeWebhookKit();
const userStore = require('../../stores/userStore');

/** @type {Record<string, any>} */
let plans = {};

/** A subscription of the organisation, as Stripe reports it; by default an earlier one that has ended. @param {Record<string, unknown>} [over] */
const orgSub = (over = {}) => ({ id: 'sub_OLD', status: 'canceled', customer: 'cus_A', metadata: { beeflow_org_id: 'org1' }, items: { data: [] }, ...over });
/** @param {Record<string, unknown>} [over] */
const consumerSub = (over = {}) => ({ id: 'sub_COLD', status: 'canceled', customer: 'cus_C', metadata: { beeflow_subscriber_type: 'consumer', beeflow_user_id: 'u1' }, items: { data: [] }, ...over });

/** The fields old news must leave alone. @param {Record<string, any>} row */
const held = (row) => [row.status, row.payment_status, row.stripe_subscription_id, row.plan_id];

before(async () => { plans = await kit.seedSubscribers(); });
after(() => kit.close());

/** Both subscribers pay for a live subscription that replaced an earlier one. */
beforeEach(async () => {
    await kit.reset();
    const seed = { status: 'active', payment_status: 'paid', plan_id: plans.team.id };
    assert.equal(await userStore.setOrgSubscription('org1', { ...seed, stripe_customer_id: 'cus_A', stripe_subscription_id: 'sub_LIVE' }), true);
    assert.equal(await userStore.setConsumerSubscription('u1', { ...seed, stripe_customer_id: 'cus_C', stripe_subscription_id: 'sub_CLIVE' }), true);
});

/** Neither row changed, and each subscriber has the one audit row. @param {string} action */
async function assertLeftAlone(action) {
    assert.deepEqual(held(await kit.orgSub('org1')), ['active', 'paid', 'sub_LIVE', plans.team.id]);
    assert.deepEqual(held(await kit.consumerSub('u1')), ['active', 'paid', 'sub_CLIVE', plans.team.id]);
    assert.deepEqual(await kit.audits('org1'), [action]);
    assert.deepEqual(await kit.audits('u1'), [action]);
}

// ── The end of an earlier subscription ──────────────────────────────────────

test('an abandoned checkout that expires does not cancel or re-point the subscription bought after it', async () => {
    await kit.deliverOk('customer.subscription.updated', orgSub({ status: 'incomplete_expired' }));
    await kit.deliverOk('customer.subscription.updated', consumerSub({ status: 'incomplete_expired' }));
    await assertLeftAlone('webhook_superseded_subscription');
});

test('the late end of an earlier subscription does not cancel the live one', async () => {
    await kit.deliverOk('customer.subscription.deleted', orgSub());
    await kit.deliverOk('customer.subscription.deleted', consumerSub());
    await assertLeftAlone('webhook_superseded_subscription');
});

test('the late end of an earlier subscription does not move a trialing organisation to the Free plan', async () => {
    await kit.pg.query(`UPDATE organization_subscriptions SET status = 'trialing', payment_status = 'trialing'`);
    await kit.deliverOk('customer.subscription.deleted', orgSub());
    assert.deepEqual(held(await kit.orgSub('org1')), ['trialing', 'trialing', 'sub_LIVE', plans.team.id]);
});

test('the payment events of the live subscription still find its row afterwards', async () => {
    await kit.deliverOk('customer.subscription.updated', orgSub({ status: 'incomplete_expired' }));
    await kit.deliverOk('invoice.payment_failed', { id: 'in_1', subscription: 'sub_LIVE', customer: 'cus_A' });
    assert.equal((await kit.orgSub('org1')).status, 'past_due');
});

test('the subscription the row holds still ends, for both kinds of event', async () => {
    await kit.deliverOk('customer.subscription.deleted', orgSub({ id: 'sub_LIVE' }));
    assert.deepEqual(held(await kit.orgSub('org1')).slice(0, 2), ['cancelled', 'cancelled']);

    await kit.deliverOk('customer.subscription.updated', consumerSub({ id: 'sub_CLIVE' }));
    assert.deepEqual(held(await kit.consumerSub('u1')).slice(0, 3), ['cancelled', 'cancelled', 'sub_CLIVE']);
});

test('a row that holds no Stripe subscription takes the end of one as before', async () => {
    await kit.pg.query('UPDATE organization_subscriptions SET stripe_subscription_id = NULL');
    await kit.deliverOk('customer.subscription.deleted', orgSub());
    assert.equal((await kit.orgSub('org1')).status, 'cancelled');
});

test('another subscription that is live is still adopted', async () => {
    await kit.deliverOk('customer.subscription.updated', orgSub({ id: 'sub_NEW', status: 'past_due' }));
    assert.deepEqual(held(await kit.orgSub('org1')).slice(0, 3), ['past_due', 'past_due', 'sub_NEW']);
});

// ── The first snapshot of the row's own subscription ────────────────────────

test('the first snapshot of a subscription, arriving after its activation, does not make a paying subscriber incomplete', async () => {
    await kit.deliverOk('customer.subscription.created', orgSub({ id: 'sub_LIVE', status: 'incomplete' }));
    await kit.deliverOk('customer.subscription.created', consumerSub({ id: 'sub_CLIVE', status: 'incomplete' }));
    await assertLeftAlone('webhook_stale_snapshot');
});

test('the stale-incomplete sweep therefore leaves a paying organisation alone, however old its row', async () => {
    await kit.pg.query(`UPDATE organization_subscriptions SET created_at = NOW() - INTERVAL '30 days'`);
    await kit.deliverOk('customer.subscription.created', orgSub({ id: 'sub_LIVE', status: 'incomplete' }));
    assert.deepEqual(await userStore.cancelStaleIncompleteSubscriptions(14), { orgs: 0, consumers: 0, failed: 0 });
    assert.equal((await kit.orgSub('org1')).status, 'active');
});

test('a subscription that is incomplete on the row stays so, and its later statuses are written', async () => {
    await kit.pg.query(`UPDATE organization_subscriptions SET status = 'incomplete', payment_status = 'pending'`);
    await kit.deliverOk('customer.subscription.updated', orgSub({ id: 'sub_LIVE', status: 'incomplete' }));
    assert.deepEqual(held(await kit.orgSub('org1')).slice(0, 2), ['incomplete', 'pending']);

    await kit.deliverOk('customer.subscription.updated', orgSub({ id: 'sub_LIVE', status: 'active' }));
    assert.deepEqual(held(await kit.orgSub('org1')).slice(0, 2), ['active', 'paid']);
});

test('the first snapshot of a new subscription is written to a row that holds none yet', async () => {
    await kit.pg.query('UPDATE organization_subscriptions SET stripe_subscription_id = NULL');
    await kit.deliverOk('customer.subscription.created', orgSub({ id: 'sub_FIRST', status: 'incomplete' }));
    assert.deepEqual(held(await kit.orgSub('org1')).slice(0, 3), ['incomplete', 'pending', 'sub_FIRST']);
});
