/**
 * Which model a data_extraction step runs on — the resolution order and the
 * fixed request options.
 *
 * The order is the whole point: an admin-configured extraction model wins,
 * then the Fast tier's model, then the global default. The options never come
 * from a tier: temperature 0, no thinking, an output ceiling that grows with
 * the field count and stops at 4096, a two-minute timeout.
 *
 * Run: node --test --test-force-exit core/automationRunner/dataExtractionModel.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const { installResolveStub } = require('../../testUtils/stubRequire');

// ── Doubles for the three reads ────────────────────────────────────────────
let configured = null;
let configThrows = false;
let fastTier = { modelId: 'model-fast' };
let tierThrows = false;
let globalModel = 'model-global';
let tierReads = 0;
let aiStepModel = null;

/** The one config store both the resolver and the admin route read. */
const configStoreStub = {
    async getConfig(key) {
        if (configThrows) throw new Error('config store down');
        if (key === 'data_extraction_model') return configured;
        if (key === 'ai_step_model') return aiStepModel;
        return null;
    },
    async setConfig(key, value) {
        if (key === 'data_extraction_model') configured = value;
        else if (key === 'ai_step_model') aiStepModel = value;
    },
};

const restore = installResolveStub({
    '../../stores/configStore': configStoreStub,
    '../llm/modelResolver': {
        async getUserTierMap() {
            tierReads++;
            if (tierThrows) throw new Error('tier map down');
            return fastTier ? { fast: fastTier, thinking: { modelId: 'model-thinking' } } : { thinking: { modelId: 'model-thinking' } };
        },
    },
    '../aiAgent': {
        async getAIConfig() { return { model: globalModel }; },
    },
});
// The admin route, with its own requires cut at the seam — same store object
// as above, so what the route writes is what the resolver then reads.
const ROUTE_MOCKS = {
    '../../../stores/configStore': configStoreStub,
    './shared': { isAdminUser: async () => true },
    '../../../auth/permissions': { requireAuth: (req, res, next) => next(), getUserPermissions: async () => ({}) },
    '../../../core/aiAgent': { getProviderForModel: async (id) => ({ providerType: 'claude', modelId: id }) },
};
const routeIds = {};
for (const [request, exportsObj] of Object.entries(ROUTE_MOCKS)) {
    const id = `mock:data-extraction-route:${request}`;
    routeIds[request] = id;
    require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj };
}
const beforeRouteStub = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /config[\\/]modelTiers\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(routeIds, request)) return routeIds[request];
    return beforeRouteStub.call(this, request, parent, ...rest);
};

after(() => { Module._resolveFilename = beforeRouteStub; restore(); });

const {
    DATA_EXTRACTION_MODEL_KEY, extractionRequestOptions, dataExtractionModelFor, resolveDataExtractionModel,
} = require('./dataExtractionModel');

function reset() {
    configured = null; configThrows = false; fastTier = { modelId: 'model-fast' }; tierThrows = false;
    globalModel = 'model-global'; tierReads = 0;
}

// ── The pure decision ──────────────────────────────────────────────────────

test('the config key wins, trimmed', () => {
    assert.deepEqual(
        dataExtractionModelFor({ configured: ' lfm2-1.2b-extract ', fastTierModelId: 'fast', globalModelId: 'global' }),
        { modelId: 'lfm2-1.2b-extract', source: 'config' },
    );
});

test('a blank or non-string config key hands over to the fast tier', () => {
    for (const configured of [null, undefined, '', '   ', 42, {}]) {
        assert.deepEqual(
            dataExtractionModelFor({ configured, fastTierModelId: 'model-fast', globalModelId: 'global' }),
            { modelId: 'model-fast', source: 'fast_tier' }, String(configured),
        );
    }
});

test('no fast tier → the global default; nothing anywhere → null, never a made-up id', () => {
    assert.deepEqual(dataExtractionModelFor({ configured: null, fastTierModelId: '', globalModelId: 'model-global' }), { modelId: 'model-global', source: 'global' });
    assert.deepEqual(dataExtractionModelFor({ configured: null, fastTierModelId: null, globalModelId: null }), { modelId: null, source: null });
});

// ── The async wrapper and its fallbacks ────────────────────────────────────

test('resolution order: config → fast tier → global', async () => {
    reset();
    configured = 'model-extract';
    assert.deepEqual(await resolveDataExtractionModel({ userId: 'u1' }), { modelId: 'model-extract', source: 'config' });
    assert.equal(tierReads, 0, 'a configured model never costs a tier lookup');

    reset();
    assert.deepEqual(await resolveDataExtractionModel({ userId: 'u1' }), { modelId: 'model-fast', source: 'fast_tier' });

    reset();
    fastTier = null;
    assert.deepEqual(await resolveDataExtractionModel({ userId: 'u1' }), { modelId: 'model-global', source: 'global' });

    reset();
    fastTier = { modelId: '' };
    globalModel = null;
    assert.deepEqual(await resolveDataExtractionModel({ userId: 'u1' }), { modelId: null, source: null });
});

test('a failing read hands over to the next source instead of failing the step', async () => {
    reset();
    configThrows = true;
    assert.deepEqual(await resolveDataExtractionModel({ userId: 'u1' }), { modelId: 'model-fast', source: 'fast_tier' });

    reset();
    tierThrows = true;
    assert.deepEqual(await resolveDataExtractionModel({ userId: 'u1' }), { modelId: 'model-global', source: 'global' });
});

// ── The fixed options ──────────────────────────────────────────────────────

test('request options are fixed and grow only with the field count, capped at 4096', () => {
    const one = extractionRequestOptions(1);
    assert.equal(one.temperature, 0);
    assert.equal(one.reasoningEffort, 'none');
    assert.equal(one.timeoutMs, 120000);
    assert.equal(one.maxTokens, 512 + 96);
    assert.equal(extractionRequestOptions(2).maxTokens, 512 + 96 * 2);
    assert.equal(extractionRequestOptions(30).maxTokens, 512 + 96 * 30);
    assert.equal(extractionRequestOptions(37).maxTokens, 4064);
    assert.equal(extractionRequestOptions(38).maxTokens, 4096, 'the cap');
    assert.equal(extractionRequestOptions(1000).maxTokens, 4096);
    // Garbage in → the floor, never NaN.
    assert.equal(extractionRequestOptions(undefined).maxTokens, 512);
    assert.equal(extractionRequestOptions(-3).maxTokens, 512);
    assert.deepEqual(Object.keys(one).sort(), ['maxTokens', 'reasoningEffort', 'temperature', 'timeoutMs'], 'no tools, no tier options');
});

// ── The key and the route agree ────────────────────────────────────────────

const modelTiersRouter = require('../../routes/ai/config/modelTiers');
const { resolveAiStepModelOverride } = require('./aiStepModel');

function handlerFor(method, routePath) {
    const layer = modelTiersRouter.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
    assert.ok(layer, `${method.toUpperCase()} ${routePath} is no longer mounted`);
    const handlers = layer.route.stack.map(s => s.handle);
    return handlers[handlers.length - 1];
}

async function callRoute(handler, req) {
    let body = null; let status = 200;
    const res = { json: (b) => { body = b; return res; }, status: (s) => { status = s; return res; } };
    await handler(req, res);
    return { status, body };
}

test('what the admin route saves is what the step then runs on', async () => {
    reset();
    const get = handlerFor('get', '/config/data-extraction-model');
    const post = handlerFor('post', '/config/data-extraction-model');

    assert.deepEqual((await callRoute(get, { session: {} })).body, { modelId: null }, 'unset reads as null');
    assert.deepEqual(await resolveDataExtractionModel({ userId: 'u1' }), { modelId: 'model-fast', source: 'fast_tier' });

    const saved = await callRoute(post, { session: {}, body: { modelId: 'lfm2-1.2b-extract' } });
    assert.equal(saved.body.success, true);
    assert.deepEqual((await callRoute(get, { session: {} })).body, { modelId: 'lfm2-1.2b-extract' });
    assert.deepEqual(
        await resolveDataExtractionModel({ userId: 'u1' }),
        { modelId: 'lfm2-1.2b-extract', source: 'config' },
        'the route and the resolver must be talking about the same key',
    );

    // Clearing it hands the decision back to the tier.
    await callRoute(post, { session: {}, body: { modelId: null } });
    assert.deepEqual(await resolveDataExtractionModel({ userId: 'u1' }), { modelId: 'model-fast', source: 'fast_tier' });
});

test('the extraction model is a separate lever from the owner\'s ai_step override', async () => {
    reset();
    assert.equal(DATA_EXTRACTION_MODEL_KEY, 'data_extraction_model');

    await callRoute(handlerFor('post', '/config/data-extraction-model'), { session: {}, body: { modelId: 'lfm2-1.2b-extract' } });
    assert.equal(await resolveAiStepModelOverride({ requestedTier: 'fast' }), null,
        'setting the extraction model must not move an ai_step onto it');

    await callRoute(handlerFor('post', '/config/ai-step-model'), { session: {}, body: { modelId: 'some-other-model' } });
    assert.equal(await resolveAiStepModelOverride({ requestedTier: 'fast' }), 'some-other-model');
    assert.deepEqual(
        await resolveDataExtractionModel({ userId: 'u1' }),
        { modelId: 'lfm2-1.2b-extract', source: 'config' },
        'and the ai_step lever must not move data extraction either',
    );
});
