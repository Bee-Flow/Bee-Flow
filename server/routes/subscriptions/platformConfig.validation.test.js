/**
 * What the install-wide subscription admin accepts, and what it says when it
 * refuses (routes/subscriptions/platformConfig.js).
 *
 * `PUT /trial-config` writes two OPTIONAL slots, and every layer below it keys
 * off "did you give me this field": the plan checks look at the two names they
 * know, and trialService.setTrialConfig writes only a key it was handed. A
 * misspelled `default_org_trial_plan` therefore sailed through all of it, wrote
 * nothing, and came back 200 with the config unchanged — "Trial offers saved."
 * on screen over a slot still pointing at the old plan.
 *
 * `PUT /currency-rates` is the opposite shape: its keys ARE the data, so it
 * stays open and the schema pins the SHAPE of a key instead.
 *
 * Run: cd server && node --test --test-force-exit routes/subscriptions/platformConfig.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every write lands in `touched`. A refused request must leave it empty.
const touched = [];

const PLANS = {
    'plan-org': { id: 'plan-org', plan_type: 'organization', trial_days: 14, stripe_price_id: 'price_1' },
};

const MOCKS = {
    '../../stores/userStore': {
        getPlan: async (id) => PLANS[id] || null,
        logSubscriptionAudit: async (...args) => { touched.push({ what: 'audit', args }); },
        getUnresolvedLicenseIssuanceFailures: async (limit) => { touched.push({ what: 'failures', args: [limit] }); return []; },
    },
    './shared': { getAdminId: () => 'admin' },
    '../../services/trialService': {
        getTrialConfig: async () => ({ default_org_trial_plan_id: null, default_consumer_trial_plan_id: null }),
        setTrialConfig: async (cfg) => { touched.push({ what: 'setTrialConfig', args: [cfg] }); return cfg; },
    },
    '../../core/text/currency': {
        getAllConfiguredRates: async () => ({}),
        setUsdToCurrencyRate: async (code, rate) => { touched.push({ what: 'setRate', args: [code, rate] }); return { currency: code, rate }; },
    },
    '../../stores/usageStore': { invalidatePaygCache: () => {} },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:subscriptions-platformconfig-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /subscriptions[\\/]platformConfig\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./platformConfig');
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

test('a misspelled trial slot is refused, instead of being saved as a no-op', async () => {
    const res = await dispatch({
        method: 'PUT', url: '/trial-config',
        body: { default_org_trial_plan: 'plan-org' },
    });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(/default_org_trial_plan/.test(res.body.error), `the 400 names the key: ${res.body.error}`);
    assert.deepStrictEqual(touched, [], 'nothing was written');
});

test('a trial slot that is not text is refused by name', async () => {
    const res = await dispatch({
        method: 'PUT', url: '/trial-config',
        body: { default_org_trial_plan_id: 42 },
    });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.default_org_trial_plan_id'));
    assert.deepStrictEqual(touched, []);
});

test('the two real slots still save, and clearing one still clears it', async () => {
    const res = await dispatch({
        method: 'PUT', url: '/trial-config',
        body: { default_org_trial_plan_id: 'plan-org', default_consumer_trial_plan_id: '' },
    });
    assert.strictEqual(res.statusCode, 200);
    const saved = touched.find((t) => t.what === 'setTrialConfig');
    assert.deepStrictEqual(saved.args[0], { default_org_trial_plan_id: 'plan-org', default_consumer_trial_plan_id: '' });
});

test('a currency code that is not three letters is refused, naming the code', async () => {
    const res = await dispatch({ method: 'PUT', url: '/currency-rates', body: { euro: 0.92 } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'A currency code is three letters, like EUR.');
    assert.ok(res.body.details.some((d) => d.path === 'body.euro'));
    assert.deepStrictEqual(touched, []);
});

test('a rate of zero or less is refused rather than stored as a divisor', async () => {
    const res = await dispatch({ method: 'PUT', url: '/currency-rates', body: { eur: 0 } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'A rate is greater than zero.');
    assert.deepStrictEqual(touched, []);
});

test('a rates map is still open: every three-letter key is carried through', async () => {
    const res = await dispatch({ method: 'PUT', url: '/currency-rates', body: { eur: 0.92, gbp: '0.78' } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(
        touched.filter((t) => t.what === 'setRate').map((t) => t.args),
        [['eur', 0.92], ['gbp', 0.78]],
        'the string rate is coerced once, by the schema',
    );
});

test('an unknown query key on the failures list is refused', async () => {
    const res = await dispatch({ method: 'GET', url: '/license-issuance-failures', query: { limitt: '10' } });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(touched, []);
});

test('the failures list still clamps a limit rather than refusing it', async () => {
    const res = await dispatch({ method: 'GET', url: '/license-issuance-failures', query: { limit: '9000' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'failures').args[0], 200);
});
