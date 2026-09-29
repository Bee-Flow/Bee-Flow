/**
 * invoice.paid must not resurrect an admin-suspended subscription.
 *
 * `status` and `payment_status` are the admin-controlled columns the manual
 * override protects (see `stripOverriddenFields` and `handleSubscriptionUpdated`,
 * which route the same fields through setOrg/ConsumerSubscriptionRespecting-
 * Override). handleInvoicePaid used to write them with the PLAIN setter, so an
 * org an operator had suspended under an override — abuse or chargeback
 * investigation, Stripe subscription deliberately left live — was flipped back
 * to `active` by the next renewal invoice and regained full paid AI access,
 * with the override row still visibly pinned in the admin UI.
 *
 * We drive the REAL Express router (POST /webhook) with a stubbed req/res — no
 * HTTP listener, no DB — exactly like routes/stripe.subscriptionDeleted.test.js.
 * The userStore double reimplements setOrgSubscriptionRespectingOverride's
 * decision faithfully: override live ⇒ use the stripped payload; empty stripped
 * payload ⇒ no write at all.
 *
 * Run: cd server && node --test routes/stripe.invoicePaid.test.js
 */

const assert = require('assert');
const { test } = require('node:test');

// ── Fixtures / spies, reset per test ────────────────────────────────────────
let orgRow = null;
let consumerRow = null;
const writes = [];        // every actual row write, plain or override-aware
const overrideCalls = []; // calls that went through the override-aware writer
const auditCalls = [];
const dunningResets = [];

function resetSpies() {
    writes.length = 0;
    overrideCalls.length = 0;
    auditCalls.length = 0;
    dunningResets.length = 0;
    orgRow = null;
    consumerRow = null;
}

const overrideLive = (row) =>
    !!row?.manual_override_until && new Date(row.manual_override_until).getTime() > Date.now();

// Mirrors stores/userStore.js:setOrg/ConsumerSubscriptionRespectingOverride.
function respectingOverride(scope, row) {
    return async (id, fullUpdate, strippedUpdate) => {
        const active = overrideLive(row);
        overrideCalls.push({ scope, id, fullUpdate, strippedUpdate, overrideActive: active });
        const payload = active ? strippedUpdate : fullUpdate;
        if (!payload || Object.keys(payload).length === 0) return { applied: 'none', overrideActive: active };
        writes.push({ scope, id, data: payload, via: 'override-aware' });
        return { applied: active ? 'stripped' : 'full', overrideActive: active };
    };
}

function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

let nextEvent = null;

stub('../services/stripeService', {
    constructWebhookEvent: async () => nextEvent,
});

stub('../stores/userStore', {
    recordStripeEventProcessed: async () => true,
    getAllOrgSubscriptions: async () => (orgRow ? [orgRow] : []),
    getAllConsumerSubscriptions: async () => (consumerRow ? [consumerRow] : []),
    getOrgSubscription: async () => orgRow,
    getConsumerSubscription: async () => consumerRow,
    setOrgSubscription: async (id, data) => { writes.push({ scope: 'org', id, data, via: 'plain' }); return true; },
    setConsumerSubscription: async (id, data) => { writes.push({ scope: 'consumer', id, data, via: 'plain' }); return true; },
    setOrgSubscriptionRespectingOverride: (id, f, s) => respectingOverride('org', orgRow)(id, f, s),
    setConsumerSubscriptionRespectingOverride: (id, f, s) => respectingOverride('consumer', consumerRow)(id, f, s),
    resetPaymentFailureForOrg: async (id) => { dunningResets.push({ scope: 'org', id }); return {}; },
    resetPaymentFailureForConsumer: async (id) => { dunningResets.push({ scope: 'consumer', id }); return {}; },
    logSubscriptionAudit: async (action, targetType, targetId, changedBy, oldV, newV) => {
        auditCalls.push({ action, targetType, targetId, newV });
    },
});

const router = require('./stripe');

function dispatch() {
    return new Promise((resolve, reject) => {
        const req = {
            method: 'POST', url: '/webhook', ip: '203.0.113.9',
            headers: { 'stripe-signature': 'sig_test' }, body: {},
            get(n) { return this.headers[String(n).toLowerCase()]; },
        };
        const res = {
            statusCode: 200, headers: {}, body: undefined,
            set(k, v) { this.headers[k] = v; return this; },
            setHeader(k, v) { this.headers[k] = v; },
            getHeader(k) { return this.headers[k]; },
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(req, res, (err) => reject(err || new Error('fell through router: POST /webhook')));
    });
}

const invoicePaidEvent = () => ({
    id: `evt_${Math.random().toString(36).slice(2)}`,
    type: 'invoice.paid',
    data: { object: { id: 'in_1', subscription: 'sub_A' } },
});

const IN_A_WEEK = () => new Date(Date.now() + 7 * 86400_000).toISOString();
const A_WEEK_AGO = () => new Date(Date.now() - 7 * 86400_000).toISOString();

// ═══════════════════════════════════════════════════════════════════════════
// Org — the finding
// ═══════════════════════════════════════════════════════════════════════════

test('an admin-suspended org is NOT reactivated by a renewal invoice', async () => {
    resetSpies();
    orgRow = {
        organization_id: 'org_1',
        stripe_subscription_id: 'sub_A',
        status: 'suspended',
        payment_status: 'unpaid',
        manual_override_until: IN_A_WEEK(),
        manual_override_by: 'admin_1',
    };
    nextEvent = invoicePaidEvent();

    const res = await dispatch();

    assert.strictEqual(res.statusCode, 200, 'webhook still acks 200');
    assert.strictEqual(writes.length, 0, 'no status/payment_status write while the pin holds');
    assert.strictEqual(overrideCalls.length, 1, 'the write went through the override-aware setter');
    assert.deepStrictEqual(overrideCalls[0].strippedUpdate, {},
        'both fields are admin-controlled, so the stripped payload is empty');
    assert.ok(
        auditCalls.some(a => a.action === 'manual_override_respected' && a.targetId === 'org_1'),
        'the respected override is audited so the operator can see it happened',
    );
});

test('the dunning counter is still reset under an active override', async () => {
    resetSpies();
    orgRow = {
        organization_id: 'org_1', stripe_subscription_id: 'sub_A',
        status: 'suspended', manual_override_until: IN_A_WEEK(),
    };
    nextEvent = invoicePaidEvent();

    await dispatch();

    assert.deepStrictEqual(dunningResets, [{ scope: 'org', id: 'org_1' }],
        'Stripe-side bookkeeping is not an admin-controlled field');
});

test('with no override the org is flipped back to active/paid as before', async () => {
    resetSpies();
    orgRow = {
        organization_id: 'org_1', stripe_subscription_id: 'sub_A',
        status: 'past_due', payment_status: 'failed', manual_override_until: null,
    };
    nextEvent = invoicePaidEvent();

    await dispatch();

    assert.strictEqual(writes.length, 1, 'exactly one write');
    assert.deepStrictEqual(writes[0].data, { status: 'active', payment_status: 'paid' });
    assert.strictEqual(writes[0].id, 'org_1');
    assert.strictEqual(
        auditCalls.filter(a => a.action === 'manual_override_respected').length, 0,
        'nothing to respect, nothing audited',
    );
});

test('an EXPIRED override no longer blocks reactivation', async () => {
    resetSpies();
    orgRow = {
        organization_id: 'org_1', stripe_subscription_id: 'sub_A',
        status: 'suspended', manual_override_until: A_WEEK_AGO(), manual_override_by: 'admin_1',
    };
    nextEvent = invoicePaidEvent();

    await dispatch();

    assert.strictEqual(writes.length, 1, 'the pin has lapsed — Stripe wins again');
    assert.deepStrictEqual(writes[0].data, { status: 'active', payment_status: 'paid' });
});

// ═══════════════════════════════════════════════════════════════════════════
// Consumer — same contract on the twin path
// ═══════════════════════════════════════════════════════════════════════════

test('a suspended consumer under an override is not reactivated either', async () => {
    resetSpies();
    consumerRow = {
        user_id: 'user_1', stripe_subscription_id: 'sub_A',
        status: 'suspended', manual_override_until: IN_A_WEEK(),
    };
    nextEvent = invoicePaidEvent();

    await dispatch();

    assert.strictEqual(writes.length, 0, 'no write while the pin holds');
    assert.strictEqual(overrideCalls[0].scope, 'consumer');
    assert.ok(auditCalls.some(a => a.action === 'manual_override_respected' && a.targetType === 'consumer'));
});

test('an unpinned consumer is flipped back to active/paid', async () => {
    resetSpies();
    consumerRow = { user_id: 'user_1', stripe_subscription_id: 'sub_A', status: 'past_due' };
    nextEvent = invoicePaidEvent();

    await dispatch();

    assert.strictEqual(writes.length, 1);
    assert.deepStrictEqual(writes[0].data, { status: 'active', payment_status: 'paid' });
    assert.strictEqual(writes[0].scope, 'consumer');
});
