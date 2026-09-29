/**
 * What the model-tier config routes accept (routes/ai/config/modelTiers.js).
 *
 * Six of these routes set one model id and each carried its own copy of
 * `typeof raw === 'string' && raw.trim() ? raw.trim() : null`. That copy made
 * every malformed body look like "clear this setting": POST `{ modelid: 'x' }`
 * with the key misspelled UNSET the auto-classifier and answered 200, and the
 * admin screen — which saves on a toggle, with no confirmation to read —
 * showed the model still selected. The schema is one place now, and what this
 * pins is what a caller can act on:
 *
 *   - the 400 names the field, so a misspelled key is visible;
 *   - the config store is never written on a refusal;
 *   - clearing a setting still works, because that is what the UI does.
 *
 * Run: cd server && node --test --test-force-exit routes/ai/config/modelTiers.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// ── Fixtures ────────────────────────────────────────────────────────
const writes = [];       // every configStore.setConfig call
const fx = { knownModels: ['m-known'] };

const MOCKS = {
    '../../../stores/configStore': {
        getConfig: async () => null,
        setConfig: async (key, value) => { writes.push([key, value]); },
    },
    './shared': { isAdminUser: async () => true },
    '../../../auth/permissions': {
        requireAuth: (req, res, next) => (req.session?.user?.id ? next() : res.status(401).json({ error: 'Not authenticated' })),
    },
    '../../../core/aiAgent': {
        getProviderForModel: async (id) => {
            if (!fx.knownModels.includes(id)) throw new Error('unknown model');
            return { providerType: 'claude', url: '' };
        },
    },
    '../../../core/llm/promptClassifier': { clearClassifierCache: () => {} },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:model-tiers-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /config[\\/]modelTiers\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./modelTiers');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the harness
// has to be an app with one.
function dispatch({ method, url, body = {}, session = { user: { id: 'alice' } } }) {
    return new Promise((resolve, reject) => {
        const req = { method, url, body, headers: {}, session, query: {}, get() { return undefined; } };
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: ${method} ${url}`));
            const status = Number(err.status || err.statusCode) || 500;
            if (status >= 500) return reject(err);
            return res.status(status).json({ error: err.message, code: err.code, details: err.details });
        });
    });
}

test.beforeEach(() => { writes.length = 0; });

const SINGLE_MODEL_ROUTES = [
    ['/config/auto-classifier', 'auto_classifier_model'],
    ['/config/title-model', 'title_generation_model'],
    ['/config/memory-extraction-model', 'memory_extraction_model'],
    ['/config/data-extraction-model', 'data_extraction_model'],
    ['/config/ai-step-model', 'ai_step_model'],
    ['/config/builder-narration-model', 'builder_narration_model'],
];

// ═══ The six single-model routes share one schema ═══════════════════

for (const [url, configKey] of SINGLE_MODEL_ROUTES) {
    test(`${url}: a model id that is not text is refused by name`, async () => {
        const res = await dispatch({ method: 'POST', url, body: { modelId: 42 } });
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(res.body.code, 'invalid_request');
        assert.ok(res.body.details.some((d) => d.path === 'body.modelId'),
            `the 400 must name body.modelId; it said ${JSON.stringify(res.body.details)}`);
        assert.deepStrictEqual(writes, [], 'a refused request must not write the config');
    });

    test(`${url}: a misspelled key is refused, not read as "clear this setting"`, async () => {
        const res = await dispatch({ method: 'POST', url, body: { modelid: 'm-known' } });
        assert.strictEqual(res.statusCode, 400);
        assert.deepStrictEqual(writes, [], `${configKey} must keep its value`);
    });

    test(`${url}: clearing the setting still works — that is what the picker sends`, async () => {
        const res = await dispatch({ method: 'POST', url, body: { modelId: null } });
        assert.strictEqual(res.statusCode, 200);
        assert.deepStrictEqual(writes, [[configKey, null]]);
    });

    test(`${url}: a surrounding space is not part of a model id`, async () => {
        const res = await dispatch({ method: 'POST', url, body: { modelId: '  m-known  ' } });
        assert.strictEqual(res.statusCode, 200);
        assert.deepStrictEqual(writes, [[configKey, 'm-known']]);
    });
}

test('an unconfigured model is still refused by the provider lookup, not the schema', async () => {
    // The schema says what a model id LOOKS like; only the provider registry
    // knows whether one exists. Both refusals have to survive.
    const res = await dispatch({ method: 'POST', url: '/config/auto-classifier', body: { modelId: 'm-nope' } });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /not found in any configured provider/);
    assert.deepStrictEqual(writes, []);
});

// ═══ Hidden models ══════════════════════════════════════════════════

test('hidden models must be a list, and the refusal says so by name', async () => {
    const res = await dispatch({ method: 'POST', url: '/config/hidden-models', body: { modelIds: 'm-known' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'modelIds must be an array');
    assert.ok(res.body.details.some((d) => d.path === 'body.modelIds'));
    assert.deepStrictEqual(writes, []);
});

test('an entry that is not text names its index, so the caller can find it', async () => {
    const res = await dispatch({ method: 'POST', url: '/config/hidden-models', body: { modelIds: ['a', 7] } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.modelIds.1'));
    assert.deepStrictEqual(writes, []);
});

test('a blocklist is a set: blanks and repeats collapse', async () => {
    const res = await dispatch({ method: 'POST', url: '/config/hidden-models', body: { modelIds: [' a ', 'a', '', 'b'] } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(writes, [['hidden_model_ids', ['a', 'b']]]);
});

// ═══ Claude settings ════════════════════════════════════════════════

test('a Claude toggle that is not a boolean is refused rather than read as "on"', async () => {
    // `autoRetryOnEmpty !== false` made every malformed value mean true, so a
    // caller who sent the string 'false' turned the retry ON.
    const res = await dispatch({ method: 'POST', url: '/config/claude-settings', body: { autoRetryOnEmpty: 'false' } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.autoRetryOnEmpty'));
    assert.deepStrictEqual(writes, []);
});

test('an omitted Claude toggle keeps its documented default of true', async () => {
    const res = await dispatch({ method: 'POST', url: '/config/claude-settings', body: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(writes, [['claude_settings', { autoRetryOnEmpty: true }]]);
});
