/**
 * What the web-search inference routing accepts
 * (routes/ai/config/webSearchInference.js).
 *
 * The resolver's sanitiser turned any body into SOME config: `method:
 * 'disable'` kept reranking on (cosine), a misspelled section reset that
 * section, and a body with only `cleanup` wiped the other two — each
 * answered "Saved". The REAL resolver runs underneath here (its configStore
 * is in memory), so what is pinned is the whole save, including that every
 * method the schema lets through survives the sanitiser unchanged.
 *
 * Run: cd server && node --test routes/ai/config/webSearchInference.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const writes = [];
const fx = { isAdmin: true };

const MOCKS = {
    '../../../auth/permissions': { requireAuth: (req, res, next) => next() },
    './shared': { isAdminUser: async () => fx.isAdmin },
    // The resolver is REAL; only its persistence is in memory.
    '../stores/configStore': {
        getConfig: async () => null,
        setConfig: async (key, value) => { writes.push([key, value]); },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:web-search-inference-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /(config[\\/]webSearchInference|core[\\/]webSearchInferenceResolver)\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./webSearchInference');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../../core/http/terminalErrorHandler');

function dispatch(body) {
    const url = '/config/web-search-inference';
    return new Promise((resolve, reject) => {
        const req = {
            method: 'POST', url, originalUrl: url, path: url, body, query: {}, headers: {},
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
            if (!err) return reject(new Error('fell through'));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => { writes.length = 0; fx.isAdmin = true; });

const NONE = { providerId: '', modelId: '' };
// What WebSearchInferenceConfig.jsx sends: all three sections, every time.
const page = (rerank, over = {}) => ({ embed: NONE, rerank: { providerId: '', modelId: '', ...rerank }, cleanup: NONE, ...over });

test('a misspelled rerank method is refused — "disable" used to keep reranking ON', async () => {
    const res = await dispatch(page({ method: 'disable' }));
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /^rerank\.method is one of cosine, cpu, provider, local, disabled\.$/);
    assert.deepStrictEqual(writes, []);
});

test('a body with one section is refused — the other two used to be reset to defaults', async () => {
    const res = await dispatch({ cleanup: { providerId: 'p1', modelId: 'mistral-small' } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.embed'));
    assert.ok(res.body.details.some((d) => d.path === 'body.rerank'));
    assert.deepStrictEqual(writes, []);
});

test('a misspelled section is refused rather than read as "reset rerank"', async () => {
    const res = await dispatch({ embed: NONE, rerank: { method: 'cpu' }, cleanup: NONE, reranker: { method: 'disabled' } });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(writes, []);
});

test('half a provider/model pair is refused instead of saved as "unset"', async () => {
    const res = await dispatch(page({ method: 'cosine' }, { cleanup: { providerId: 'p1', modelId: '' } }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'cleanup needs both a provider and a model, or neither.');
    assert.deepStrictEqual(writes, []);
});

test('"Provider model" with no model yet is still accepted — the page says it falls back to cosine', async () => {
    const res = await dispatch(page({ method: 'provider' }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.config.rerank.method, 'cosine');
});

test('every method the schema accepts survives the real sanitiser unchanged', async () => {
    for (const method of ['cosine', 'cpu', 'local', 'disabled']) {
        const res = await dispatch(page({ method }));
        assert.strictEqual(res.statusCode, 200, `${method}: ${JSON.stringify(res.body)}`);
        assert.strictEqual(res.body.config.rerank.method, method, `${method} must not be rewritten`);
    }
    const res = await dispatch(page({ method: 'provider', providerId: 'p1', modelId: 'gpt-x' }));
    assert.deepStrictEqual(res.body.config.rerank, { method: 'provider', providerId: 'p1', modelId: 'gpt-x' });
});

test('the page\'s full save lands as sent', async () => {
    const body = { embed: { providerId: 'p2', modelId: 'text-embedding-3-small' }, rerank: { method: 'cpu', providerId: '', modelId: '' }, cleanup: { providerId: 'p1', modelId: 'mistral-small' } };
    const res = await dispatch(body);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(writes, [['web_search_inference_config', body]]);
});

test('a non-admin gets the 403 before the schema says anything', async () => {
    fx.isAdmin = false;
    const res = await dispatch({ nonsense: true });
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(res.body, { error: 'Admin access required' });
});
