/**
 * What the licence re-issue routes accept (routes/subscriptions/licenseReissue.js).
 *
 * The retry reads everything it issues from the stored subscription, so the
 * body is pinned empty. A caller that sends `{ planId }` believes it is
 * choosing the plan the licence is minted for; it used to get a 200 for a
 * licence minted from the stored plan instead. What this file pins:
 *
 *   - no body, or an empty one, still runs the retry (the admin audit view
 *     posts without a body);
 *   - a body with keys is refused in words that name those keys, and the
 *     licence server is never called.
 *
 * Run: cd server && node --test --test-force-exit routes/subscriptions/licenseReissue.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every licence-server call lands in `touched`. A refused request leaves it empty.
const touched = [];

const SUB = { plan_id: 'p1', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1' };

const MOCKS = {
    '../../stores/userStore': {
        getOrgSubscription: async () => ({ ...SUB }),
        getConsumerSubscription: async () => ({ ...SUB }),
        getPlan: async (id) => ({ id }),
        logSubscriptionAudit: async () => {},
    },
    './shared': { getAdminId: () => 'admin' },
    '../../license/issuance': {
        resolveTierForPlan: () => 'business',
        issueLicenseFromCheckout: async (a) => { touched.push(a); return { licenseId: 'lic_1' }; },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:subscriptions-license-reissue-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /subscriptions[\\/]licenseReissue\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./licenseReissue');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ method, url, body }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, query: {}, headers: {},
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

test('the retry runs with no body at all, the way the audit view posts it', async () => {
    const res = await dispatch({ method: 'POST', url: '/orgs/orgA/reissue-license' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { success: true, license_id: 'lic_1' });
    assert.strictEqual(touched.length, 1);
    assert.strictEqual(touched[0].planId, 'p1', 'the plan comes from the stored subscription');
});

test('an empty body is the same as none', async () => {
    const res = await dispatch({ method: 'POST', url: '/consumer/u1/reissue-license', body: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.length, 1);
    assert.strictEqual(touched[0].scope, 'consumer');
});

test('a plan in the body is refused by name, instead of a licence for the stored plan under a 200', async () => {
    const res = await dispatch({ method: 'POST', url: '/orgs/orgA/reissue-license', body: { planId: 'enterprise' } });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /'planId'/, 'the sentence names the key it would have ignored');
    assert.ok(res.body.details.some((d) => d.path === 'body'));
    assert.deepStrictEqual(touched, [], 'the licence server was not called');
});

test('the consumer retry refuses a body the same way', async () => {
    const res = await dispatch({ method: 'POST', url: '/consumer/u1/reissue-license', body: { tier: 'enterprise' } });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /'tier'/);
    assert.deepStrictEqual(touched, []);
});

test('a body that is not an object is refused in words', async () => {
    const res = await dispatch({ method: 'POST', url: '/orgs/orgA/reissue-license', body: 'retry' });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /takes no body/);
    assert.deepStrictEqual(touched, []);
});
