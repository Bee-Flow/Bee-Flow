/**
 * What POST /summarise-layer accepts (routes/ai/automationBuilder/layerSummary.js).
 *
 * The envelope is `{ layer }` and nothing else; the flowlet inside it stays
 * open, because the Build tab also sends the WHOLE root definition for its
 * own one-liner. validateLayerForSummary is still the gate on the flowlet,
 * with the same sentences, and a refusal never reaches the model.
 *
 * Run: cd server && node --test routes/ai/automationBuilder/layerSummary.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const modelCalls = [];
const pass = (req, res, next) => next();

const MOCKS = {
    '../../../core/llm/modelResolver': { resolveModelForTierName: async () => 'm-fast' },
    '../../../core/llm/llmClient': {
        chat: async (modelId, messages) => { modelCalls.push(messages); return { content: '"Looks up the contact."' }; },
    },
    '../../../automation/summarise': { summariseDefinition: (def) => ({ summary: `${(def.steps || []).length} steps` }) },
    '../../../auth/permissions': { requireAuth: pass },
    './rateLimits': { summariseLayerRateLimit: pass },
    '../../../core/entitlements/betaFeatures': { userHasBetaFeature: async () => true },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:layer-summary-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /automationBuilder[\\/]layerSummary\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./layerSummary');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../../core/http/terminalErrorHandler');

function dispatch(body) {
    const url = '/summarise-layer';
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

test.beforeEach(() => { modelCalls.length = 0; });

test('a key beside `layer` is refused, not ignored', async () => {
    const res = await dispatch({ layer: { title: 'Enrich', steps: [] }, force: true });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(modelCalls, []);
});

test('a missing flowlet keeps its sentence and names the field', async () => {
    const res = await dispatch({ flowlet: { steps: [] } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.layer' && d.message === 'A flowlet object with a steps array is required.'));
    assert.deepStrictEqual(modelCalls, []);
});

test('an oversized flowlet never reaches the model', async () => {
    const res = await dispatch({ layer: { steps: new Array(201).fill({ id: 's', type: 'code' }) } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Flowlet is too large to summarise.');
    assert.deepStrictEqual(modelCalls, []);
});

test('the Build tab\'s whole root definition is still accepted — the flowlet stays open', async () => {
    const root = { trigger: { type: 'manual' }, steps: [{ id: 's1', type: 'code' }], edges: [], layers: { l1: { steps: [] } }, description: '' };
    const res = await dispatch({ layer: root });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.summary, 'Looks up the contact.');
    assert.strictEqual(modelCalls.length, 1);
});
