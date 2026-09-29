/**
 * What the subscription lifecycle routes accept, and what they say when they
 * refuse (routes/subscriptions/lifecycle.js).
 *
 * These routes take `planId`; the two start-trial routes in the same API take
 * `plan_id`. A truthiness check on one spelling answered the other with
 * "planId is required", which reads like the caller forgot a field rather than
 * spelled it the other way — so the refusal now names the key that WAS sent.
 *
 * cancel / reactivate / cancel-downgrade take nothing at all. That is worth
 * pinning: they act on the subscription that is already there, so a body
 * carrying a plan is a caller that believes it is choosing one.
 *
 * Run: cd server && node --test --test-force-exit routes/subscriptions/lifecycle.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every Stripe-touching call lands in `touched`. A refused request leaves it empty.
const touched = [];

const SUB = {
    organization_id: 'orgA', user_id: 'u1', plan_id: 'p-old',
    stripe_subscription_id: 'sub_1', cancel_at_period_end: false, pending_plan_id: null,
};

const MOCKS = {
    '../../stores/userStore': {
        getOrgSubscription: async () => ({ ...SUB }),
        getConsumerSubscription: async () => ({ ...SUB }),
        getPlan: async (id) => ({ id, price: id === 'p-old' ? 10 : 20, billing_interval: 'monthly', plan_type: 'organization', stripe_price_id: 'price_x' }),
        getActiveSeatCount: async () => 3,
        setOrgSubscription: async (...args) => { touched.push({ what: 'setOrgSubscription', args }); },
        setConsumerSubscription: async (...args) => { touched.push({ what: 'setConsumerSubscription', args }); },
        logSubscriptionAudit: async () => {},
    },
    '../../auth/ncAudience': { isNcOrg: async () => true },
    './shared': { getAdminId: () => 'admin' },
    '../../services/stripeService': {
        updateSubscriptionPlan: async (a) => { touched.push({ what: 'updateSubscriptionPlan', args: [a] }); return { current_period_end: 0 }; },
        releaseSubscriptionSchedule: async () => {},
        scheduleDowngradeAtPeriodEnd: async () => ({ effective: null, scheduleId: 'sch_1' }),
        previewPlanChange: async () => ({ currency: 'EUR', proration_amount: 1 }),
        cancelSubscriptionAtPeriodEnd: async (id) => { touched.push({ what: 'cancel', args: [id] }); return { cancel_at: 0, current_period_end: 0 }; },
        reactivateSubscription: async (id) => { touched.push({ what: 'reactivate', args: [id] }); },
    },
    '../../services/planEntitlements': { applyPlanToOrg: async () => {} },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:subscriptions-lifecycle-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /subscriptions[\\/]lifecycle\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./lifecycle');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ method, url, query = {}, body }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, query, headers: {},
            session: { user: { id: 'admin' }, isAuthenticated: true, isAdmin: true }, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: ${method} ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => { touched.length = 0; });

test('the other spelling of the plan key is named, not reported as a missing field alone', async () => {
    const res = await dispatch({ method: 'POST', url: '/orgs/orgA/upgrade', body: { plan_id: 'p-new' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'planId is required — the plan to change to.');
    assert.ok(
        res.body.details.some((d) => /plan_id/.test(d.message)),
        `the details name the key that was sent: ${JSON.stringify(res.body.details)}`,
    );
    assert.deepStrictEqual(touched, [], 'Stripe was not called');
});

test('an empty planId is refused in words, not passed on as a plan lookup', async () => {
    const res = await dispatch({ method: 'POST', url: '/orgs/orgA/upgrade', body: { planId: '   ' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'planId is required — the plan to change to.');
    assert.deepStrictEqual(touched, []);
});

test('a real plan change still reaches Stripe', async () => {
    const res = await dispatch({ method: 'POST', url: '/orgs/orgA/upgrade', body: { planId: 'p-new' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'updateSubscriptionPlan').args[0].newPriceId, 'price_x');
});

test('the preview takes the same key and refuses the same way', async () => {
    const res = await dispatch({ method: 'POST', url: '/orgs/orgA/preview-change', body: {} });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'planId is required — the plan to change to.');
});

test('cancel takes no body at all — and still works when the client sends none', async () => {
    const res = await dispatch({ method: 'POST', url: '/orgs/orgA/cancel', body: undefined });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.what === 'cancel').args, ['sub_1']);
});

test('a body on cancel is refused, rather than accepted and ignored', async () => {
    const res = await dispatch({ method: 'POST', url: '/orgs/orgA/cancel', body: { planId: 'p-new' } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(/planId/.test(res.body.error), `the 400 names the key: ${res.body.error}`);
    assert.deepStrictEqual(touched, [], 'nothing was cancelled');
});

test('reactivate on a consumer account takes no body either', async () => {
    const res = await dispatch({ method: 'POST', url: '/consumer/u1/reactivate', body: undefined });
    assert.strictEqual(res.statusCode, 409, 'this fixture is not scheduled to cancel');
    assert.deepStrictEqual(touched, []);
});
