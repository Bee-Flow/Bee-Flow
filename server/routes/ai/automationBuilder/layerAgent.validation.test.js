/**
 * What POST /layer-agent accepts, and that it says so BEFORE the stream opens
 * (routes/ai/automationBuilder/layerAgent.js).
 *
 * `mode` was compared to 'refine' and everything else meant create. So a
 * refinement whose mode was misspelled ('Refine') or left out built a SECOND
 * flowlet beside the one it named, ran the sub-agent on that, and saved the
 * automation with both — under a 200 stream that ended in `done`.
 *
 * What this file pins: the refusal is a 400 with a sentence (the flowlet hook
 * shows `error` from a non-2xx), no stream is opened, and nothing reaches the
 * draft.
 *
 * Run: cd server && node --test routes/ai/automationBuilder/layerAgent.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every draft/agent call lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();

const MOCKS = {
    '../../../core/llm/modelResolver': { getUserTierMap: async () => ({ fast: {}, thinking: {} }) },
    '../../../automation/builderTools': {
        applyToolCall: async (name, args) => { touched.push(['applyToolCall', name, args]); return { layerKey: 'l_new' }; },
    },
    '../../../automation/flowletAgent': {
        resolveLayerAgentModel: async () => 'm-thinking',
        runLayerAgent: async ({ layerKey, mode, instruction }) => { touched.push(['runLayerAgent', layerKey, mode, instruction]); return { outputFields: [], summary: '' }; },
    },
    '../../../automation/builderCatalog': { buildCatalogForUser: async () => ({}) },
    '../../../automation/builderDatatableCatalog': { buildDatatableCatalogForUser: async () => [] },
    '../../../automation/builderDocumentCatalog': { buildDocumentCatalogForUser: async () => [] },
    '../../../core/entitlements/betaFeatures': { userHasBetaFeature: async () => true },
    '../../../core/http/sseHelpers': { startSseHeartbeat: () => () => {} },
    '../../../auth/permissions': { requireAuth: pass },
    './rateLimits': { layerAgentRateLimit: pass },
    './builderDraft': {
        loadOrCreateDraft: async ({ automationId }) => {
            touched.push(['loadOrCreateDraft', automationId]);
            return { automationId, def: { steps: [], layers: { l_existing: { title: 'Enrich', steps: [] } } } };
        },
        persistDraftWrap: async () => { touched.push(['persistDraftWrap']); },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:layer-agent-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /automationBuilder[\\/]layerAgent\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./layerAgent');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../../core/http/terminalErrorHandler');

function dispatch(body) {
    const url = '/layer-agent';
    return new Promise((resolve, reject) => {
        const req = {
            method: 'POST', url, originalUrl: url, path: url, body, query: {}, headers: {},
            session: { isAuthenticated: true, user: { id: 'u1', organizationId: 'orgA' } }, get() { return undefined; },
            on() {},
        };
        const res = {
            statusCode: 200, headersSent: false, writableEnded: false, events: [],
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            writeHead(c) { this.statusCode = c; this.headersSent = true; this.streamed = true; return this; },
            write(chunk) { const m = /^event: (\S+)/.exec(chunk); if (m) this.events.push(m[1]); return true; },
            end() { if (!this.writableEnded) { this.writableEnded = true; resolve(this); } return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error('fell through'));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => { touched.length = 0; });

function assertRefusedBeforeTheStream(res) {
    assert.strictEqual(res.statusCode, 400);
    assert.ok(!res.streamed, 'no SSE headers were written');
    assert.deepStrictEqual(touched, [], 'the draft is not loaded, let alone changed');
}

test('mode "Refine" is refused — it used to BUILD a second flowlet beside the one named', async () => {
    const res = await dispatch({ automationId: 'a1', instruction: 'add a retry', mode: 'Refine', layerKey: 'l_existing' });
    assertRefusedBeforeTheStream(res);
    assert.strictEqual(res.body.error, "mode is 'create' or 'refine'.");
});

test('a layerKey without mode "refine" is refused — create would ignore the key', async () => {
    const res = await dispatch({ automationId: 'a1', instruction: 'add a retry', layerKey: 'l_existing' });
    assertRefusedBeforeTheStream(res);
    assert.ok(res.body.details.some((d) => d.path === 'body.mode'));
});

test('refine without a layerKey is refused with a sentence that says so', async () => {
    const res = await dispatch({ automationId: 'a1', instruction: 'add a retry', mode: 'refine', layerKey: null });
    assertRefusedBeforeTheStream(res);
    assert.strictEqual(res.body.error, 'Refining needs the layerKey of the flowlet to refine.');
});

test('no automation is refused with the route\'s own sentence, as JSON', async () => {
    const res = await dispatch({ instruction: 'enrich the contact', mode: 'create' });
    assertRefusedBeforeTheStream(res);
    assert.strictEqual(res.body.error, 'Save the automation first, then build a flowlet.');
});

test('a blank instruction is refused before anything is loaded', async () => {
    const res = await dispatch({ automationId: 'a1', instruction: '   ', mode: 'create' });
    assertRefusedBeforeTheStream(res);
    assert.strictEqual(res.body.error, 'An instruction is required.');
});

test('a key the route does not know is refused rather than ignored', async () => {
    const res = await dispatch({ automationId: 'a1', instruction: 'x', mode: 'create', layer_key: 'l_existing' });
    assertRefusedBeforeTheStream(res);
});

test('the hook\'s create request builds one new flowlet', async () => {
    const res = await dispatch({ automationId: 'a1', instruction: 'enrich the contact', mode: 'create', layerKey: null, title: null });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.events.includes('done'), `events: ${res.events.join(', ')}`);
    assert.deepStrictEqual(touched.find((t) => t[0] === 'applyToolCall'), ['applyToolCall', 'builder_create_layer', { title: 'New layer' }]);
    assert.deepStrictEqual(touched.find((t) => t[0] === 'runLayerAgent'), ['runLayerAgent', 'l_new', 'create', 'enrich the contact']);
});

test('the hook\'s refine request refines the flowlet it names — and creates nothing', async () => {
    const res = await dispatch({ automationId: 'a1', instruction: 'add a retry', mode: 'refine', layerKey: 'l_existing', title: null });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.events.includes('done'));
    assert.strictEqual(touched.find((t) => t[0] === 'applyToolCall'), undefined);
    assert.deepStrictEqual(touched.find((t) => t[0] === 'runLayerAgent'), ['runLayerAgent', 'l_existing', 'refine', 'add a retry']);
});
