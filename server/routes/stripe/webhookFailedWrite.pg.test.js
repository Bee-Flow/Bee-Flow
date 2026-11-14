// @typecheck
/**
 * A Stripe webhook whose subscription write the database refuses: the route
 * answers 500, the event is released from the idempotency ledger, and nothing
 * that follows the write (audit row, counter, mail) has happened. The
 * redelivery of the SAME event then does all of it exactly once. The real
 * webhook route and the real stores, on PGlite.
 *
 * Run: cd server && node --test routes/stripe/webhookFailedWrite.pg.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { stripeWebhookKit, STATUS_WRITE } = require('../../testUtils/stripeWebhookKit');

const kit = stripeWebhookKit();
const userStore = require('../../stores/userStore');
const stripeService = require('../../services/stripeService');
const { DUNNING_MAX_ATTEMPTS } = require('../../usecases/stripe/paymentEvents');

const ORG_META = { beeflow_org_id: 'org1' };
const CONSUMER_META = { beeflow_subscriber_type: 'consumer', beeflow_user_id: 'u1' };
let planA;
let planB;

before(async () => {
    await kit.init();
    await kit.pg.query(`INSERT INTO organizations (id, name) VALUES ('org1', 'Acme')`);
    await kit.pg.query(`INSERT INTO users (id, username, email, "organizationId", "orgRole") VALUES ('admin1', 'admin1', 'admin1@example.test', 'org1', 'org_admin')`);
    await kit.pg.query(`INSERT INTO users (id, username, email) VALUES ('u1', 'u1', 'u1@example.test')`);
    planA = await userStore.createPlan({ name: 'Team', price: 20, stripe_price_id: 'price_A', stripe_product_id: 'prod_A' });
    planB = await userStore.createPlan({ name: 'Solo', price: 10, stripe_price_id: 'price_B', stripe_product_id: 'prod_B' });
    kit.swap(stripeService, 'getClient', async () => ({
        subscriptions: { retrieve: async () => ({ status: 'active', created: Math.floor(Date.now() / 1000) }) },
    }));
});
after(() => kit.close());

beforeEach(async () => {
    await kit.reset();
    const seed = { status: 'active', payment_status: 'paid', stripe_customer_id: 'cus_A', plan_id: planA.id };
    assert.equal(await userStore.setOrgSubscription('org1', { ...seed, stripe_subscription_id: 'sub_A' }), true);
    assert.equal(await userStore.setConsumerSubscription('u1', { ...seed, stripe_customer_id: 'cus_C', stripe_subscription_id: 'sub_C' }), true);
});

/**
 * Deliver the event with the status write refused, check that nothing stuck,
 * then deliver the SAME event again with the database back.
 * @returns {Promise<string>} the event id
 */
async function refusedThenRedelivered(type, object, targetId) {
    kit.failWrites(STATUS_WRITE);
    const refused = await kit.deliver(type, object);
    assert.equal(refused.status, 500, 'Stripe is told to deliver the event again');
    assert.equal(await kit.processed(refused.eventId), false, 'the ledger row is released');
    assert.deepEqual(await kit.audits(targetId), [], 'no audit row for a write that did not happen');
    assert.deepEqual(kit.mails, [], 'no mail either');

    kit.failWrites(null);
    const again = await kit.deliver(type, object, refused.eventId);
    assert.equal(again.status, 200);
    assert.notEqual(again.body.duplicate, true, 'the redelivery is processed, not skipped');
    assert.equal(await kit.processed(refused.eventId), true);
    return refused.eventId;
}

test('charge.refunded: a refused write is retried and audited once', async () => {
    await refusedThenRedelivered('charge.refunded', { id: 'ch_1', customer: 'cus_A', amount_refunded: 500 }, 'org1');
    assert.equal((await kit.orgSub('org1')).payment_status, 'refunded');
    assert.deepEqual(await kit.audits('org1'), ['refund_processed']);
});

test('charge.dispute.created: a refused write is retried and audited once', async () => {
    await refusedThenRedelivered('charge.dispute.created', { id: 'dp_1', customer: 'cus_C', reason: 'fraudulent', amount: 900 }, 'u1');
    const row = await kit.consumerSub('u1');
    assert.deepEqual([row.status, row.payment_status], ['suspended', 'disputed']);
    assert.deepEqual(await kit.audits('u1'), ['dispute_opened']);
});

test('invoice.payment_failed: a refused write counts no attempt and sends no mail; the redelivery does both once', async () => {
    // The counter ends at 1: the refused delivery did not count an attempt.
    await refusedThenRedelivered('invoice.payment_failed', { id: 'in_1', subscription: 'sub_A', customer: 'cus_A' }, 'org1');
    const row = await kit.orgSub('org1');
    assert.deepEqual([row.status, row.payment_status, row.payment_attempt_count], ['past_due', 'failed', 1]);
    assert.deepEqual(await kit.audits('org1'), ['payment_attempt_failed']);
    assert.deepEqual(kit.mails.map((m) => [m.mail, m.attemptCount]), [['sendPaymentFailedEmail', 1]]);
});

test('invoice.payment_failed at the dunning cap: a refused write is retried, the final mail goes out once', async () => {
    await kit.pg.query('UPDATE consumer_subscriptions SET payment_attempt_count = $1', [DUNNING_MAX_ATTEMPTS - 1]);
    await refusedThenRedelivered('invoice.payment_failed', { id: 'in_2', subscription: 'sub_C', customer: 'cus_C' }, 'u1');
    const row = await kit.consumerSub('u1');
    assert.deepEqual([row.status, row.payment_attempt_count], ['manual_action_required', DUNNING_MAX_ATTEMPTS]);
    assert.deepEqual(await kit.audits('u1'), ['payment_attempt_failed', 'payment_dunning_capped']);
    assert.deepEqual(kit.mails.map((m) => m.mail), ['sendSubscriptionSuspendedEmail']);
});

test('customer.subscription.updated: a scheduled downgrade that lands clears its bookkeeping in the one write', async () => {
    assert.equal(await userStore.setOrgSubscription('org1', { pending_plan_id: planB.id, pending_plan_effective: new Date().toISOString(), stripe_schedule_id: 'sched_1' }), true);
    const landed = { id: 'sub_A', status: 'active', customer: 'cus_A', metadata: ORG_META, items: { data: [{ quantity: 1, price: { id: 'price_B', product: 'prod_B' } }] } };

    await refusedThenRedelivered('customer.subscription.updated', landed, 'org1');
    const row = await kit.orgSub('org1');
    assert.deepEqual([row.plan_id, row.pending_plan_id, row.pending_plan_effective, row.stripe_schedule_id], [planB.id, null, null, null]);
    assert.deepEqual(await kit.audits('org1'), ['plan_changed_via_stripe', 'update_subscription']);
});

test('customer.subscription.updated under a manual override keeps the pending downgrade', async () => {
    const until = new Date(Date.now() + 3600_000).toISOString();
    assert.equal(await userStore.setOrgSubscription('org1', { pending_plan_id: planB.id, stripe_schedule_id: 'sched_1', manual_override_until: until, manual_override_by: 'admin1' }), true);
    const landed = { id: 'sub_A', status: 'active', customer: 'cus_A', metadata: ORG_META, items: { data: [{ quantity: 1, price: { id: 'price_B', product: 'prod_B' } }] } };
    assert.equal((await kit.deliver('customer.subscription.updated', landed)).status, 200);
    const row = await kit.orgSub('org1');
    assert.deepEqual([row.plan_id, row.pending_plan_id, row.stripe_schedule_id], [planA.id, planB.id, 'sched_1']);
});

test('customer.subscription.deleted (organisation): a refused write is retried and audited once', async () => {
    await refusedThenRedelivered('customer.subscription.deleted', { id: 'sub_A', status: 'canceled', metadata: ORG_META }, 'org1');
    const row = await kit.orgSub('org1');
    assert.deepEqual([row.status, row.payment_status], ['cancelled', 'cancelled']);
    assert.deepEqual(await kit.audits('org1'), ['update_subscription']);
});

test('customer.subscription.deleted (consumer): a refused write is retried and audited once', async () => {
    await refusedThenRedelivered('customer.subscription.deleted', { id: 'sub_C', status: 'canceled', metadata: CONSUMER_META }, 'u1');
    assert.equal((await kit.consumerSub('u1')).status, 'cancelled');
    assert.deepEqual(await kit.audits('u1'), ['update_subscription']);
});

test('customer.subscription.deleted without metadata: the lookup is audited once, after the write', async () => {
    await refusedThenRedelivered('customer.subscription.deleted', { id: 'sub_A', status: 'canceled', metadata: {} }, 'org1');
    assert.equal((await kit.orgSub('org1')).status, 'cancelled');
    assert.deepEqual(await kit.audits('org1'), ['update_subscription', 'webhook_metadata_missing']);
});

test('checkout.session.completed: a refused write is not acknowledged as an assigned subscription', async () => {
    const session = { id: 'cs_1', customer: 'cus_A', subscription: 'sub_NEW', metadata: ORG_META, client_reference_id: 'org1' };
    await refusedThenRedelivered('checkout.session.completed', session, 'org1');
    const row = await kit.orgSub('org1');
    assert.deepEqual([row.status, row.stripe_subscription_id], ['active', 'sub_NEW']);
    assert.deepEqual(await kit.audits('org1'), ['assign_subscription']);
});

test('a write that succeeds is acknowledged, and its redelivery is skipped as a duplicate', async () => {
    const first = await kit.deliver('charge.refunded', { id: 'ch_2', customer: 'cus_A', amount_refunded: 100 });
    assert.equal(first.status, 200);
    const second = await kit.deliver('charge.refunded', { id: 'ch_2', customer: 'cus_A', amount_refunded: 100 }, first.eventId);
    assert.deepEqual([second.status, second.body.duplicate], [200, true]);
    assert.deepEqual(await kit.audits('org1'), ['refund_processed']);
});
