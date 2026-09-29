/**
 * What the public plan catalogue accepts, and what it says when it refuses
 * (routes/stripe/plans.js).
 *
 * `?type=` is compared to `plan.plan_type` with `===`, so a value the
 * catalogue does not know matched nothing and the route answered 200 with
 * `[]` — the pricing page rendered "no plans available" over an installation
 * whose consumer plans were all public. A misspelled KEY was worse: it fell
 * back to 'organization' and showed the wrong catalogue entirely.
 *
 * Run: cd server && node --test routes/stripe/plans.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store read lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();

const PLANS = [
    { id: 'org1', name: 'Team', price: 10, is_public: true, plan_type: 'organization', sort_order: 1 },
    { id: 'con1', name: 'Personal', price: 5, is_public: true, plan_type: 'consumer', sort_order: 1 },
];

const MOCKS = {
    '../../services/stripeService': { isEnabled: async () => true, isTestMode: async () => false },
    '../../stores/userStore': {
        getAllPlans: async () => { touched.push({ what: 'getAllPlans', args: [] }); return PLANS; },
    },
    '../../auth/ncAudience': { isNcOrg: async () => false, filterNcOnlyPlans: (p) => p },
    './shared': {
        requireCloud: pass,
        requireAuth: pass,
        resolveOrgIdForUser: async () => 'orgA',
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:stripe-plans-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /stripe[\\/]plans\.js$/.test(parent.filename)
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
            session: { user: { id: 'u1' }, isAuthenticated: true }, get() { return undefined; },
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

test('a misspelled type is refused in words, not answered with an empty catalogue', async () => {
    const res = await dispatch({ method: 'GET', url: '/plans', query: { type: 'consumr' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'type is organization or consumer.');
    assert.ok(res.body.details.some((d) => d.path === 'query.type'));
    assert.deepStrictEqual(touched, [], 'the catalogue was never read');
});

test('a misspelled key is refused rather than silently showing the org catalogue', async () => {
    const res = await dispatch({ method: 'GET', url: '/plans', query: { typ: 'consumer' } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(/typ/.test(res.body.error), `the 400 names the key: ${res.body.error}`);
    assert.deepStrictEqual(touched, []);
});

test('the consumer catalogue the licence page asks for still arrives', async () => {
    const res = await dispatch({ method: 'GET', url: '/plans', query: { type: 'consumer' } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.map((p) => p.id), ['con1']);
});

test('no type at all still means the organisation catalogue', async () => {
    const res = await dispatch({ method: 'GET', url: '/plans', query: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.map((p) => p.id), ['org1']);
});

test('the status route takes no input and is unaffected', async () => {
    const res = await dispatch({ method: 'GET', url: '/status', query: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { enabled: true, testMode: false });
});
