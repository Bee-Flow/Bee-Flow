/**
 * Who may reprice a model, and what a price is (routes/ai/config/modelCosts.js).
 *
 * The overrides are meant to be what every usage row is billed at, and the
 * write carried requireAuth only. Its loop skipped whatever did not fit, read
 * `reset` for truthiness — `reset: "false"` RESET the model it came to price —
 * and stored Number(input), so "2,5" became NaN. The config view beside it
 * called `.map` on a promise and had answered 500 on every call.
 *
 * The store underneath (core/llm/modelCosts) is mocked here on purpose: this
 * file pins what the ROUTE accepts and answers, not what that store then does
 * with it (core/llm/modelCosts.overrides.test.js is the store's own). The two
 * writers return a promise, as the real ones do, so the route has to await
 * them — and a save that fails must not be answered with a 200.
 *
 * Run: cd server && node --test routes/ai/config/modelCosts.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const touched = [];
const fx = { isAdmin: true, failWrite: null };

/** The real writers resolve once the row is stored; `fx.failWrite` names a model whose write fails. */
function write(entry) {
    touched.push(entry);
    return entry[1] === fx.failWrite
        ? Promise.reject(new Error('config row locked'))
        : Promise.resolve();
}

const MOCKS = {
    '../../../auth/permissions': { requireAuth: (req, res, next) => next() },
    './shared': { isAdminUser: async () => fx.isAdmin },
    '../../../core/llm/modelCosts': {
        getAllModelCosts: () => ({}),
        getModelCostsForConfig: (entries) => entries.map((e) => ({ model: e.id, provider: e.providerName })),
        setModelCost: (model, input, output) => write(['set', model, input, output]),
        resetModelCost: (model) => write(['reset', model]),
    },
    // Both are async in real life — which is the bug the config view had.
    '../../../core/aiAgent': { getAllCachedModelIds: async () => [{ id: 'gpt-x', providerName: 'OpenAI', providerType: 'openai' }] },
    '../../../stores/usageStore': { getUsageModels: async () => ['mistral-small'] },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:model-costs-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /config[\\/]modelCosts\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./modelCosts');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../../core/http/terminalErrorHandler');

function dispatch({ method, url, body = {} }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, query: {}, headers: {},
            session: { isAuthenticated: true, user: { id: 'u1' } }, get() { return undefined; },
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

test.beforeEach(() => { touched.length = 0; fx.isAdmin = true; fx.failWrite = null; });

test('a signed-in non-admin cannot reprice a model', async () => {
    fx.isAdmin = false;
    const res = await dispatch({ method: 'POST', url: '/model-costs', body: { costs: [{ model: 'gpt-x', input: 0, output: 0 }] } });
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(touched, []);
});

test('reset: "false" is refused — it used to RESET the model it came to price', async () => {
    const res = await dispatch({ method: 'POST', url: '/model-costs', body: { costs: [{ model: 'gpt-x', input: 2.5, output: 10, reset: 'false' }] } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.costs.0.reset'));
    assert.deepStrictEqual(touched, []);
});

test('a price in text is refused rather than stored as NaN', async () => {
    const res = await dispatch({ method: 'POST', url: '/model-costs', body: { costs: [{ model: 'gpt-x', input: '2,5', output: 10 }] } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.costs.0.input'));
    assert.deepStrictEqual(touched, []);
});

test('an entry missing its output price is refused, not skipped under a 200', async () => {
    const res = await dispatch({ method: 'POST', url: '/model-costs', body: { costs: [{ model: 'gpt-x', input: 2.5 }] } });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /needs both an input and an output price/);
    assert.deepStrictEqual(touched, []);
});

test('a misspelled field is refused, so one bad row cannot half-apply a batch', async () => {
    const res = await dispatch({
        method: 'POST', url: '/model-costs',
        body: { costs: [{ model: 'a', input: 1, output: 2 }, { model: 'b', inputPrice: 1, output: 2 }] },
    });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(touched, [], 'row a is not written either');
});

test('a negative price is refused', async () => {
    const res = await dispatch({ method: 'POST', url: '/model-costs', body: { costs: [{ model: 'gpt-x', input: -1, output: 2 }] } });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(touched, []);
});

test('costs that is not a list keeps the route\'s sentence', async () => {
    const res = await dispatch({ method: 'POST', url: '/model-costs', body: {} });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'costs must be an array of { model, input, output }');
});

test('prices and resets both land', async () => {
    const res = await dispatch({
        method: 'POST', url: '/model-costs',
        body: { costs: [{ model: 'gpt-x', input: 2.5, output: 10 }, { model: 'mistral-small', reset: true }] },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { success: true, updated: 1, reset: 1 });
    assert.deepStrictEqual(touched, [['set', 'gpt-x', 2.5, 10], ['reset', 'mistral-small']]);
});

test('a save that fails is not answered "success" — and the entries after it are not written', async () => {
    fx.failWrite = 'gpt-x';
    const res = await dispatch({
        method: 'POST', url: '/model-costs',
        body: { costs: [{ model: 'mistral-small', reset: true }, { model: 'gpt-x', input: 2.5, output: 10 }, { model: 'claude-x', input: 3, output: 15 }] },
    });
    assert.strictEqual(res.statusCode, 500);
    assert.notStrictEqual(res.body.success, true);
    assert.deepStrictEqual(touched, [['reset', 'mistral-small'], ['set', 'gpt-x', 2.5, 10]]);
});

test('the config view answers — it used to be a TypeError on every call', async () => {
    const res = await dispatch({ method: 'GET', url: '/model-costs-config' });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body.costs, [
        { model: 'gpt-x', provider: 'OpenAI' },
        { model: 'mistral-small', provider: null },
    ]);
});
