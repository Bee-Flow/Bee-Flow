/**
 * What the plan CRUD accepts, and what it says when it refuses
 * (routes/subscriptions/plans.js).
 *
 * stores/user/plans.js writes through an explicit column map, so a key it does
 * not know is dropped without a word. The route then answered 201/200 with the
 * plan read back from the database, so `markup_precent: 40` created a plan at
 * the default markup under "Plan created." — the number the operator typed was
 * nowhere, and nothing on screen said so.
 *
 * `plan_type` had no check at all, and it is the one field that decides which
 * list a plan appears in: `plan_type: 'consumr'` was stored verbatim, and a
 * plan with a plan_type nobody matches on is invisible in the org list, the
 * consumer list and the trial picker alike.
 *
 * Run: cd server && node --test --test-force-exit routes/subscriptions/plans.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store write lands in `touched`. A refused request must leave it empty.
const touched = [];

const MOCKS = {
    '../../stores/userStore': {
        getAllPlans: async () => [],
        getPlan: async (id) => ({ id, name: 'Old', price: 0, billing_model: 'fixed' }),
        createPlan: async (p) => { touched.push({ what: 'createPlan', args: [p] }); return { id: 'p1', ...p }; },
        updatePlan: async (id, p) => { touched.push({ what: 'updatePlan', args: [id, p] }); return true; },
        deletePlan: async (id) => { touched.push({ what: 'deletePlan', args: [id] }); return true; },
        logSubscriptionAudit: async () => {},
        PlanInUseError: class PlanInUseError extends Error {},
    },
    './shared': { getAdminId: () => 'admin' },
    '../../services/stripeService': { isEnabled: async () => false },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:subscriptions-plans-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /subscriptions[\\/]plans\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./plans');
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

const PLAN = { name: 'Team', plan_type: 'organization', price: 15, currency: 'EUR', billing_interval: 'monthly' };

test.beforeEach(() => { touched.length = 0; });

test('a plan with no name is refused in words, not with "Required"', async () => {
    const res = await dispatch({ method: 'POST', url: '/plans', body: {} });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'A plan needs a name.');
    assert.ok(res.body.details.some((d) => d.path === 'body.name'));
    assert.deepStrictEqual(touched, []);
});

test('a misspelled column is refused rather than dropped under a 201', async () => {
    const res = await dispatch({ method: 'POST', url: '/plans', body: { ...PLAN, markup_precent: 40 } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(/markup_precent/.test(res.body.error), `the 400 names the key: ${res.body.error}`);
    assert.deepStrictEqual(touched, [], 'no plan was created');
});

test('a misspelled plan_type is refused, instead of creating a plan no list shows', async () => {
    const res = await dispatch({ method: 'POST', url: '/plans', body: { ...PLAN, plan_type: 'consumr' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'plan_type is "organization" or "consumer".',
        'an enum needs an errorMap: invalid_type_error would not have caught a wrong VALUE');
    assert.deepStrictEqual(touched, []);
});

test('a price that is not a number is refused, instead of being stored as text', async () => {
    const res = await dispatch({ method: 'POST', url: '/plans', body: { ...PLAN, price: 'free' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'price must be a number.');
    assert.deepStrictEqual(touched, []);
});

test('a negative cap is still refused by name', async () => {
    const res = await dispatch({ method: 'POST', url: '/plans', body: { ...PLAN, max_users: -1 } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'max_users must be non-negative.');
    assert.deepStrictEqual(touched, []);
});

test('a PAYG plan with a trial is still refused, now pathed to trial_days', async () => {
    const res = await dispatch({ method: 'POST', url: '/plans', body: { ...PLAN, billing_model: 'metered', trial_days: 14 } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.trial_days'));
    assert.deepStrictEqual(touched, []);
});

test('a misspelled billing_interval is refused with a sentence, not a zod enum dump', async () => {
    const res = await dispatch({ method: 'POST', url: '/plans', body: { ...PLAN, billing_interval: 'montly' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'billing_interval is "monthly" or "yearly".');
    assert.deepStrictEqual(touched, []);
});

test('the shape the Plan editor actually posts is still accepted', async () => {
    const res = await dispatch({
        method: 'POST', url: '/plans',
        body: {
            name: '  Team  ', description: '', tagline: '', plan_type: 'organization',
            max_cost_per_month: null, max_users: 25, max_agents: null, max_knowledge_sources: null,
            allowed_features: ['chat'], allowed_models: ['fast'], allowed_integrations: null,
            allowed_beta_features: ['automations'], billing_model: 'fixed', markup_percent: 20,
            is_default: false, price: 15, currency: 'EUR', billing_interval: 'monthly',
            trial_days: 0, sort_order: 10, is_public: true, nc_recommended: false, nc_only: false,
            per_seat: true,
        },
    });
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(touched.find((t) => t.what === 'createPlan').args[0].name, 'Team', 'trimmed once, by the schema');
});

test('an update refuses the same misspelling, and leaves the plan untouched', async () => {
    const res = await dispatch({ method: 'PUT', url: '/plans/p1', body: { trial_day: 30 } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(/trial_day/.test(res.body.error));
    assert.deepStrictEqual(touched, []);
});

test('an update may still send a single field', async () => {
    const res = await dispatch({ method: 'PUT', url: '/plans/p1', body: { tagline: 'Now cheaper' } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.what === 'updatePlan').args, ['p1', { tagline: 'Now cheaper' }]);
});

test('an empty name on update is refused, as it was before', async () => {
    const res = await dispatch({ method: 'PUT', url: '/plans/p1', body: { name: '   ' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'A plan name cannot be empty.');
    assert.deepStrictEqual(touched, []);
});
