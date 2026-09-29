/**
 * BFSF-241 — server-side gate on POST /api/stripe/portal.
 *
 * The client hides the "Manage billing" button for non-paying users
 * (9d5f8a5c), but the route itself opened a portal session for anyone with a
 * stripe_customer_id — and trial/free customers get one early (trialService,
 * org checkout pre-create). Pins: trialing → 403 portal_not_eligible;
 * paid/past_due/FAILED → 200 ('failed' is a genuinely-paying dunning state —
 * webhook ordering vs 'past_due' is nondeterministic); no customer → 400;
 * self-hosted → 404.
 *
 * Require-cache stub harness (same seam as stripe.subscriptionDeleted.test.js);
 * ../auth/permissions must stub requireAuth AND resolveUserOrgIds AND
 * hasPermission (destructured at module level elsewhere in the router).
 *
 * Run: cd server && node --test routes/stripe.portal.test.js
 */

const assert = require('assert');
const { test } = require('node:test');

// ── Fixtures ─────────────────────────────────────────────────────────
let consumerSub = null;
let orgSub = null;
let sessionUser = { id: 'u1', isConsumerAccount: true };
const portalCalls = [];

function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

stub('../services/stripeService', {
    isEnabled: async () => true,
    createPortalSession: async (customerId, returnUrl) => {
        portalCalls.push({ customerId, returnUrl });
        return { url: 'https://billing.stripe.com/session/x' };
    },
    constructWebhookEvent: async () => { throw new Error('not used'); },
});

stub('../stores/userStore', {
    getConsumerSubscription: async () => consumerSub,
    getOrgSubscription: async () => orgSub,
    getUser: async () => ({ id: 'u1', organizationId: sessionUser.isConsumerAccount ? null : 'orgA' }),
    getAllOrgSubscriptions: async () => [],
    getAllConsumerSubscriptions: async () => [],
    recordStripeEventProcessed: async () => true,
});

stub('../auth/permissions', {
    requireAuth: (req, res, next) => next(),
    resolveUserOrgIds: async () => (sessionUser.isConsumerAccount ? new Set() : new Set(['orgA'])),
    hasPermission: async () => true,
});

stub('../utils/perUserRateLimit', {
    perUserRateLimit: () => (req, res, next) => next(),
});

const router = require('./stripe');

function dispatch({ body = {} } = {}) {
    return new Promise((resolve, reject) => {
        const req = {
            method: 'POST',
            url: '/portal',
            ip: '203.0.113.9',
            protocol: 'https',
            headers: { host: 'app.example' },
            body,
            session: { user: sessionUser },
            get(name) { return this.headers[String(name).toLowerCase()]; },
        };
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(req, res, (err) => reject(err || new Error('fell through router: POST /portal')));
    });
}

function reset({ consumer = true } = {}) {
    sessionUser = consumer ? { id: 'u1', isConsumerAccount: true } : { id: 'u1', organizationId: 'orgA' };
    consumerSub = null;
    orgSub = null;
    portalCalls.length = 0;
    delete process.env.DEPLOYMENT_MODE;
}

test('trialing consumer → 403 portal_not_eligible (the BFSF-241 bypass)', async () => {
    reset();
    consumerSub = { stripe_customer_id: 'cus_1', payment_status: 'trialing' };
    const res = await dispatch();
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.code, 'portal_not_eligible');
    assert.strictEqual(portalCalls.length, 0, 'no portal session created');
});

test('paid consumer → 200 with a portal url', async () => {
    reset();
    consumerSub = { stripe_customer_id: 'cus_1', payment_status: 'paid' };
    const res = await dispatch();
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.url.startsWith('https://billing.stripe.com/'));
});

test("dunning states keep access: past_due AND 'failed' → 200", async () => {
    reset({ consumer: false });
    orgSub = { stripe_customer_id: 'cus_org', payment_status: 'past_due' };
    let res = await dispatch();
    assert.strictEqual(res.statusCode, 200, 'past_due keeps portal access');

    reset({ consumer: false });
    orgSub = { stripe_customer_id: 'cus_org', payment_status: 'failed' };
    res = await dispatch();
    assert.strictEqual(res.statusCode, 200, "'failed' is set by invoice.payment_failed for paying customers — they NEED the portal to fix their payment method");
});

test('trialing org → 403; no customer id → 400 (existing message)', async () => {
    reset({ consumer: false });
    orgSub = { stripe_customer_id: 'cus_org', payment_status: 'trialing' };
    let res = await dispatch();
    assert.strictEqual(res.statusCode, 403);

    reset({ consumer: false });
    orgSub = { payment_status: 'paid' }; // no stripe_customer_id
    res = await dispatch();
    assert.strictEqual(res.statusCode, 400);
});

test('self-hosted deployments → 404 not_available_in_self_hosted', async () => {
    reset();
    process.env.DEPLOYMENT_MODE = 'self-hosted';
    consumerSub = { stripe_customer_id: 'cus_1', payment_status: 'paid' };
    const res = await dispatch();
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(res.body.error, 'not_available_in_self_hosted');
    delete process.env.DEPLOYMENT_MODE;
});
