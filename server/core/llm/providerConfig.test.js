/**
 * Provider configuration over an in-memory config store: the two config
 * shapes getAIConfig answers from, where saveAIConfig routes each key, the
 * provider rows the ensure* family derives from secrets, and the provider
 * CRUD. ensureLocalProviders is covered by core/aiAgent.localProviders.test.js.
 *
 * Run: node --test --test-force-exit core/llm/providerConfig.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { installResolveStub } = require('../../testUtils/stubRequire');

const store = { config: new Map(), secrets: new Map(), writes: [], failing: false };
const configStoreStub = {
    getConfig: async (key) => {
        if (store.failing) throw new Error('database is down');
        return store.config.has(key) ? store.config.get(key) : null;
    },
    setConfig: async (key, value) => {
        if (store.failing) throw new Error('database is down');
        store.writes.push(key);
        // Deep copy, like a round trip through Postgres: a later mutation of
        // the object the caller still holds must not leak into the store.
        store.config.set(key, JSON.parse(JSON.stringify(value)));
    },
    getSecret: async (key) => store.secrets.has(key) ? store.secrets.get(key) : null,
    setSecret: async (key, value) => { store.secrets.set(key, value); },
};

const restore = installResolveStub({ '../../stores/configStore': configStoreStub });
test.after(() => restore());

const {
    PROVIDER_PRESETS,
    DEFAULT_CONFIG,
    getAIConfig,
    saveAIConfig,
    ensureScalewayProvider,
    getProviders,
    addProvider,
    updateProvider,
    deleteProvider,
    setDefaultProvider,
} = require('./providerConfig');

test.beforeEach(() => {
    store.config.clear();
    store.secrets.clear();
    store.writes = [];
    store.failing = false;
    delete process.env.SCALEWAY_API_KEY;
    delete process.env.SCALEWAY_URL;
});

const ai = () => store.config.get('ai');

// ─── getAIConfig ─────────────────────────────────────────────────────────────

test('getAIConfig answers from the default provider when there is one', async () => {
    store.config.set('ai', {
        providers: [
            { id: 'p1', name: 'One', type: 'openai', url: 'https://one.example/v1', model: 'm1', apiKey: 'k1' },
            { id: 'p2', name: 'Two', type: 'mistral', url: 'https://two.example/v1', model: 'm2', apiKey: 'k2' },
        ],
        defaultProviderId: 'p2',
        embeddingModel: 'mistral-embed',
    });
    const cfg = await getAIConfig();
    assert.strictEqual(cfg.url, 'https://two.example/v1');
    assert.strictEqual(cfg.model, 'm2');
    assert.strictEqual(cfg.apiKey, 'k2');
    assert.strictEqual(cfg.embeddingModel, 'mistral-embed');
    assert.strictEqual(cfg.piiDetectionAction, 'block');
    assert.deepStrictEqual(cfg.piiDetectionScope, { userInput: true, agentOutput: false });
});

test('getAIConfig falls back to the legacy single-provider fields, and the saved Mistral key wins over both', async () => {
    store.config.set('ai', { url: 'https://legacy.example', model: 'legacy-model', apiKey: 'in-config' });
    store.secrets.set('mistral_api_key', 'from-secret');
    const cfg = await getAIConfig();
    assert.strictEqual(cfg.url, 'https://legacy.example');
    assert.strictEqual(cfg.model, 'legacy-model');
    assert.strictEqual(cfg.apiKey, 'from-secret');
});

test('getAIConfig returns the built-in defaults when nothing is configured or the store is down', async () => {
    const empty = await getAIConfig();
    assert.strictEqual(empty.url, DEFAULT_CONFIG.url);
    assert.strictEqual(empty.model, DEFAULT_CONFIG.model);

    store.failing = true;
    assert.strictEqual(await getAIConfig(), DEFAULT_CONFIG);
});

// ─── saveAIConfig ────────────────────────────────────────────────────────────

test('saveAIConfig files each vendor key as a secret and derives that vendor\'s provider row', async () => {
    const ok = await saveAIConfig({
        url: 'https://api.mistral.ai/v1', model: 'ministral-8b-latest',
        openaiApiKey: 'sk-openai', claudeApiKey: 'sk-claude', googleApiKey: 'g-key',
        azureEndpoint: 'https://acme.openai.azure.com', azureApiKey: 'az-key', azureApiVersion: '2025-04-01-preview', // old clients still send it
        piiDetectionEnabled: true,
    });
    assert.strictEqual(ok, true);
    assert.strictEqual(store.secrets.get('openai_api_key'), 'sk-openai');
    assert.strictEqual(store.secrets.get('claude_api_key'), 'sk-claude');
    assert.strictEqual(store.secrets.get('google_api_key'), 'g-key');
    assert.strictEqual(store.secrets.get('azure_api_key'), 'az-key');
    assert.strictEqual(store.config.get('azure_endpoint'), 'https://acme.openai.azure.com');
    assert.strictEqual(ai().piiDetectionEnabled, true);

    const byId = Object.fromEntries(ai().providers.map(p => [p.id, p]));
    assert.strictEqual(byId['openai-default'].apiKey, 'sk-openai');
    assert.strictEqual(byId['claude-default'].url, 'https://api.anthropic.com/v1');
    assert.strictEqual(byId['google-default'].type, 'google');
    assert.strictEqual(byId['azure-default'].url, 'https://acme.openai.azure.com');
    assert.strictEqual(byId['azure-default'].apiVersion, undefined, 'Azure runs on v1 GA: no api-version is stored');
    assert.strictEqual(store.config.get('azure_api_version'), undefined);
    assert.ok(!byId['mistral-default'], 'no Mistral key was saved, so no Mistral row');
});

test('saveAIConfig keeps the PII settings it was not handed', async () => {
    store.config.set('ai', { piiDetectionEnabled: true, piiDetectionAction: 'redact', piiDetectionCategories: ['email'] });
    await saveAIConfig({ url: 'https://x.example/v1', model: 'm' });
    assert.strictEqual(ai().piiDetectionEnabled, true);
    assert.strictEqual(ai().piiDetectionAction, 'redact');
    assert.deepStrictEqual(ai().piiDetectionCategories, ['email']);
});

test('saveAIConfig re-saves an existing vendor row\'s key rather than adding a second row', async () => {
    store.config.set('ai', {
        providers: [{ id: 'openai-default', name: 'OpenAI', type: 'openai', url: 'https://api.openai.com/v1', model: 'gpt-4o', apiKey: 'old' }],
        defaultProviderId: 'openai-default',
    });
    await saveAIConfig({ openaiApiKey: 'new' });
    const rows = ai().providers.filter(p => p.type === 'openai');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].apiKey, 'new');
    assert.strictEqual(rows[0].model, 'gpt-4o', 'the chosen model survives a key change');
});

test('saveAIConfig reports a store failure instead of throwing', async () => {
    store.failing = true;
    assert.strictEqual(await saveAIConfig({ url: 'https://x.example/v1' }), false);
});

// ─── ensureScalewayProvider ──────────────────────────────────────────────────

test('ensureScalewayProvider derives the row from the shared Scaleway secret and writes only on change', async () => {
    store.secrets.set('scaleway_api_key', 'scw-key');
    store.config.set('scaleway_url', 'https://api.scaleway.ai/proj-1/');

    await ensureScalewayProvider();
    const row = ai().providers.find(p => p.id === 'scaleway-default');
    assert.strictEqual(row.type, 'scaleway');
    assert.strictEqual(row.url, 'https://api.scaleway.ai/proj-1/v1', 'one /v1, no doubled slash');
    assert.strictEqual(row.apiKey, 'scw-key');

    const writesBefore = store.writes.length;
    await ensureScalewayProvider();
    assert.strictEqual(store.writes.length, writesBefore, 'unchanged config is not rewritten on every read');

    store.secrets.set('scaleway_api_key', 'scw-rotated');
    await ensureScalewayProvider();
    assert.strictEqual(ai().providers.find(p => p.id === 'scaleway-default').apiKey, 'scw-rotated');
});

test('ensureScalewayProvider does nothing without a key', async () => {
    await ensureScalewayProvider();
    assert.strictEqual(ai(), undefined);
});

// ─── getProviders / CRUD ─────────────────────────────────────────────────────

test('getProviders returns the rows, the default and the presets (self-hosted runtimes included)', async () => {
    store.config.set('ai', { providers: [{ id: 'p1', name: 'One', type: 'openai', url: 'u', apiKey: 'k' }], defaultProviderId: 'p1' });
    const out = await getProviders();
    assert.strictEqual(out.providers.length, 1);
    assert.strictEqual(out.defaultProviderId, 'p1');
    assert.strictEqual(out.presets, PROVIDER_PRESETS);
    assert.strictEqual(PROVIDER_PRESETS.ollama.local, true);
    assert.strictEqual(PROVIDER_PRESETS.claude.needsApiKey, true);
});

test('addProvider: the first row becomes the default, vendor-specific fields are kept, an id is minted', async () => {
    const created = await addProvider({ name: 'Vertex', type: 'google-vertex', url: 'vertex-ai', project: 'proj', location: 'europe-west4', serviceAccountKey: '{}' });
    assert.ok(/^provider-\d+$/.test(created.id));
    assert.strictEqual(created.project, 'proj');
    assert.strictEqual(created.location, 'europe-west4');
    assert.strictEqual(ai().defaultProviderId, created.id);

    const second = await addProvider({ id: 'azure-1', name: 'Azure', type: 'azure', url: 'https://acme.openai.azure.com' });
    assert.strictEqual(second.id, 'azure-1');
    assert.strictEqual(ai().defaultProviderId, created.id, 'a second row does not steal the default');
});

test('updateProvider keeps the stored key when the update carries an empty one', async () => {
    store.config.set('ai', { providers: [{ id: 'p1', name: 'One', type: 'openai', url: 'u', model: 'm', apiKey: 'secret' }] });
    assert.strictEqual(await updateProvider('p1', { name: 'Renamed', apiKey: '' }), true);
    const row = ai().providers[0];
    assert.strictEqual(row.name, 'Renamed');
    assert.strictEqual(row.apiKey, 'secret');
    assert.strictEqual(row.model, 'm');
    assert.strictEqual(await updateProvider('nope', { name: 'x' }), false);
});

test('deleteProvider promotes the next row when the default is removed', async () => {
    store.config.set('ai', {
        providers: [{ id: 'p1', name: 'One', type: 'openai', url: 'u', apiKey: 'k' }, { id: 'p2', name: 'Two', type: 'mistral', url: 'u', apiKey: 'k' }],
        defaultProviderId: 'p1',
    });
    assert.strictEqual(await deleteProvider('p1'), true);
    assert.deepStrictEqual(ai().providers.map(p => p.id), ['p2']);
    assert.strictEqual(ai().defaultProviderId, 'p2');

    assert.strictEqual(await deleteProvider('p2'), true);
    assert.strictEqual(ai().defaultProviderId, null);
});

test('deleteProvider answers false for an unknown id, and writes nothing', async () => {
    store.config.set('ai', { providers: [{ id: 'p1', name: 'One', type: 'openai', url: 'u', apiKey: 'k' }], defaultProviderId: 'p1' });
    store.writes = [];
    assert.strictEqual(await deleteProvider('ghost'), false);
    assert.deepStrictEqual(store.writes, []);
    assert.deepStrictEqual(ai().providers.map(p => p.id), ['p1'], 'the provider that was meant stays');
});

test('setDefaultProvider refuses an unknown id without writing', async () => {
    store.config.set('ai', { providers: [{ id: 'p1', name: 'One', type: 'openai', url: 'u', apiKey: 'k' }], defaultProviderId: 'p1' });
    store.writes = [];
    assert.strictEqual(await setDefaultProvider('ghost'), false);
    assert.deepStrictEqual(store.writes, []);
    assert.strictEqual(await setDefaultProvider('p1'), true);
    assert.strictEqual(ai().defaultProviderId, 'p1');
});
