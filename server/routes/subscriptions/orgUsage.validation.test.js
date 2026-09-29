/**
 * What the org subscription removal accepts (routes/subscriptions/orgUsage.js).
 *
 * Removing a subscription is immediate and takes nothing but the org on the
 * path. A body carrying `{ reason }` or `{ at_period_end: true }` is a caller
 * that believes it is annotating or scheduling the removal; it used to get a
 * 200 for an immediate one. The two GETs stay open on purpose (see the header
 * of the route file), and that is pinned too, so a later "strict everything"
 * pass does not start refusing a cache-buster.
 *
 * Run: cd server && node --test --test-force-exit routes/subscriptions/orgUsage.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every destructive store call lands in `touched`. A refused request leaves it empty.
const touched = [];

const MOCKS = {
    '../../stores/userStore': {
        getOrgSubscription: async () => ({ organization_id: 'orgA', plan_id: 'p1', billing_model: 'fixed' }),
        deleteOrgSubscription: async (id) => { touched.push({ what: 'deleteOrgSubscription', args: [id] }); return true; },
        logSubscriptionAudit: async () => {},
        getEffectiveLimits: async () => ({ max_messages_per_month: 100 }),
        getBillingPeriod: () => ({ startDate: '2026-09-01T00:00:00.000Z', endDate: '2026-10-01T00:00:00.000Z' }),
    },
    '../../stores/usageStore': {
        getUsageSummary: async () => ({ total_calls: 10, total_tokens: 100, total_estimated_cost: 1 }),
    },
    './shared': {
        getAdminId: () => 'admin',
        requireAuthOrOrgMember: (req, res, next) => next(),
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:subscriptions-org-usage-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /subscriptions[\\/]orgUsage\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./orgUsage');
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

test('a removal with no body removes, the way the admin view sends it', async () => {
    const res = await dispatch({ method: 'DELETE', url: '/orgs/orgA' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { success: true });
    assert.deepStrictEqual(touched, [{ what: 'deleteOrgSubscription', args: ['orgA'] }]);
});

test('a removal that tries to schedule itself is refused by name, instead of being immediate', async () => {
    const res = await dispatch({ method: 'DELETE', url: '/orgs/orgA', body: { at_period_end: true } });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /'at_period_end'/, 'the sentence names the key it would have ignored');
    assert.ok(res.body.details.some((d) => d.path === 'body'));
    assert.deepStrictEqual(touched, [], 'the subscription is still there');
});

test('the usage read stays open to a query it does not read', async () => {
    const res = await dispatch({ method: 'GET', url: '/orgs/orgA/usage', query: { _: '1727000000000' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.usage.messages, 10);
});
