/**
 * DB-free tests — which models get marked as self-hosted, and the environment
 * auto-registration of local runtimes.
 *
 * The registration decision is the one that touches money: a model in the
 * registry is billed at €0 (see modelCosts). It MUST key off the provider's
 * stored type, never off the adapter that happened to be resolved — the
 * adapter can also be picked by a URL guess, and a wrong guess in the "it's
 * local" direction would zero out a paying customer's real API spend.
 *
 * Run: node --test core/aiAgent.localProviders.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { installResolveStub } = require('../testUtils/stubRequire');

// In-memory config store standing in for Postgres.
const store = { ai: null };

// Keys are the require strings as written in core/llm/providerConfig.js and
// core/llm/modelCache.js, which is where the code under test lives; ./aiAgent
// is the façade the callers use.
const restore = installResolveStub({
    '../../stores/configStore': {
        getConfig: async (key) => (key === 'ai' ? store.ai : null),
        setConfig: async (key, value) => { if (key === 'ai') store.ai = value; },
        getSecret: async () => null,
        setSecret: async () => {},
    },
    '../../db': { getRedis: () => null, query: async () => ({ rows: [] }) },
});

const {
    getModelsForProvider,
    ensureLocalProviders,
    invalidateModelCache,
} = require('./aiAgent');
const {
    isLocalModel,
    _resetLocalModelRegistry,
} = require('./providers/localModels');

test.after(() => restore());

test.beforeEach(() => {
    store.ai = null;
    _resetLocalModelRegistry();
    invalidateModelCache();
    for (const k of ['OLLAMA_URL', 'VLLM_URL', 'LLAMACPP_URL', 'LMSTUDIO_URL', 'SGLANG_URL',
        'LOCAL_LLM_URL', 'LOCAL_LLM_TYPE', 'LOCAL_LLM_API_KEY']) {
        delete process.env[k];
    }
});

/** Serve a fixed /v1/models list for any discovery call. */
function stubModels(t, ids) {
    t.mock.method(globalThis, 'fetch', async () => new Response(
        JSON.stringify({ data: ids.map(id => ({ id })) }),
        { status: 200 },
    ));
}

// ─── Cost registration keys off the STORED provider type ─────────────────────

test('models from a provider typed as a local runtime are billed at €0', async (t) => {
    store.ai = {
        providers: [{ id: 'p1', name: 'GPU box', type: 'vllm', url: 'http://gpu-box:8000/v1', apiKey: '' }],
    };
    stubModels(t, ['Qwen/Qwen3-30B-A3B']);

    await getModelsForProvider('p1');
    assert.strictEqual(isLocalModel('Qwen/Qwen3-30B-A3B'), true);
});

test('a paid endpoint that merely LOOKS local is not billed at €0', async (t) => {
    // No stored type + a runtime port: getAdapter may still route this through
    // the local adapter, but the provider was never declared self-hosted, so
    // its models must keep normal pricing.
    store.ai = {
        providers: [{ id: 'p2', name: 'LiteLLM proxy', url: 'http://litellm:8000/v1', apiKey: 'sk-real' }],
    };
    stubModels(t, ['gpt-4o']);

    await getModelsForProvider('p2');
    assert.strictEqual(isLocalModel('gpt-4o'), false);
});

test('a cloud provider is never marked local', async (t) => {
    store.ai = {
        providers: [{ id: 'p3', name: 'OpenAI', type: 'openai', url: 'https://api.openai.com/v1', apiKey: 'sk-x' }],
    };
    stubModels(t, ['gpt-4o']);

    await getModelsForProvider('p3');
    assert.strictEqual(isLocalModel('gpt-4o'), false);
});

test('registration survives a warm model cache', async (t) => {
    // The registry is per-process; the model cache is not. A second call that
    // hits the cache must still leave the model registered, or a restarted
    // server bills self-hosted models at cloud rates until the cache expires.
    store.ai = {
        providers: [{ id: 'p4', name: 'Ollama', type: 'ollama', url: 'http://ollama:11434', apiKey: '' }],
    };
    stubModels(t, ['qwen3:8b']);

    await getModelsForProvider('p4');
    _resetLocalModelRegistry();                 // simulate a fresh process
    assert.strictEqual(isLocalModel('qwen3:8b'), false);

    await getModelsForProvider('p4');           // served from the warm cache
    assert.strictEqual(isLocalModel('qwen3:8b'), true);
});

// ─── Environment auto-registration ───────────────────────────────────────────

test('declares a provider for each local runtime env var', async () => {
    process.env.OLLAMA_URL = 'http://ollama:11434';
    process.env.VLLM_URL = 'http://gpu-box:8000/v1';

    await ensureLocalProviders();

    const byId = Object.fromEntries((store.ai?.providers || []).map(p => [p.id, p]));
    assert.strictEqual(byId['ollama-env'].type, 'ollama');
    assert.strictEqual(byId['ollama-env'].url, 'http://ollama:11434');
    assert.strictEqual(byId['vllm-env'].type, 'vllm');
    // First provider on a fresh install becomes the default.
    assert.strictEqual(store.ai.defaultProviderId, 'ollama-env');
});

test('is idempotent, and updates a changed URL in place', async () => {
    process.env.OLLAMA_URL = 'http://ollama:11434';
    await ensureLocalProviders();
    await ensureLocalProviders();
    assert.strictEqual(store.ai.providers.filter(p => p.id === 'ollama-env').length, 1);

    process.env.OLLAMA_URL = 'http://host.docker.internal:11434';
    await ensureLocalProviders();
    assert.strictEqual(store.ai.providers.filter(p => p.id === 'ollama-env').length, 1);
    assert.strictEqual(store.ai.providers[0].url, 'http://host.docker.internal:11434');
});

test('LOCAL_LLM_URL takes its adapter from LOCAL_LLM_TYPE and carries a key', async () => {
    process.env.LOCAL_LLM_URL = 'http://localhost:1234/v1';
    process.env.LOCAL_LLM_TYPE = 'lmstudio';
    process.env.LOCAL_LLM_API_KEY = 'lm-secret';

    await ensureLocalProviders();

    const p = store.ai.providers.find(x => x.id === 'lmstudio-env');
    assert.strictEqual(p.url, 'http://localhost:1234/v1');
    assert.strictEqual(p.apiKey, 'lm-secret');
});

test('an unknown LOCAL_LLM_TYPE is ignored rather than creating a broken provider', async () => {
    process.env.LOCAL_LLM_URL = 'http://localhost:9999/v1';
    process.env.LOCAL_LLM_TYPE = 'not-a-runtime';

    await ensureLocalProviders();
    assert.strictEqual(store.ai, null, 'nothing was written');
});

test('does nothing at all when no runtime env var is set', async () => {
    await ensureLocalProviders();
    assert.strictEqual(store.ai, null);
});

test('leaves an existing cloud provider as the default', async () => {
    store.ai = {
        providers: [{ id: 'openai-default', name: 'OpenAI', type: 'openai', url: 'https://api.openai.com/v1', apiKey: 'sk' }],
        defaultProviderId: 'openai-default',
    };
    process.env.OLLAMA_URL = 'http://ollama:11434';

    await ensureLocalProviders();
    assert.strictEqual(store.ai.defaultProviderId, 'openai-default');
    assert.strictEqual(store.ai.providers.length, 2);
});
