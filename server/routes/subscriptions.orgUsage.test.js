/**
 * DB-free test — GET /api/subscriptions/orgs/:orgId/usage reports real spend.
 *
 * The regression this guards: the handler read `usage.estimated_cost`, but
 * usageStore.getUsageSummary aliases the column as `total_estimated_cost`
 * (there is no `estimated_cost` key on the row). `undefined || 0` made the
 * endpoint answer `cost: 0` and `percentages.cost: 0` for every org, no matter
 * how much of the cost cap it had actually burned — an org sitting at 80% of
 * its cap looked idle right up to the moment core/limits.js hard-blocks it.
 *
 * We drive the REAL Express router with a stubbed req/res (no HTTP listener,
 * no DB), the same way routes/stripe.subscriptionDeleted.test.js does.
 *
 * Run: cd server && node --test routes/subscriptions.orgUsage.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

// ── Stub the module-level deps of routes/subscriptions.js ───────────────────
function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// What getUsageSummary hands back, per test.
let usageFixture = null;
let limitsFixture = null;

stub('../stores/userStore', {
    getOrgSubscription: async () => ({ organization_id: 'org_1', plan_id: 'plan_1', billing_model: 'fixed' }),
    getEffectiveLimits: async () => limitsFixture,
    getBillingPeriod: () => ({ startDate: '2026-08-01T00:00:00.000Z', endDate: '2026-09-01T00:00:00.000Z' }),
    getPlan: async () => ({ id: 'plan_1', markup_percent: 0 }),
});
stub('../stores/usageStore', {
    getUsageSummary: async () => usageFixture,
});
stub('../auth/permissions', {
    isSuperAdmin: async () => true,
    isOrgAdminForOrg: async () => true,
    resolveUserOrgIds: async () => null,   // null = platform admin, no org filter
});

const router = require('./subscriptions');

function dispatch(url) {
    return new Promise((resolve, reject) => {
        const req = {
            method: 'GET', url, originalUrl: url, baseUrl: '', path: url,
            headers: {}, body: {}, params: {}, query: {},
            session: { isAuthenticated: true, isAdmin: true, user: { id: 'u1', role: 'admin' } },
            get() { return undefined; },
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
        router(req, res, (err) => reject(err || new Error(`fell through router: GET ${url}`)));
    });
}

test.beforeEach(() => {
    limitsFixture = { max_messages_per_month: 1000, max_tokens_per_month: 1_000_000, max_cost_per_month: 100 };
    // Shape mirrors getUsageSummary exactly: BIGINT sums come back as strings
    // from pg, and the cost column is aliased total_estimated_cost.
    usageFixture = {
        total_calls: '250',
        total_tokens: '400000',
        total_estimated_cost: 80,
        total_billed_cost: 80,
        billed_calls: '250',
    };
});

test('reports the org’s real spend, not 0', async () => {
    const res = await dispatch('/orgs/org_1/usage');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.usage.cost, 80, 'cost comes from total_estimated_cost');
    assert.strictEqual(res.body.percentages.cost, 80, '80 of a 100 cap is 80%');
});

test('a numeric-string cost from pg is coerced, not concatenated', async () => {
    usageFixture.total_estimated_cost = '12.5';
    const res = await dispatch('/orgs/org_1/usage');
    assert.strictEqual(res.body.usage.cost, 12.5, 'string sum becomes a number');
    assert.strictEqual(res.body.percentages.cost, 13, 'Math.round(12.5%) = 13');
});

test('zero usage still reports 0 (and does not crash)', async () => {
    usageFixture.total_estimated_cost = 0;
    const res = await dispatch('/orgs/org_1/usage');
    assert.strictEqual(res.body.usage.cost, 0);
    assert.strictEqual(res.body.percentages.cost, 0);
});

test('no cost cap → percentages.cost is null, cost still reported', async () => {
    limitsFixture = { max_messages_per_month: null, max_tokens_per_month: null, max_cost_per_month: null };
    const res = await dispatch('/orgs/org_1/usage');
    assert.strictEqual(res.body.usage.cost, 80, 'unlimited plans still show real spend');
    assert.strictEqual(res.body.percentages.cost, null);
});
