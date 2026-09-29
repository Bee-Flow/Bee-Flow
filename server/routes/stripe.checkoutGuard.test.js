/**
 * POST /api/stripe/checkout — org-admin gate + duplicate-subscription guard.
 *
 * Two regressions this guards:
 *
 * 1. Double billing. Checkout in `mode: 'subscription'` always mints a NEW
 *    Stripe subscription on the customer, and `handleCheckoutCompleted`
 *    overwrites the single local `stripe_subscription_id` with it. The old
 *    subscription was neither cancelled nor recorded, so the org paid for two
 *    concurrent subscriptions while the product knew about one — the orphan is
 *    invisible in the app and no code path can ever cancel it. The route now
 *    asks STRIPE (not the local mirror, which is exactly what goes stale in the
 *    stale-tab / second-admin race) whether the customer is still subscribed.
 *
 * 2. Authorization. The route was gated by `requireAuth` only, so any member of
 *    the org could repoint its billing relationship and change its plan and
 *    entitlements — bypassing the `isOrgAdminForOrg` gate the sibling lifecycle
 *    routes in subscriptions.js use for exactly this.
 *
 * DB-free and Stripe-free: the module-level deps of routes/stripe.js are
 * replaced in require.cache and we drive the real router with a stub req/res.
 *
 * Run: cd server && node --test routes/stripe.checkoutGuard.test.js
 */

const assert = require('assert');
const { test } = require('node:test');

// ── Fixtures / spies ────────────────────────────────────────────────────────
let liveSubs = [];              // what Stripe reports for the customer
let liveSubsError = null;       // set to make the Stripe lookup fail
let orgSubRow = null;
let consumerSubRow = null;
let isAdmin = true;
let isConsumerAccount = false;
let planIsNcOnly = false;       // the plan being bought carries nc_only
let orgRow = { id: 'org_1', name: 'Acme' };
let orgLookupError = null;      // set to make the NC-audience lookup fail
const sessionsCreated = [];

function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

stub('../services/stripeService', {
    isEnabled: async () => true,
    listLiveSubscriptions: async () => {
        if (liveSubsError) throw liveSubsError;
        return liveSubs;
    },
    createCheckoutSession: async (args) => {
        sessionsCreated.push(args);
        return { id: 'cs_new', url: 'https://checkout.stripe.test/cs_new' };
    },
    syncPlanToStripe: async () => ({ productId: 'prod_1', priceId: 'price_1' }),
    syncPaygPlanToStripe: async () => ({ productId: 'prod_1', priceId: 'price_1' }),
});

stub('../stores/userStore', {
    getPlan: async (id) => ({
        id, name: 'Pro', description: '', price: 49, currency: 'eur',
        billing_interval: 'monthly',
        plan_type: isConsumerAccount ? 'consumer' : 'organization',
        stripe_price_id: 'price_pro',
        nc_only: planIsNcOnly,
    }),
    updatePlan: async () => true,
    getOrgSubscription: async () => orgSubRow,
    getConsumerSubscription: async () => consumerSubRow,
    getAllOrganizations: async () => [{ id: 'org_1', name: 'Acme' }],
    getUser: async (id) => ({ id, organizationId: 'org_1' }),
    // Read by auth/ncAudience to decide whether the org is a Nextcloud one.
    getOrganization: async () => {
        if (orgLookupError) throw orgLookupError;
        return orgRow;
    },
});

stub('../stores/configStore', { getConfig: async () => null });

stub('../auth/permissions', {
    requireAuth: (req, res, next) => next(),
    resolveUserOrgIds: async () => new Set(['org_1']),
    isOrgAdminForOrg: async () => isAdmin,
    hasPermission: async () => true,
});

// Consumer checkout records a withdrawal waiver; keep it out of the way. The
// consumer bodies below still carry the REAL waiver shape, `{ accepted: true }`
// — what ConsumerLicenseSection posts — because the route's schema reads it
// before this stub ever does.
stub('../auth/consentGuards', {
    validateWaiver: () => ({ ok: true }),
    recordWaiver: async () => true,
});

const router = require('./stripe');

function dispatch(body) {
    return new Promise((resolve, reject) => {
        const req = {
            method: 'POST', url: '/checkout', originalUrl: '/checkout', baseUrl: '', path: '/checkout',
            ip: `203.0.113.${Math.floor(Math.random() * 200) + 1}`,   // stay under the IP limiter
            protocol: 'https', headers: {}, body, params: {}, query: {},
            session: {
                isAuthenticated: true,
                user: {
                    id: `u${Math.random().toString(36).slice(2, 8)}`,  // stay under the per-user limiter
                    email: 'member@acme.test',
                    organizationId: isConsumerAccount ? null : 'org_1',
                    isConsumerAccount,
                },
            },
            get(n) { return n === 'host' ? 'app.beeflow.test' : undefined; },
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
        router(req, res, (err) => reject(err || new Error('fell through router: POST /checkout')));
    });
}

test.beforeEach(() => {
    liveSubs = [];
    liveSubsError = null;
    isAdmin = true;
    isConsumerAccount = false;
    planIsNcOnly = false;
    orgRow = { id: 'org_1', name: 'Acme' };
    orgLookupError = null;
    orgSubRow = { organization_id: 'org_1', stripe_customer_id: null };
    consumerSubRow = null;
    sessionsCreated.length = 0;
});

// ═══════════════════════════════════════════════════════════════════════════
// Duplicate-subscription guard
// ═══════════════════════════════════════════════════════════════════════════

test('a second checkout for an org Stripe still bills is refused', async () => {
    orgSubRow = { organization_id: 'org_1', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_A', status: 'active' };
    liveSubs = [{ id: 'sub_A', status: 'active' }];

    const res = await dispatch({ planId: 'plan_B' });

    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.error, 'already_subscribed');
    assert.strictEqual(sessionsCreated.length, 0, 'no second Stripe subscription is minted');
});

test('a trialing subscription also blocks — converting it must not orphan it', async () => {
    orgSubRow = { organization_id: 'org_1', stripe_customer_id: 'cus_1' };
    liveSubs = [{ id: 'sub_T', status: 'trialing' }];

    const res = await dispatch({ planId: 'plan_B' });

    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.subscription_status, 'trialing');
    assert.strictEqual(sessionsCreated.length, 0);
});

test('a cancelled subscription does not block re-subscribing', async () => {
    orgSubRow = { organization_id: 'org_1', stripe_customer_id: 'cus_1' };
    liveSubs = [];   // listLiveSubscriptions filters cancelled/incomplete out

    const res = await dispatch({ planId: 'plan_B' });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(sessionsCreated.length, 1);
});

test('a first-ever checkout (no Stripe customer yet) never calls Stripe for this', async () => {
    orgSubRow = { organization_id: 'org_1', stripe_customer_id: null };
    liveSubsError = new Error('listLiveSubscriptions must not be called without a customer');

    const res = await dispatch({ planId: 'plan_B' });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(sessionsCreated.length, 1);
});

test('a failed Stripe lookup fails CLOSED, it does not wave the purchase through', async () => {
    orgSubRow = { organization_id: 'org_1', stripe_customer_id: 'cus_1' };
    liveSubsError = new Error('Stripe API unreachable');

    const res = await dispatch({ planId: 'plan_B' });

    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.error, 'subscription_state_unavailable');
    assert.strictEqual(sessionsCreated.length, 0, 'undoing a duplicate costs more than a retry');
});

test('the consumer path carries the same guard', async () => {
    isConsumerAccount = true;
    consumerSubRow = { user_id: 'u1', stripe_customer_id: 'cus_2' };
    liveSubs = [{ id: 'sub_C', status: 'active' }];

    const res = await dispatch({ planId: 'plan_B', withdrawalWaiver: { accepted: true } });

    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(sessionsCreated.length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// Org-admin gate
// ═══════════════════════════════════════════════════════════════════════════

test('a non-admin org member cannot start an org checkout', async () => {
    isAdmin = false;

    const res = await dispatch({ planId: 'plan_B' });

    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.error, 'org_admin_required');
    assert.strictEqual(sessionsCreated.length, 0, 'no plan/entitlement change by a plain member');
});

test('the admin gate runs before any Stripe plan sync', async () => {
    isAdmin = false;
    let synced = false;
    const svc = require('../services/stripeService');
    const orig = svc.syncPlanToStripe;
    svc.syncPlanToStripe = async () => { synced = true; return { productId: 'p', priceId: 'pr' }; };
    try {
        const res = await dispatch({ planId: 'plan_B' });
        assert.strictEqual(res.statusCode, 403);
    } finally {
        svc.syncPlanToStripe = orig;
    }
    assert.strictEqual(synced, false, 'a non-admin never drives Stripe product/price writes');
});

test('an org admin still gets a checkout session', async () => {
    isAdmin = true;

    const res = await dispatch({ planId: 'plan_B' });

    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.url, 'checkout url returned');
    assert.strictEqual(sessionsCreated[0].subscriberType, 'organization');
});

test('a consumer account is not subjected to the org-admin gate', async () => {
    isConsumerAccount = true;
    isAdmin = false;                 // irrelevant for a consumer
    consumerSubRow = null;

    const res = await dispatch({ planId: 'plan_B', withdrawalWaiver: { accepted: true } });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(sessionsCreated[0].subscriberType, 'consumer');
});

// ═══════════════════════════════════════════════════════════════════════════
// Nextcloud-only plans
//
// The listing endpoints hide these, but a plan id is all this route needs —
// so the audience restriction has to be enforced here, not just presented.
// ═══════════════════════════════════════════════════════════════════════════

test('a plain org cannot buy a plan restricted to Nextcloud organisations', async () => {
    planIsNcOnly = true;
    orgRow = { id: 'org_1', name: 'Acme' };   // no nc_instance_id, no registration_source

    const res = await dispatch({ planId: 'plan_NC' });

    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.error, 'plan_not_available_for_org');
    assert.strictEqual(sessionsCreated.length, 0);
});

test('an org bound to a Nextcloud instance can buy it', async () => {
    planIsNcOnly = true;
    orgRow = { id: 'org_1', name: 'Acme', nc_instance_id: 'nc-abc' };

    const res = await dispatch({ planId: 'plan_NC' });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(sessionsCreated.length, 1);
});

test('registration_source alone also qualifies — an unbound NC org keeps its plan', async () => {
    planIsNcOnly = true;
    orgRow = { id: 'org_1', name: 'Acme', registrationSource: 'nextcloud_connector' };

    const res = await dispatch({ planId: 'plan_NC' });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(sessionsCreated.length, 1);
});

test('a consumer cannot buy an nc_only plan — no org, no audience', async () => {
    planIsNcOnly = true;
    isConsumerAccount = true;
    consumerSubRow = null;

    const res = await dispatch({ planId: 'plan_NC', withdrawalWaiver: { accepted: true } });

    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.error, 'plan_not_available_for_org');
    assert.strictEqual(sessionsCreated.length, 0);
});

test('a failed org lookup fails CLOSED rather than granting the restricted plan', async () => {
    planIsNcOnly = true;
    orgLookupError = new Error('database unreachable');

    const res = await dispatch({ planId: 'plan_NC' });

    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.error, 'plan_policy_unavailable');
    assert.strictEqual(sessionsCreated.length, 0);
});

test('an unrestricted plan is unaffected by the NC audience check', async () => {
    planIsNcOnly = false;
    orgLookupError = new Error('getOrganization must not be called for an open plan');

    const res = await dispatch({ planId: 'plan_B' });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(sessionsCreated.length, 1);
});
