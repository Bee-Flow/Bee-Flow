// @typecheck
/**
 * customer.subscription.updated (and .created, which takes the same handler):
 * what the local subscription row, the audit log and the plan entitlements
 * look like after Stripe reports a subscription. The real webhook route and
 * the real stores, on PGlite; only applyPlanToOrg is watched through its
 * module object.
 *
 * Run: cd server && node --test routes/stripe/subscriptionUpdated.pg.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { stripeWebhookKit } = require('../../testUtils/stripeWebhookKit');

const kit = stripeWebhookKit();
const userStore = require('../../stores/userStore');
const planEntitlements = require('../../core/entitlements/planEntitlements');

const ORG_META = { beeflow_org_id: 'org1' };
const CONSUMER_META = { beeflow_subscriber_type: 'consumer', beeflow_user_id: 'u1' };
const T = 1_700_000_000;
const iso = (/** @type {number} */ s) => new Date(s * 1000).toISOString();
const isoOf = (/** @type {unknown} */ v) => (v == null ? null : new Date(/** @type {string} */ (v)).toISOString());
/** @type {Record<string, any>} */
let plans = {};
/** @type {Array<[string, string, unknown]>} */
let applied = [];
/** @type {Error | null} */
let applyFails = null;

/** @param {Record<string, unknown>} [over] */
const orgSub = (over = {}) => ({ id: 'sub_A', status: 'active', customer: 'cus_A', metadata: ORG_META, items: { data: [] }, ...over });
/** @param {Record<string, unknown>} [over] */
const consumerSub = (over = {}) => ({ id: 'sub_C', status: 'active', customer: 'cus_C', metadata: CONSUMER_META, items: { data: [] }, ...over });
/** @param {Record<string, unknown>} price @param {number} [quantity] */
const items = (price, quantity) => ({ data: [{ quantity, price }] });

/** @param {string} targetId */
async function auditRows(targetId) {
    const { rows } = await kit.pg.query('SELECT action, old_values, new_values FROM subscription_audit_log WHERE target_id = $1 ORDER BY action', [targetId]);
    return /** @type {Array<{ action: string, old_values: string | null, new_values: string | null }>} */ (rows)
        .map((r) => ({ action: r.action, old: r.old_values && JSON.parse(r.old_values), new: r.new_values && JSON.parse(r.new_values) }));
}

/** @param {string} type @param {Record<string, unknown>} sub */
async function deliverOk(type, sub) {
    const res = await kit.deliver(type, sub);
    assert.equal(res.status, 200);
    return res;
}
const updated = (/** @type {Record<string, unknown>} */ sub) => deliverOk('customer.subscription.updated', sub);

before(async () => {
    await kit.init();
    await kit.pg.query(`INSERT INTO organizations (id, name) VALUES ('org1', 'Acme')`);
    await kit.pg.query(`INSERT INTO users (id, username, email) VALUES ('u1', 'u1', 'u1@example.test')`);
    plans = {
        A: await userStore.createPlan({ name: 'Team', price: 20, stripe_price_id: 'price_A', stripe_product_id: 'prod_A' }),
        B: await userStore.createPlan({ name: 'Solo', price: 10, stripe_price_id: 'price_B', stripe_product_id: 'prod_B' }),
        Y1: await userStore.createPlan({ name: 'Twin 1', price: 30, stripe_price_id: 'price_Y1', stripe_product_id: 'prod_Y' }),
        Y2: await userStore.createPlan({ name: 'Twin 2', price: 40, stripe_price_id: 'price_Y2', stripe_product_id: 'prod_Y', billing_interval: 'yearly' }),
    };
    kit.swap(planEntitlements, 'applyPlanToOrg', async (/** @type {string} */ orgId, /** @type {string} */ planId, /** @type {unknown} */ opts) => {
        applied.push([orgId, planId, opts]);
        if (applyFails) throw applyFails;
        return true;
    });
});
after(() => kit.close());

beforeEach(async () => {
    await kit.reset();
    applied = [];
    applyFails = null;
    const seed = { status: 'active', payment_status: 'paid', plan_id: plans.A.id };
    assert.equal(await userStore.setOrgSubscription('org1', { ...seed, stripe_customer_id: 'cus_A', stripe_subscription_id: 'sub_A', billing_cycle_start: iso(T - 999) }), true);
    assert.equal(await userStore.setConsumerSubscription('u1', { ...seed, stripe_customer_id: 'cus_C', stripe_subscription_id: 'sub_C', billing_cycle_start: iso(T - 999) }), true);
    await kit.pg.query('UPDATE organization_subscriptions SET stripe_seat_quantity = 3');
});

test('every Stripe status maps to a local status and payment status; an unknown one stays active and is kept as payment status', async () => {
    const table = [
        ['active', 'active', 'paid'], ['past_due', 'past_due', 'past_due'], ['trialing', 'trialing', 'trialing'],
        ['paused', 'paused', 'paused'], ['incomplete', 'incomplete', 'pending'], ['incomplete_expired', 'cancelled', 'failed'],
        ['canceled', 'cancelled', 'cancelled'], ['unpaid', 'suspended', 'failed'], ['mystery', 'active', 'mystery'],
    ];
    for (const [stripe, status, paymentStatus] of table) {
        await updated(orgSub({ status: stripe }));
        const row = await kit.orgSub('org1');
        assert.deepEqual([row.status, row.payment_status], [status, paymentStatus], `Stripe ${stripe}`);
        await updated(consumerSub({ status: stripe }));
        const c = await kit.consumerSub('u1');
        assert.deepEqual([c.status, c.payment_status], [status, paymentStatus], `consumer, Stripe ${stripe}`);
    }
});

test('the billed seat quantity is mirrored when it is a positive number, kept otherwise', async () => {
    await updated(orgSub({ items: items({ id: 'price_A' }, 0) }));
    assert.equal((await kit.orgSub('org1')).stripe_seat_quantity, 3);
    await updated(orgSub({ items: items({ id: 'price_A' }, 7) }));
    assert.equal((await kit.orgSub('org1')).stripe_seat_quantity, 7);
});

test('the billing cycle starts at the current period, else at the anchor, else is left alone', async () => {
    await updated(orgSub());
    assert.equal(isoOf((await kit.orgSub('org1')).billing_cycle_start), iso(T - 999));
    await updated(orgSub({ billing_cycle_anchor: T - 50 }));
    assert.equal(isoOf((await kit.orgSub('org1')).billing_cycle_start), iso(T - 50));
    await updated(orgSub({ billing_cycle_anchor: T - 50, current_period_start: T }));
    assert.equal(isoOf((await kit.orgSub('org1')).billing_cycle_start), iso(T));
});

test('trial end, cancel-at-period-end, cancel date and period end are mirrored, and cleared when Stripe drops them', async () => {
    await updated(orgSub({ trial_end: T + 10, cancel_at_period_end: true, cancel_at: T + 20, current_period_end: T + 30 }));
    let row = await kit.orgSub('org1');
    assert.deepEqual([isoOf(row.trial_end_date), row.cancel_at_period_end, isoOf(row.cancel_at), isoOf(row.current_period_end)],
        [iso(T + 10), true, iso(T + 20), iso(T + 30)]);
    await updated(orgSub());
    row = await kit.orgSub('org1');
    assert.deepEqual([isoOf(row.trial_end_date), row.cancel_at_period_end, row.cancel_at, row.current_period_end], [iso(T + 10), false, null, null]);
});

test('a plan is found by exact price id; a price change re-applies the entitlements once and audits the change', async () => {
    await updated(orgSub({ items: items({ id: 'price_B', product: 'prod_B' }) }));
    assert.equal((await kit.orgSub('org1')).plan_id, plans.B.id);
    assert.deepEqual(applied, [['org1', plans.B.id, { mode: 'reset' }]]);
    const changed = (await auditRows('org1')).filter((a) => a.action === 'plan_changed_via_stripe');
    assert.deepEqual(changed.map((a) => [a.old, a.new]), [[{ plan_id: plans.A.id }, { plan_id: plans.B.id }]]);

    await updated(orgSub({ items: items({ id: 'price_B', product: 'prod_B' }) }));
    assert.equal(applied.length, 1, 'the same plan again applies nothing');
});

test('a rotated price falls back to its product when exactly one plan sells it; two plans leave the plan alone and audit plan_unmatched', async () => {
    await updated(orgSub({ items: items({ id: 'price_new', product: 'prod_B' }) }));
    assert.equal((await kit.orgSub('org1')).plan_id, plans.B.id);
    assert.deepEqual(await kit.audits('org1'), ['plan_changed_via_stripe', 'update_subscription']);

    await kit.reset();
    await userStore.setOrgSubscription('org1', { status: 'active', payment_status: 'paid', plan_id: plans.A.id, stripe_subscription_id: 'sub_A' });
    await updated(orgSub({ items: items({ id: 'price_new', product: 'prod_Y' }) }));
    assert.equal((await kit.orgSub('org1')).plan_id, plans.A.id);
    const unmatched = (await auditRows('org1')).filter((a) => a.action === 'plan_unmatched');
    assert.deepEqual(unmatched.map((a) => a.new), [{ price_id: 'price_new', sub_id: 'sub_A' }]);

    await kit.reset();
    await userStore.setOrgSubscription('org1', { status: 'active', payment_status: 'paid', plan_id: plans.A.id, stripe_subscription_id: 'sub_A' });
    // Stripe names the interval 'year' / 'month'; a plan stores 'yearly' / 'monthly'.
    await updated(orgSub({ items: items({ id: 'price_new', product: 'prod_Y', recurring: { interval: 'year' } }) }));
    assert.equal((await kit.orgSub('org1')).plan_id, plans.Y2.id, 'a yearly price narrows two product matches to the yearly plan');

    await kit.reset();
    await userStore.setOrgSubscription('org1', { status: 'active', payment_status: 'paid', plan_id: plans.A.id, stripe_subscription_id: 'sub_A' });
    await updated(orgSub({ items: items({ id: 'price_new2', product: 'prod_Y', recurring: { interval: 'month' } }) }));
    assert.equal((await kit.orgSub('org1')).plan_id, plans.Y1.id, 'a monthly price narrows them to the monthly plan');
});

test('a price that matches no plan keeps the plan and audits plan_unmatched; no price at all audits nothing', async () => {
    await updated(orgSub({ items: items({ id: 'price_unknown' }) }));
    assert.equal((await kit.orgSub('org1')).plan_id, plans.A.id);
    assert.deepEqual(await kit.audits('org1'), ['plan_unmatched', 'update_subscription']);
    assert.deepEqual(applied, []);

    await kit.reset();
    await userStore.setOrgSubscription('org1', { status: 'active', payment_status: 'paid', plan_id: plans.A.id, stripe_subscription_id: 'sub_A' });
    await updated(orgSub());
    assert.deepEqual(await kit.audits('org1'), ['update_subscription']);
});

test('a scheduled downgrade that lands clears its bookkeeping in the same write; any other plan keeps it', async () => {
    const pending = { pending_plan_id: plans.B.id, pending_plan_effective: iso(T), stripe_schedule_id: 'sched_1' };
    await userStore.setOrgSubscription('org1', pending);
    await updated(orgSub({ items: items({ id: 'price_Y1' }) }));
    let row = await kit.orgSub('org1');
    assert.deepEqual([row.plan_id, row.pending_plan_id, row.stripe_schedule_id], [plans.Y1.id, plans.B.id, 'sched_1']);

    await updated(orgSub({ items: items({ id: 'price_B' }) }));
    row = await kit.orgSub('org1');
    assert.deepEqual([row.plan_id, row.pending_plan_id, row.pending_plan_effective, row.stripe_schedule_id], [plans.B.id, null, null, null]);
});

test('a failing entitlement re-apply is swallowed: the plan is stored and the change is audited', async () => {
    applyFails = new Error('entitlements down');
    await updated(orgSub({ items: items({ id: 'price_B' }) }));
    assert.equal((await kit.orgSub('org1')).plan_id, plans.B.id);
    assert.deepEqual(await kit.audits('org1'), ['plan_changed_via_stripe', 'update_subscription']);
});

test('under a live manual override only the Stripe-side fields are written and the override is audited', async () => {
    await kit.pg.query(`UPDATE organization_subscriptions SET status = 'suspended', manual_override_until = NOW() + INTERVAL '1 day'`);
    await updated(orgSub({ status: 'active', items: items({ id: 'price_B' }, 9), trial_end: T }));
    const row = await kit.orgSub('org1');
    assert.deepEqual([row.status, row.payment_status, row.plan_id, row.stripe_seat_quantity, isoOf(row.trial_end_date)],
        ['suspended', 'paid', plans.A.id, 9, iso(T)]);
    assert.deepEqual(applied, [], 'a plan held by an override is not re-applied');
    const audits = await auditRows('org1');
    assert.deepEqual(audits.map((a) => a.action), ['manual_override_respected', 'update_subscription']);
    // The stripped payload has no status, so the audit row carries none.
    assert.deepEqual(audits[1].new, { stripe_status: 'active', override_respected: true });

    await kit.pg.query(`UPDATE consumer_subscriptions SET status = 'suspended', manual_override_until = NOW() + INTERVAL '1 day'`);
    await updated(consumerSub({ status: 'active', items: items({ id: 'price_B' }) }));
    const c = await kit.consumerSub('u1');
    assert.deepEqual([c.status, c.plan_id], ['suspended', plans.A.id]);
    assert.deepEqual(await kit.audits('u1'), ['manual_override_respected', 'update_subscription']);
});

test('without an override the full update is written and audited with both statuses', async () => {
    await updated(orgSub({ status: 'unpaid' }));
    assert.deepEqual((await auditRows('org1')).map((a) => a.new), [{ stripe_status: 'unpaid', beeflow_status: 'suspended', override_respected: false }]);
    await updated(consumerSub({ status: 'past_due', items: items({ id: 'price_B' }) }));
    const c = await kit.consumerSub('u1');
    assert.deepEqual([c.status, c.plan_id], ['past_due', plans.B.id]);
    assert.deepEqual((await auditRows('u1')).map((a) => a.new), [{ stripe_status: 'past_due', beeflow_status: 'past_due', override_respected: false }]);
});

test('a consumer plan change is stored without touching org entitlements; an unmatched consumer price is audited', async () => {
    await updated(consumerSub({ items: items({ id: 'price_B' }) }));
    assert.equal((await kit.consumerSub('u1')).plan_id, plans.B.id);
    assert.deepEqual(applied, []);
    await updated(consumerSub({ items: items({ id: 'price_unknown' }) }));
    assert.equal((await kit.consumerSub('u1')).plan_id, plans.B.id);
    const unmatched = (await auditRows('u1')).filter((a) => a.action === 'plan_unmatched');
    assert.deepEqual(unmatched.map((a) => a.new), [{ price_id: 'price_unknown', sub_id: 'sub_C' }]);
});

test('metadata without a subscriber id writes nothing', async () => {
    await updated(orgSub({ metadata: {}, status: 'unpaid' }));
    await updated(consumerSub({ metadata: { beeflow_subscriber_type: 'consumer' }, status: 'unpaid' }));
    assert.equal((await kit.orgSub('org1')).status, 'active');
    assert.equal((await kit.consumerSub('u1')).status, 'active');
    const { rows } = await kit.pg.query('SELECT 1 FROM subscription_audit_log');
    assert.equal(rows.length, 0);
});

test('metadata that claims a subscription another subscriber holds is refused and audited', async () => {
    await updated(orgSub({ metadata: { beeflow_org_id: 'org2' }, status: 'unpaid' }));
    assert.equal((await kit.orgSub('org1')).status, 'active');
    const orgAudit = await auditRows('org2');
    assert.deepEqual(orgAudit, [{ action: 'webhook_metadata_mismatch', old: null, new: { event: 'subscription.updated', sub_id: 'sub_A', claimed: 'org2', local_scope: 'organization', local_id: 'org1' } }]);

    await updated(consumerSub({ id: 'sub_A', status: 'unpaid' }));
    assert.equal((await kit.orgSub('org1')).status, 'active');
    assert.equal((await kit.consumerSub('u1')).status, 'active');
    assert.deepEqual((await auditRows('u1')).map((a) => [a.action, a.new.local_scope, a.new.local_id]), [['webhook_metadata_mismatch', 'organization', 'org1']]);
});

test('customer.subscription.created takes the same path', async () => {
    await deliverOk('customer.subscription.created', orgSub({ status: 'trialing', items: items({ id: 'price_B' }, 2) }));
    const row = await kit.orgSub('org1');
    assert.deepEqual([row.status, row.payment_status, row.plan_id, row.stripe_seat_quantity], ['trialing', 'trialing', plans.B.id, 2]);
});
