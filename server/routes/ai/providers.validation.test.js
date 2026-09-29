/**
 * What the provider routes accept (routes/ai/providers.js).
 *
 * A provider's TYPE is what the rest of the server trusts: it picks the
 * adapter and it is the one thing modelCache reads to mark a provider's models
 * as self-hosted, priced at €0. POST without a type stored 'openai-compatible'
 * — a self-hosted flavour — so a paid endpoint added without one was billed
 * at €0. A misspelled type was stored as-is. A misspelled field on PUT
 * answered success and kept the old key. And the GET's masked key, sent back,
 * replaced the real one.
 *
 * What this file pins: the 400 names the field, only an admin gets that far,
 * and a refused request reaches neither addProvider nor updateProvider.
 * (Who may mutate at all is providers.authz.test.js.)
 *
 * Run: cd server && node --test routes/ai/providers.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store call lands in `touched`. A refused request must leave it empty.
const touched = [];
const fx = { isAdmin: true, modelCalls: [] };

const MOCKS = {
    '../../core/aiAgent': {
        getProviders: async () => ({ providers: [{ id: 'p1', name: 'OpenAI', type: 'openai', url: 'https://api.openai.com/v1', apiKey: 'sk-real-1234' }], defaultProvider: 'p1' }),
        addProvider: async (p) => { touched.push({ what: 'addProvider', args: [p] }); return { id: 'p-new', ...p }; },
        updateProvider: async (id, u) => { touched.push({ what: 'updateProvider', args: [id, u] }); return true; },
        // The real one answers true whatever the id — which is the bug the route works around.
        deleteProvider: async (id) => { touched.push({ what: 'deleteProvider', args: [id] }); return true; },
        setDefaultProvider: async () => true,
        getModelsForProvider: async (id, force) => { fx.modelCalls.push([id, force]); return []; },
        invalidateModelCache: () => {},
    },
    '../../auth/permissions': { requireAuth: (req, res, next) => next() },
    './config/shared': { isAdminUser: async () => fx.isAdmin },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:providers-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]ai[\\/]providers\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./providers');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ method, url, body = {}, query = {} }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, query, headers: {},
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

test.beforeEach(() => { touched.length = 0; fx.isAdmin = true; fx.modelCalls.length = 0; });

// ═══ POST /providers ═════════════════════════════════════════════════

test('a provider without a type is refused — it used to be stored as self-hosted, priced at €0', async () => {
    const res = await dispatch({ method: 'POST', url: '/providers', body: { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-1' } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.type'));
    assert.match(res.body.error, /^Pick a provider type/);
    assert.deepStrictEqual(touched, []);
});

test('a misspelled type is refused instead of stored for a URL guess', async () => {
    const res = await dispatch({ method: 'POST', url: '/providers', body: { name: 'Box', type: 'olama', url: 'http://localhost:11434' } });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /^Unknown provider type 'olama'/);
    assert.deepStrictEqual(touched, []);
});

test('the Local Models card\'s own request is accepted', async () => {
    const res = await dispatch({ method: 'POST', url: '/providers', body: { type: 'ollama', name: 'Ollama', url: 'http://localhost:11434', apiKey: '' } });
    assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
    assert.strictEqual(touched[0].args[0].type, 'ollama');
});

test('a type the adapter factory knows is accepted without a second list here', async () => {
    for (const type of ['claude', 'google-vertex', 'scaleway', 'local', 'openai-compatible']) {
        touched.length = 0;
        const res = await dispatch({ method: 'POST', url: '/providers', body: { name: type, type, url: 'https://x.example/v1' } });
        assert.strictEqual(res.statusCode, 201, `${type}: ${JSON.stringify(res.body)}`);
    }
});

test('a Vertex service-account key reaches the store instead of being dropped — and is not echoed back', async () => {
    const res = await dispatch({
        method: 'POST', url: '/providers',
        body: { name: 'Vertex', type: 'google-vertex', project: 'p', location: 'europe-west4', serviceAccountKey: '{"type":"service_account"}' },
    });
    assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
    assert.strictEqual(touched[0].args[0].serviceAccountKey, '{"type":"service_account"}');
    assert.strictEqual(res.body.serviceAccountKey, '••••(configured)');
});

test('a misspelled field on create is refused, not dropped', async () => {
    const res = await dispatch({ method: 'POST', url: '/providers', body: { name: 'x', type: 'openai', url: 'https://api.openai.com/v1', apikey: 'sk-1' } });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(touched, []);
});

test('a missing URL still gets the route\'s own sentence', async () => {
    const res = await dispatch({ method: 'POST', url: '/providers', body: { name: 'x', type: 'openai' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Name and URL are required');
    assert.deepStrictEqual(touched, []);
});

test('a non-admin gets the 403 before the schema says anything', async () => {
    fx.isAdmin = false;
    const res = await dispatch({ method: 'POST', url: '/providers', body: { nonsense: true } });
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(res.body, { error: 'Admin access required' });
});

// ═══ PUT /providers/:id ══════════════════════════════════════════════

test('a misspelled key on update is refused — it used to answer success and keep the old key', async () => {
    const res = await dispatch({ method: 'PUT', url: '/providers/p1', body: { apikey: 'sk-rotated-9999' } });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(touched, [], 'no "success" for a rotation that did not happen');
});

test('the masked key GET hands out is refused instead of replacing the real one', async () => {
    const res = await dispatch({ method: 'PUT', url: '/providers/p1', body: { name: 'OpenAI', apiKey: '••••1234' } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.apiKey'));
    assert.deepStrictEqual(touched, []);
});

test('an update still merges: what is left out keeps its value', async () => {
    const res = await dispatch({ method: 'PUT', url: '/providers/p1', body: { name: 'Renamed' } });
    assert.strictEqual(res.statusCode, 200);
    const [id, updates] = touched[0].args;
    assert.strictEqual(id, 'p1');
    assert.strictEqual(updates.name, 'Renamed');
    assert.strictEqual(updates.apiKey, undefined);
    assert.strictEqual(updates.serviceAccountKey, undefined, 'an empty or absent SA key keeps the stored one');
});

// ═══ Region and models ═══════════════════════════════════════════════

test('deleting an id no provider has is a 404, not a "success" that left the real one in place', async () => {
    const res = await dispatch({ method: 'DELETE', url: '/providers/provider-123' });
    assert.strictEqual(res.statusCode, 404);
    assert.deepStrictEqual(res.body, { error: 'Provider not found' });
    assert.deepStrictEqual(touched, [], 'nothing was rewritten');
});

test('deleting a provider that exists still deletes it', async () => {
    const res = await dispatch({ method: 'DELETE', url: '/providers/p1' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched, [{ what: 'deleteProvider', args: ['p1'] }]);
});

test('a region outside the pair is refused with the route\'s sentence', async () => {
    const res = await dispatch({ method: 'PUT', url: '/providers/p1/region', body: { region: 'EU' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, "region must be 'eu' or 'default'");
    assert.deepStrictEqual(touched, []);
});

test('the region pair still switches an OpenAI provider', async () => {
    const res = await dispatch({ method: 'PUT', url: '/providers/p1/region', body: { region: 'eu' } });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.region, 'eu');
});

test('?refresh=1 is refused rather than read as "use the cache"', async () => {
    const res = await dispatch({ method: 'GET', url: '/providers/p1/models', query: { refresh: '1' } });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(fx.modelCalls, []);
});

test('?refresh=true forces the refresh', async () => {
    const res = await dispatch({ method: 'GET', url: '/providers/p1/models', query: { refresh: 'true' } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(fx.modelCalls, [['p1', true]]);
});
