/**
 * BFSF-252: the first paid invoice of a subscription sends the customer a
 * confirmation (plan, amount, cycle, next billing date, hosted invoice link),
 * once per subscription; renewals and zero-amount invoices send nothing.
 *
 * Run: cd server && node --test routes/stripe.subscriptionConfirmation.test.js
 */

const assert = require('assert');
const { test } = require('node:test');

// paymentEvents reads its collaborators as module objects (userStore.x(),
// stripeService.x(), emailService.x() at call time), so the test replaces
// properties on the real modules instead of reaching into the module cache.
function stub(path, overrides) {
    Object.assign(require(path), overrides);
}

const claims = new Set();
const sent = [];
const orgSub = { organization_id: 'org_1', stripe_subscription_id: 'sub_A', status: 'incomplete' };
let orgSubs = [orgSub];
let statusWrites = 0;

stub('../services/stripeService', { createPortalSession: async () => ({ url: 'https://portal.example/x' }) });
stub('../stores/userStore', {
    getAllOrgSubscriptions: async () => orgSubs,
    getAllConsumerSubscriptions: async () => [],
    setOrgSubscriptionRespectingOverride: async () => { statusWrites++; return { applied: 'full', overrideActive: false }; },
    resetPaymentFailureForOrg: async () => ({}),
    claimNotification: async (type, id, kind) => {
        const key = `${type}:${id}:${kind}`;
        if (claims.has(key)) return false;
        claims.add(key);
        return true;
    },
    getOrganization: async () => ({ id: 'org_1', name: 'Acme', email: 'billing@acme.example' }),
    getAllPlans: async () => [{ stripe_price_id: 'price_1', name: 'Team', billing_interval: 'monthly' }],
});
stub('../utils/emailService', {
    sendSubscriptionConfirmationEmail: async (opts) => { sent.push(opts); return { success: true }; },
});

const { handleInvoicePaid } = require('./stripe/paymentEvents');

const invoice = (over = {}) => ({
    id: 'in_1',
    subscription: 'sub_A',
    customer: 'cus_1',
    billing_reason: 'subscription_create',
    amount_paid: 4900,
    currency: 'eur',
    hosted_invoice_url: 'https://invoice.stripe.example/i/1',
    lines: { data: [{ price: { id: 'price_1', recurring: { interval: 'month' } }, period: { end: 1900000000 } }] },
    ...over,
});

test('the first paid invoice confirms the subscription to the customer, once', async () => {
    claims.clear(); sent.length = 0;
    await handleInvoicePaid(invoice());
    await handleInvoicePaid(invoice()); // redelivery / second event
    assert.strictEqual(sent.length, 1);
    const m = sent[0];
    assert.strictEqual(m.email, 'billing@acme.example');
    assert.strictEqual(m.planName, 'Team');
    assert.strictEqual(m.amount, 49);
    assert.strictEqual(m.currency, 'eur');
    assert.strictEqual(m.interval, 'monthly');
    assert.strictEqual(m.nextBillingIso, new Date(1900000000 * 1000).toISOString());
    assert.strictEqual(m.invoiceUrl, 'https://invoice.stripe.example/i/1');
});

test('renewals and zero-amount invoices send no confirmation', async () => {
    claims.clear(); sent.length = 0;
    await handleInvoicePaid(invoice({ billing_reason: 'subscription_cycle' }));
    await handleInvoicePaid(invoice({ amount_paid: 0 }));
    assert.strictEqual(sent.length, 0);
});

test('a failing mail never fails the webhook', async () => {
    claims.clear(); sent.length = 0;
    const emailService = require('../utils/emailService');
    const orig = emailService.sendSubscriptionConfirmationEmail;
    emailService.sendSubscriptionConfirmationEmail = async () => { throw new Error('smtp down'); };
    await handleInvoicePaid(invoice());
    emailService.sendSubscriptionConfirmationEmail = orig;
});

test('invoice.paid before any local row holds the subscription still confirms once (metadata)', async () => {
    claims.clear(); sent.length = 0; statusWrites = 0;
    orgSubs = [];
    try {
        const inv = invoice({ subscription_details: { metadata: { beeflow_subscriber_type: 'organization', beeflow_org_id: 'org_1' } } });
        await handleInvoicePaid(inv);
        await handleInvoicePaid(inv); // redelivery
        assert.strictEqual(sent.length, 1);
        assert.strictEqual(sent[0].email, 'billing@acme.example');
        assert.strictEqual(statusWrites, 0, 'no status write for an unresolved subscription row');
    } finally { orgSubs = [orgSub]; }
});

test('invoice.paid before any local row falls back to the Stripe customer id', async () => {
    claims.clear(); sent.length = 0;
    orgSubs = [{ organization_id: 'org_1', stripe_customer_id: 'cus_1', stripe_subscription_id: null }];
    try {
        await handleInvoicePaid(invoice());
        assert.strictEqual(sent.length, 1);
    } finally { orgSubs = [orgSub]; }
});

test('an unresolvable early invoice sends nothing and does not throw', async () => {
    claims.clear(); sent.length = 0;
    orgSubs = [];
    try {
        await handleInvoicePaid(invoice());
        assert.strictEqual(sent.length, 0);
    } finally { orgSubs = [orgSub]; }
});
