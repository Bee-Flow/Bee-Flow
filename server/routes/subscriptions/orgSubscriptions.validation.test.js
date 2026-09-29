/**
 * What the org-subscription write accepts, and what it says when it refuses
 * (routes/subscriptions/orgSubscriptions.js).
 *
 * stores/user/subscriptions.js builds its UPDATE column by column off
 * `data.<col> !== undefined`, so a key it does not know never reached the
 * database. The route then re-read the row and answered 200 with it, so
 * `max_cost_per_moth: 500` was "Subscription saved." over a cap that had not
 * moved — and the audit row recorded the payload that was never applied.
 *
 * The trial route is the other half: this API spells the plan `plan_id` here
 * and `planId` on the lifecycle routes, so the refusal has to NAME the key it
 * did not expect rather than report the one it wanted as missing.
 *
 * Run: cd server && node --test --test-force-exit routes/subscriptions/orgSubscriptions.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every write lands in `touched`. A refused request must leave it empty.
const touched = [];

const MOCKS = {
    '../../stores/userStore': {
        getAllOrgSubscriptions: async () => [],
        getAllOrganizations: async () => [],
        getOrgSubscription: async (orgId) => ({ organization_id: orgId, plan_id: 'p1', status: 'active' }),
        getEffectiveLimits: async () => ({}),
        getBillingPeriod: () => ({ startDate: '2026-01-01T00:00:00.000Z' }),
        getPlan: async (id) => ({ id, price: 0 }),
        getActiveSeatCount: async () => 1,
        getOrganization: async () => ({}),
        setOrgSubscriptionWithLock: async (orgId, payload) => {
            touched.push({ what: 'setOrgSubscriptionWithLock', args: [orgId, payload] });
            return { ok: true, snapshot: null, displaced: false };
        },
        logSubscriptionAudit: async () => {},
    },
    '../../stores/usageStore': { getUsageSummary: async () => ({}) },
    '../../auth/ncAudience': { isNcOrg: async () => false, filterNcOnlyPlans: (p) => p },
    './shared': { getAdminId: () => 'admin' },
    '../../services/trialService': {
        startOrgTrial: async (orgId, planId) => { touched.push({ what: 'startOrgTrial', args: [orgId, planId] }); return { ok: true }; },
    },
    '../../services/planEntitlements': { applyPlanToOrg: async () => {} },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:subscriptions-orgsubscriptions-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /subscriptions[\\/]orgSubscriptions\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./orgSubscriptions');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ method, url, query = {}, body = {} }) {
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

test('a misspelled cap is refused rather than saved as a no-op', async () => {
    const res = await dispatch({ method: 'PUT', url: '/orgs/orgA', body: { max_cost_per_moth: 500 } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(/max_cost_per_moth/.test(res.body.error), `the 400 names the key: ${res.body.error}`);
    assert.deepStrictEqual(touched, [], 'nothing was written, and nothing was audited');
});

test('a misspelled status is refused with the same sentence as before', async () => {
    const res = await dispatch({ method: 'PUT', url: '/orgs/orgA', body: { status: 'activ' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Invalid status. Must be: active, suspended, cancelled, trialing, past_due');
    assert.deepStrictEqual(touched, []);
});

test('a negative cap is still refused by name', async () => {
    const res = await dispatch({ method: 'PUT', url: '/orgs/orgA', body: { max_users: -3 } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'max_users must be non-negative.');
    assert.deepStrictEqual(touched, []);
});

test('an override window outside 0-168 hours is still refused', async () => {
    const res = await dispatch({ method: 'PUT', url: '/orgs/orgA', body: { override_hours: 200 } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'override_hours must be between 0 and 168');
    assert.deepStrictEqual(touched, []);
});

test('the shape the org editor actually posts is still accepted', async () => {
    const res = await dispatch({
        method: 'PUT', url: '/orgs/orgA',
        body: {
            plan_id: 'p1', status: 'active', max_cost_per_month: null, max_users: 25,
            max_agents: null, max_knowledge_sources: null, allowed_features: null, notes: 'paid up front',
        },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'setOrgSubscriptionWithLock').args[1].notes, 'paid up front');
});

test('an override window is still translated into the two override columns', async () => {
    const res = await dispatch({ method: 'PUT', url: '/orgs/orgA', body: { override_hours: 24 } });
    assert.strictEqual(res.statusCode, 200);
    const payload = touched.find((t) => t.what === 'setOrgSubscriptionWithLock').args[1];
    assert.ok(!('override_hours' in payload), 'override_hours is not a column');
    assert.strictEqual(payload.manual_override_by, 'admin');
    assert.ok(Date.parse(payload.manual_override_until) > Date.now());
});

test('the trial route names the key it did not expect, as well as the one it wanted', async () => {
    const res = await dispatch({ method: 'POST', url: '/orgs/orgA/start-trial', body: { planId: 'p1' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'plan_id is required — the plan to start the trial on.');
    assert.ok(
        res.body.details.some((d) => /planId/.test(d.message)),
        `the details name the key that was sent: ${JSON.stringify(res.body.details)}`,
    );
    assert.deepStrictEqual(touched, [], 'no trial was started');
});

test('the trial route still starts a trial on plan_id', async () => {
    const res = await dispatch({ method: 'POST', url: '/orgs/orgA/start-trial', body: { plan_id: 'p1' } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.what === 'startOrgTrial').args, ['orgA', 'p1']);
});
