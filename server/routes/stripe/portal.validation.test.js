/**
 * What the Customer Portal hand-off accepts, and what it says when it refuses
 * (routes/stripe/portal.js).
 *
 * One key, and it is the URL Stripe returns the customer to after they have
 * changed their card or cancelled. `{ orgin: 'https://app.example.com' }` fell
 * through to `getOrigin(req)`, so the customer came back to the API host — a
 * bare JSON 404 — with the route answering 200 and a portal URL that looked
 * entirely right.
 *
 * Run: cd server && node --test routes/stripe/portal.validation.test.js
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
        createPortalSession: async (customerId, returnUrl) => {
            touched.push({ what: 'createPortalSession', args: [customerId, returnUrl] });
            return { url: 'https://billing.stripe.test/session' };
        },
    },
    '../../stores/userStore': {
        getConsumerSubscription: async () => ({ stripe_customer_id: 'cus_1', payment_status: 'paid' }),
        getOrgSubscription: async () => ({ stripe_customer_id: 'cus_1', payment_status: 'paid' }),
    },
    './shared': {
        requireCloud: pass,
        requireAuth: pass,
        stripeIpLimiter: pass,
        stripeUserLimiter: pass,
        resolveOrgIdForUser: async () => null,   // consumer path
        getOrigin: () => 'https://api.example.test',
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:stripe-portal-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /stripe[\\/]portal\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./portal');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ method, url, query = {}, body = {} }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, query, headers: {},
            session: { user: { id: 'u1', isConsumerAccount: true }, isAuthenticated: true },
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

test.beforeEach(() => { touched.length = 0; });

test('a misspelled origin is refused, not answered with a return to the API host', async () => {
    const res = await dispatch({ method: 'POST', url: '/portal', body: { orgin: APP } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(/orgin/.test(res.body.error), `the 400 names the key: ${res.body.error}`);
    assert.deepStrictEqual(touched, [], 'no portal session was created');
});

test('an origin that is not a bare http(s) origin is refused in words', async () => {
    const res = await dispatch({ method: 'POST', url: '/portal', body: { origin: `${APP}/app/settings` } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'origin must be a URL like https://app.example.com.');
    assert.ok(res.body.details.some((d) => d.path === 'body.origin'));
    assert.deepStrictEqual(touched, []);
});

test("the licence page's own origin still lands the customer back in the app", async () => {
    const res = await dispatch({ method: 'POST', url: '/portal', body: { origin: APP } });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(touched[0].args[1].startsWith(APP), `returns to the app: ${touched[0].args[1]}`);
});

test('no body at all still falls back to the request host, as it always did', async () => {
    const res = await dispatch({ method: 'POST', url: '/portal', body: undefined });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(touched[0].args[1].startsWith('https://api.example.test'));
});
