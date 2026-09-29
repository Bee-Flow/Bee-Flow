/**
 * What starting a purchase accepts, and what it says when it refuses
 * (routes/stripe/checkout.js).
 *
 * Three of the four keys were read for truthiness or type only, so a
 * misspelling was answered with a working Stripe Checkout URL:
 * `{ orgin: 'https://app.example.com' }` fell back to `getOrigin(req)`, so
 * the customer who paid was returned to the API host instead of the app, and
 * `{ successURL: … }` dropped the wizard's landing page without a word. Only
 * `planId` failed loudly, and it failed by naming the key it wanted rather
 * than the one it got.
 *
 * Run: cd server && node --test routes/stripe/checkout.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every Stripe call lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();

const MOCKS = {
    '../../services/stripeService': {
        isEnabled: async () => true,
        listLiveSubscriptions: async () => [],
        createCheckoutSession: async (args) => {
            touched.push({ what: 'createCheckoutSession', args: [args] });
            return { id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' };
        },
        retrieveCheckoutSession: async () => null,
    },
    '../../stores/userStore': {
        getPlan: async (id) => ({ id, price: 9, plan_type: 'consumer', stripe_price_id: 'price_1' }),
        getConsumerSubscription: async () => null,
        getOrgSubscription: async () => null,
        getAllOrganizations: async () => [],
        updatePlan: async () => {},
    },
    '../../auth/ncAudience': { isNcOrg: async () => false },
    './shared': {
        requireCloud: pass,
        requireAuth: pass,
        stripeIpLimiter: pass,
        stripeUserLimiter: pass,
        resolveOrgIdForUser: async () => null,   // consumer path
        getOrigin: () => 'https://api.example.test',
    },
    './checkoutEvents': { handleCheckoutCompleted: async () => {} },
    '../../auth/consentGuards': {
        validateWaiver: (w) => (w && w.accepted === true
            ? { ok: true }
            : { ok: false, status: 400, error: 'waiver required', code: 'WAIVER_REQUIRED' }),
        recordWaiver: async () => {},
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:stripe-checkout-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /stripe[\\/]checkout\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./checkout');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ method, url, query = {}, body = {} }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, query, headers: {},
            session: { user: { id: 'u1', email: 'u1@example.test', isConsumerAccount: true }, isAuthenticated: true },
            get() { return undefined; },
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

const APP = 'https://app.example.test';
const paid = (over = {}) => ({ planId: 'pro', origin: APP, withdrawalWaiver: { accepted: true }, ...over });

test.beforeEach(() => { touched.length = 0; });

test('a misspelled origin is refused, not answered with a post-payment return to the API host', async () => {
    const res = await dispatch({ method: 'POST', url: '/checkout', body: { planId: 'pro', orgin: APP, withdrawalWaiver: { accepted: true } } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(/orgin/.test(res.body.error), `the 400 names the key: ${res.body.error}`);
    assert.deepStrictEqual(touched, [], 'no checkout session was created');
});

test('a misspelled successUrl is refused rather than quietly dropped', async () => {
    const res = await dispatch({ method: 'POST', url: '/checkout', body: paid({ successURL: `${APP}/done` }) });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(/successURL/.test(res.body.error), `the 400 names the key: ${res.body.error}`);
    assert.deepStrictEqual(touched, []);
});

test('a missing plan is refused in words, not with "planId is required"', async () => {
    const res = await dispatch({ method: 'POST', url: '/checkout', body: { origin: APP } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'planId is required — the plan to subscribe to.');
    assert.ok(res.body.details.some((d) => d.path === 'body.planId'));
    assert.deepStrictEqual(touched, []);
});

test('a plan id of the wrong TYPE is refused by name, instead of being called missing', async () => {
    const res = await dispatch({ method: 'POST', url: '/checkout', body: paid({ planId: 42 }) });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.planId'));
    assert.deepStrictEqual(touched, []);
});

test('an origin that is not a bare http(s) origin cannot be smuggled into the return URL', async () => {
    for (const origin of ['javascript:alert(1)', 'https://evil.test/path', 'app.example.test']) {
        const res = await dispatch({ method: 'POST', url: '/checkout', body: paid({ origin }) });
        assert.strictEqual(res.statusCode, 400, `refused: ${origin}`);
        assert.strictEqual(res.body.error, 'origin must be a URL like https://app.example.com.');
    }
    assert.deepStrictEqual(touched, []);
});

test('the waiver gate still answers a paid consumer plan that arrives without one', async () => {
    const res = await dispatch({ method: 'POST', url: '/checkout', body: { planId: 'pro', origin: APP } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'WAIVER_REQUIRED');
    assert.deepStrictEqual(touched, []);
});

test('the body the licence page sends still reaches Stripe, with its own origin', async () => {
    const res = await dispatch({ method: 'POST', url: '/checkout', body: paid() });
    assert.strictEqual(res.statusCode, 200);
    const args = touched.find((t) => t.what === 'createCheckoutSession').args[0];
    assert.ok(args.successUrl.startsWith(APP), `returns to the app: ${args.successUrl}`);
    assert.ok(args.cancelUrl.startsWith(APP));
});

test('a caller-supplied successUrl under its own origin is still honoured', async () => {
    const res = await dispatch({ method: 'POST', url: '/checkout', body: paid({ successUrl: `${APP}/app/wizard?done=1` }) });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'createCheckoutSession').args[0].successUrl, `${APP}/app/wizard?done=1`);
});
