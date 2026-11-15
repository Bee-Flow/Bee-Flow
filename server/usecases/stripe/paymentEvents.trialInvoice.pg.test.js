// @typecheck
/**
 * A trial starts with a zero-amount invoice that Stripe marks paid at once
 * (invoice.paid, billing_reason subscription_create, amount_paid 0). Nothing
 * was paid, so it must not make the trialing subscriber a paying one: `paid`
 * on the row is what customer.subscription.deleted reads to tell a customer
 * who cancelled from a trial that ended without payment, and only the latter
 * falls back to the Free plan. The real webhook route and the real stores, on
 * PGlite.
 *
 * Run: cd server && node --test usecases/stripe/paymentEvents.trialInvoice.pg.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const kit = require('../../testUtils/stripeWebhookKit').stripeWebhookKit();
const userStore = require('../../stores/userStore');

const TRIAL_END = new Date(Date.now() + 14 * 86_400_000).toISOString();
/** @type {Record<string, any>} */
let plans = {};

/** @param {string} sub @param {Record<string, unknown>} [over] */
const invoice = (sub, over = {}) => ({ id: `in_${sub}`, subscription: sub, customer: 'cus_A', billing_reason: 'subscription_create', amount_paid: 0, ...over });

/** @param {Record<string, any>} row */
const state = (row) => [row.status, row.payment_status];

before(async () => { plans = await kit.seedSubscribers(); });
after(() => kit.close());

/** Both subscribers are in a trial that Stripe manages. */
beforeEach(async () => {
    await kit.reset();
    for (const [set, id, sub] of /** @type {const} */ ([[userStore.setOrgSubscription, 'org1', 'sub_A'], [userStore.setConsumerSubscription, 'u1', 'sub_C']])) {
        assert.equal(await set(id, { status: 'trialing', payment_status: 'trialing', plan_id: plans.team.id, trial_end_date: TRIAL_END, stripe_subscription_id: sub }), true);
    }
});

test('the zero-amount invoice of a trial leaves the subscriber trialing', async () => {
    await kit.deliverOk('invoice.paid', invoice('sub_A'));
    await kit.deliverOk('invoice.paid', invoice('sub_C'));
    assert.deepEqual(state(await kit.orgSub('org1')), ['trialing', 'trialing']);
    assert.deepEqual(state(await kit.consumerSub('u1')), ['trialing', 'trialing']);
});

test('a trial that ends without payment falls back to the Free plan, also after its zero-amount invoice', async () => {
    await kit.deliverOk('invoice.paid', invoice('sub_A'));
    await kit.deliverOk('customer.subscription.deleted', { id: 'sub_A', status: 'canceled', customer: 'cus_A', metadata: { beeflow_org_id: 'org1' } });

    const row = await kit.orgSub('org1');
    assert.deepEqual([row.status, row.plan_id, row.stripe_subscription_id], ['active', plans.free.id, null]);
    assert.deepEqual(await kit.audits('org1'), ['downgrade_to_free']);
});

test('the first real payment of a trial makes the subscriber active and paid', async () => {
    await kit.deliverOk('invoice.paid', invoice('sub_A', { billing_reason: 'subscription_cycle', amount_paid: 2000 }));
    assert.deepEqual(state(await kit.orgSub('org1')), ['active', 'paid']);
});

test('a zero-amount invoice outside a trial still restores a subscriber who was behind', async () => {
    await kit.pg.query(`UPDATE organization_subscriptions SET status = 'past_due', payment_status = 'failed', payment_attempt_count = 2, past_due_since = NOW()`);
    await kit.deliverOk('invoice.paid', invoice('sub_A', { billing_reason: 'subscription_cycle' }));

    const row = await kit.orgSub('org1');
    assert.deepEqual([...state(row), row.payment_attempt_count, row.past_due_since], ['active', 'paid', 0, null]);
});
