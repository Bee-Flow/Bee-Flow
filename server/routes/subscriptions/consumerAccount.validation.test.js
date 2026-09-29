/**
 * What the consumer start-trial route accepts, and what it says when it
 * refuses (routes/subscriptions/consumerAccount.js).
 *
 * The key here is `plan_id`; the lifecycle routes in the same API take
 * `planId`. A truthiness check answered the wrong spelling with "plan_id is
 * required", which reads like a missing field rather than a renamed one — so
 * the refusal names the key that was actually sent.
 *
 * Run: cd server && node --test --test-force-exit routes/subscriptions/consumerAccount.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every trial start lands in `touched`. A refused request must leave it empty.
const touched = [];

const MOCKS = {
    '../../stores/userStore': {
        getConsumerSubscription: async () => null,
        getAllPlans: async () => [],
        getPlan: async (id) => ({ id }),
    },
    '../../stores/usageStore': {
        getUsageSummary: async () => ({}),
        getUsageByAgentType: async () => [],
    },
    './shared': { getAdminId: () => 'admin' },
    '../../services/trialService': {
        startConsumerTrial: async (userId, planId) => { touched.push({ what: 'startConsumerTrial', args: [userId, planId] }); return { ok: true }; },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:subscriptions-consumeraccount-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /subscriptions[\\/]consumerAccount\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./consumerAccount');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ method, url, query = {}, body }) {
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

test('the other spelling of the plan key is named, as well as the one that was wanted', async () => {
    const res = await dispatch({ method: 'POST', url: '/consumer/u1/start-trial', body: { planId: 'p1' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'plan_id is required — the plan to start the trial on.');
    assert.ok(
        res.body.details.some((d) => /planId/.test(d.message)),
        `the details name the key that was sent: ${JSON.stringify(res.body.details)}`,
    );
    assert.deepStrictEqual(touched, [], 'no trial was started');
});

test('an empty plan_id is refused in words', async () => {
    const res = await dispatch({ method: 'POST', url: '/consumer/u1/start-trial', body: { plan_id: '' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'plan_id is required — the plan to start the trial on.');
    assert.deepStrictEqual(touched, []);
});

test('a real plan_id still starts the trial', async () => {
    const res = await dispatch({ method: 'POST', url: '/consumer/u1/start-trial', body: { plan_id: 'p1' } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.what === 'startConsumerTrial').args, ['u1', 'p1']);
});
