/**
 * The model cache without Redis: the in-process TTL, invalidation, the
 * cross-provider id listing, the "who serves this model" lookup, and the
 * cost-registry stamping that has to happen on every return path. The
 * self-hosted (€0) stamping is pinned in core/aiAgent.localProviders.test.js.
 *
 * Run: node --test --test-force-exit core/llm/modelCache.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { installResolveStub } = require('../../testUtils/stubRequire');

const store = { ai: null, providersRaw: null };
const adapter = { calls: [], models: [] };
// A provider carrying this key stands for one whose discovery call fails.
const FAILING_KEY = 'sk-broken';

const restore = installResolveStub({
    '../../stores/configStore': {
        getConfig: async (key) => {
            if (key === 'ai') return store.ai;
            if (key === 'ai_providers') return store.providersRaw;
            return null;
        },
        setConfig: async (key, value) => { if (key === 'ai') store.ai = value; },
        getSecret: async () => null,
        setSecret: async () => {},
    },
    '../../db': { getRedis: () => null },
    '../providers': {
        getAdapter: (type, url) => ({
            listModels: async (apiKey, baseUrl, extra) => {
                adapter.calls.push({ type, url, apiKey, baseUrl, extra });
                if (apiKey === FAILING_KEY) throw new Error('discovery failed');
                return adapter.models;
            },
        }),
    },
});
test.after(() => restore());

const {
    getModelsForProvider,
    invalidateModelCache,
    getAllCachedModelIds,
    getProviderForModel,
} = require('./modelCache');
const { isScalewayServedModel, _resetScalewayModelRegistry } = require('../providers/scalewayModels');
const { isEuServedModel, _resetEuServedRegistry, OPENAI_EU_BASE_URL } = require('../providers/openaiModels');

const provider = (over = {}) => ({ id: 'p1', name: 'OpenAI', type: 'openai', url: 'https://api.openai.com/v1/', apiKey: 'sk-1', ...over });
const ids = (list) => list.map(m => m.id);

test.beforeEach(() => {
    store.ai = null;
    store.providersRaw = null;
    adapter.calls = [];
    adapter.models = [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }];
    invalidateModelCache();
    _resetScalewayModelRegistry();
    _resetEuServedRegistry();
});

// ─── getModelsForProvider ────────────────────────────────────────────────────

test('discovers through the adapter once, then serves the process cache', async () => {
    store.ai = { providers: [provider()] };
    assert.deepStrictEqual(ids(await getModelsForProvider('p1')), ['gpt-4o', 'gpt-4o-mini']);
    assert.deepStrictEqual(ids(await getModelsForProvider('p1')), ['gpt-4o', 'gpt-4o-mini']);
    assert.strictEqual(adapter.calls.length, 1);
    assert.strictEqual(adapter.calls[0].baseUrl, 'https://api.openai.com/v1', 'trailing slash stripped for the adapter');
    assert.strictEqual(adapter.calls[0].apiKey, 'sk-1');
});

test('forceRefresh asks the adapter again', async () => {
    store.ai = { providers: [provider()] };
    await getModelsForProvider('p1');
    adapter.models = [{ id: 'gpt-5.2' }];
    assert.deepStrictEqual(ids(await getModelsForProvider('p1', true)), ['gpt-5.2']);
    assert.strictEqual(adapter.calls.length, 2);
});

test('an empty discovery is remembered briefly, then asked again', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    store.ai = { providers: [provider()] };
    adapter.models = [];
    assert.deepStrictEqual(await getModelsForProvider('p1'), []);
    adapter.models = [{ id: 'gpt-4o' }];
    assert.deepStrictEqual(await getModelsForProvider('p1'), [], 'still empty inside the window');
    assert.strictEqual(adapter.calls.length, 1);
    t.mock.timers.tick(31_000);
    assert.deepStrictEqual(ids(await getModelsForProvider('p1')), ['gpt-4o']);
    assert.strictEqual(adapter.calls.length, 2);
});

test('invalidating a provider forgets that it was empty', async () => {
    store.ai = { providers: [provider()] };
    adapter.models = [];
    await getModelsForProvider('p1');
    adapter.models = [{ id: 'gpt-4o' }];
    invalidateModelCache('p1');
    assert.deepStrictEqual(ids(await getModelsForProvider('p1')), ['gpt-4o']);
});

test('a failed discovery is remembered too, so a dead endpoint is not probed every turn', async () => {
    store.ai = { providers: [provider({ apiKey: FAILING_KEY })] };
    await assert.rejects(() => getModelsForProvider('p1'), /discovery failed/);
    assert.deepStrictEqual(await getModelsForProvider('p1'), []);
    assert.strictEqual(adapter.calls.length, 1);
});

test('an expired list is served at once and refreshed once in the background', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    store.ai = { providers: [provider()] };
    await getModelsForProvider('p1');
    adapter.models = [{ id: 'gpt-5.2' }];
    t.mock.timers.tick(61_000);
    const [a, b] = await Promise.all([getModelsForProvider('p1'), getModelsForProvider('p1')]);
    assert.deepStrictEqual(ids(a), ['gpt-4o', 'gpt-4o-mini'], 'stale, not waited for');
    assert.deepStrictEqual(ids(b), ['gpt-4o', 'gpt-4o-mini']);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(adapter.calls.length, 2, 'one background refresh, not one per call');
    assert.deepStrictEqual(ids(await getModelsForProvider('p1')), ['gpt-5.2']);
});

test('an unknown provider yields an empty list without touching an adapter', async () => {
    store.ai = { providers: [provider()] };
    assert.deepStrictEqual(await getModelsForProvider('ghost'), []);
    assert.strictEqual(adapter.calls.length, 0);
});

test('vendor-specific connection fields reach the adapter', async () => {
    store.ai = { providers: [provider({ id: 'v', type: 'google-vertex', url: 'vertex-ai', project: 'proj', location: 'eu', serviceAccountKey: '{}' })] };
    await getModelsForProvider('v');
    assert.deepStrictEqual(adapter.calls[0].extra, { project: 'proj', location: 'eu', serviceAccountKey: '{}' });
});

// ─── invalidateModelCache ────────────────────────────────────────────────────

test('invalidating one provider leaves the others cached; invalidating all drops everything', async () => {
    store.ai = { providers: [provider(), provider({ id: 'p2', name: 'Two' })] };
    await getModelsForProvider('p1');
    await getModelsForProvider('p2');
    adapter.calls = [];

    invalidateModelCache('p1');
    await getModelsForProvider('p1');
    await getModelsForProvider('p2');
    assert.deepStrictEqual(adapter.calls.map(c => c.type), ['openai'], 'only p1 was re-fetched');

    adapter.calls = [];
    invalidateModelCache();
    await getModelsForProvider('p1');
    await getModelsForProvider('p2');
    assert.strictEqual(adapter.calls.length, 2);
});

// ─── getAllCachedModelIds ────────────────────────────────────────────────────

test('getAllCachedModelIds lists every cached model once per provider name', async () => {
    store.ai = { providers: [provider(), provider({ id: 'p2', name: 'Mirror', type: 'azure' })] };
    store.providersRaw = JSON.stringify([{ id: 'p1', name: 'OpenAI', type: 'openai' }]);
    await getModelsForProvider('p1');
    await getModelsForProvider('p2');

    const all = await getAllCachedModelIds();
    const rows = all.map(r => `${r.providerName}/${r.providerType}/${r.id}`).sort();
    assert.deepStrictEqual(rows, [
        'OpenAI/openai/gpt-4o',
        'OpenAI/openai/gpt-4o-mini',
        'Unknown/unknown/gpt-4o',
        'Unknown/unknown/gpt-4o-mini',
    ], 'p2 is not in the ai_providers record, so it is listed as Unknown');
});

// ─── getProviderForModel ─────────────────────────────────────────────────────

test('getProviderForModel returns the connection record of the provider that serves the model', async () => {
    store.ai = { providers: [provider()] };
    const rec = await getProviderForModel('gpt-4o-mini');
    assert.deepStrictEqual(rec, {
        url: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        apiKey: 'sk-1',
        providerId: 'p1',
        providerName: 'OpenAI',
        providerType: 'openai',
        project: null,
        location: null,
        serviceAccountKey: null,
    });
});

test('getProviderForModel resolves a display name before looking', async () => {
    store.ai = { providers: [provider()] };
    const rec = await getProviderForModel('GPT-4o Mini');
    assert.strictEqual(rec.model, 'gpt-4o-mini');
});

test('getProviderForModel skips a provider whose discovery fails and finds the model elsewhere', async () => {
    store.ai = { providers: [provider({ id: 'broken', name: 'Broken', apiKey: FAILING_KEY }), provider({ id: 'p2', name: 'Two' })] };
    const rec = await getProviderForModel('gpt-4o');
    assert.strictEqual(rec.providerId, 'p2');
});

test('getProviderForModel asks a provider whose cached list holds the model first', async () => {
    store.ai = { providers: [provider({ id: 'p1', name: 'One' }), provider({ id: 'p2', name: 'Two' })] };
    adapter.models = [{ id: 'only-on-two' }];
    await getModelsForProvider('p2');
    adapter.calls = [];
    const rec = await getProviderForModel('only-on-two');
    assert.strictEqual(rec.providerId, 'p2');
    assert.strictEqual(adapter.calls.length, 0, 'no discovery of p1 on the way');
});

test('getProviderForModel throws when no configured provider serves the model', async () => {
    store.ai = { providers: [provider()] };
    await assert.rejects(() => getProviderForModel('claude-opus-4-8'), /not found in any configured provider/);
});

test('getProviderForModel falls back to the global config when there are no providers at all', async () => {
    store.ai = { url: 'https://legacy.example', model: 'legacy-model' };
    const rec = await getProviderForModel('anything');
    assert.strictEqual(rec.url, 'https://legacy.example');
    assert.strictEqual(rec.model, 'legacy-model');
    assert.strictEqual(adapter.calls.length, 0);
});

// ─── Cost-registry stamping ──────────────────────────────────────────────────

test('a Scaleway-typed provider pins its models to Scaleway\'s tariff, on discovery and on a cache hit', async () => {
    store.ai = { providers: [provider({ id: 's', name: 'Scaleway', type: 'scaleway', url: 'https://api.scaleway.ai/v1' })] };
    adapter.models = [{ id: 'llama-3.3-70b-instruct' }];
    await getModelsForProvider('s');
    assert.strictEqual(isScalewayServedModel('llama-3.3-70b-instruct'), true);

    _resetScalewayModelRegistry();          // a fresh process, warm cache
    await getModelsForProvider('s');
    assert.strictEqual(isScalewayServedModel('llama-3.3-70b-instruct'), true);
});

test('an OpenAI provider on the EU endpoint marks its models EU-served, and unmarks them when the URL moves back', async () => {
    store.ai = { providers: [provider({ url: OPENAI_EU_BASE_URL })] };
    await getProviderForModel('gpt-4o');
    assert.strictEqual(isEuServedModel('gpt-4o'), true);

    store.ai = { providers: [provider()] };
    await getProviderForModel('gpt-4o');
    assert.strictEqual(isEuServedModel('gpt-4o'), false);
});
