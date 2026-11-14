// @typecheck
/**
 * The end of dunning: the failed payment that reaches DUNNING_MAX_ATTEMPTS
 * stores the status `manual_action_required`, writes its audit row and sends
 * the one final mail; the state locks out like `suspended`, survives Stripe's
 * own `past_due`, and a later Stripe event moves the subscriber out of it.
 * The real webhook route and the real stores, on PGlite.
 *
 * Run: cd server && node --test usecases/stripe/paymentEvents.dunningCap.pg.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';
process.env.DEPLOYMENT_MODE = 'cloud';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { stripeWebhookKit } = require('../../testUtils/stripeWebhookKit');

const kit = stripeWebhookKit();
const userStore = require('../../stores/userStore');
const license = require('../../license');
const { DUNNING_MAX_ATTEMPTS } = require('./paymentEvents');
const { checkSubscriptionLimits } = require('../../core/entitlements/limits');

const failedInvoice = (sub) => ({ id: `in_${sub}`, subscription: sub, customer: 'cus_A' });
const stripeSub = (status, metadata) => ({ id: 'sub_A', status, customer: 'cus_A', metadata });
const ORG_META = { beeflow_org_id: 'org1' };

before(async () => {
    await kit.init();
    await kit.pg.query(`INSERT INTO organizations (id, name) VALUES ('org1', 'Acme')`);
    await kit.pg.query(`INSERT INTO users (id, username, email, "organizationId", "orgRole") VALUES ('admin1', 'admin1', 'admin1@example.test', 'org1', 'org_admin')`);
    await kit.pg.query(`INSERT INTO users (id, username, email) VALUES ('u1', 'u1', 'u1@example.test')`);
});
after(() => kit.close());

/** One failure short of the cap. */
beforeEach(async () => {
    await kit.reset();
    const seed = { status: 'past_due', payment_status: 'failed', stripe_customer_id: 'cus_A' };
    assert.equal(await userStore.setOrgSubscription('org1', { ...seed, stripe_subscription_id: 'sub_A' }), true);
    assert.equal(await userStore.setConsumerSubscription('u1', { ...seed, stripe_subscription_id: 'sub_C' }), true);
    for (const table of ['organization_subscriptions', 'consumer_subscriptions']) {
        await kit.pg.query(`UPDATE ${table} SET payment_attempt_count = $1, past_due_since = NOW() - INTERVAL '30 days'`, [DUNNING_MAX_ATTEMPTS - 1]);
    }
});

test('the failure that reaches the cap stores the status, audits it and sends the final mail once', async () => {
    const res = await kit.deliver('invoice.payment_failed', failedInvoice('sub_A'));
    assert.equal(res.status, 200);

    const row = await kit.orgSub('org1');
    assert.equal(row.status, 'manual_action_required');
    assert.equal(row.payment_status, 'failed');
    assert.equal(row.payment_attempt_count, DUNNING_MAX_ATTEMPTS);
    assert.deepEqual(await kit.audits('org1'), ['payment_attempt_failed', 'payment_dunning_capped']);
    assert.deepEqual(kit.mails.map((m) => [m.mail, m.email, m.reason]), [['sendSubscriptionSuspendedEmail', 'admin1@example.test', 'payment_dunning_capped']]);
    assert.equal(await kit.processed(res.eventId), true);

    // The next failed retry: still capped, no second final mail, no per-attempt mail.
    assert.equal((await kit.deliver('invoice.payment_failed', failedInvoice('sub_A'))).status, 200);
    assert.equal((await kit.orgSub('org1')).status, 'manual_action_required');
    assert.equal(kit.mails.length, 1);
});

test('a consumer reaches the cap the same way', async () => {
    assert.equal((await kit.deliver('invoice.payment_failed', failedInvoice('sub_C'))).status, 200);
    assert.equal((await kit.consumerSub('u1')).status, 'manual_action_required');
    assert.deepEqual(await kit.audits('u1'), ['payment_attempt_failed', 'payment_dunning_capped']);
    assert.deepEqual(kit.mails.map((m) => [m.mail, m.email]), [['sendSubscriptionSuspendedEmail', 'u1@example.test']]);
});

test('a failure below the cap stays past_due and sends the per-attempt mail', async () => {
    await kit.pg.query('UPDATE organization_subscriptions SET payment_attempt_count = 0');
    assert.equal((await kit.deliver('invoice.payment_failed', failedInvoice('sub_A'))).status, 200);
    assert.equal((await kit.orgSub('org1')).status, 'past_due');
    assert.deepEqual(await kit.audits('org1'), ['payment_attempt_failed']);
    assert.deepEqual(kit.mails.map((m) => [m.mail, m.attemptCount]), [['sendPaymentFailedEmail', 1]]);
});

test('the capped state locks out like suspended: no tier, counted as suspended, left alone by the grace sweep', async () => {
    await kit.deliver('invoice.payment_failed', failedInvoice('sub_A'));
    const sub = await userStore.getOrgSubscription('org1');
    assert.equal(license.resolveTierFromSubscription({ ...sub, plan_tier: 'pro' }), null);
    assert.match(await checkSubscriptionLimits('org1', 'chat'), /subscription is suspended because payment could not be collected/);

    await kit.pg.query('DELETE FROM consumer_subscriptions');
    assert.deepEqual(await userStore.getDunningCounts(), { past_due_count: 0, suspended_count: 1 });
    assert.deepEqual(await userStore.suspendPastDueSubscriptions(7), { orgs: 0, consumers: 0 });
    assert.equal((await kit.orgSub('org1')).status, 'manual_action_required');
});

test('Stripe\'s own past_due does not undo the cap; a paid invoice or an active subscription does', async () => {
    await kit.deliver('invoice.payment_failed', failedInvoice('sub_A'));

    assert.equal((await kit.deliver('customer.subscription.updated', stripeSub('past_due', ORG_META))).status, 200);
    assert.equal((await kit.orgSub('org1')).status, 'manual_action_required');

    assert.equal((await kit.deliver('invoice.paid', { id: 'in_paid', subscription: 'sub_A' })).status, 200);
    const paid = await kit.orgSub('org1');
    assert.deepEqual([paid.status, paid.payment_status, paid.payment_attempt_count], ['active', 'paid', 0]);

    await kit.pg.query(`UPDATE organization_subscriptions SET status = 'manual_action_required'`);
    assert.equal((await kit.deliver('customer.subscription.updated', stripeSub('active', ORG_META))).status, 200);
    assert.equal((await kit.orgSub('org1')).status, 'active');

    await kit.pg.query(`UPDATE organization_subscriptions SET status = 'manual_action_required'`);
    assert.equal((await kit.deliver('customer.subscription.updated', stripeSub('unpaid', ORG_META))).status, 200);
    assert.equal((await kit.orgSub('org1')).status, 'suspended');
});

test('a consumer\'s cap survives Stripe\'s past_due too', async () => {
    await kit.deliver('invoice.payment_failed', failedInvoice('sub_C'));
    const meta = { beeflow_subscriber_type: 'consumer', beeflow_user_id: 'u1' };
    assert.equal((await kit.deliver('customer.subscription.updated', { ...stripeSub('past_due', meta), id: 'sub_C' })).status, 200);
    assert.equal((await kit.consumerSub('u1')).status, 'manual_action_required');
});
