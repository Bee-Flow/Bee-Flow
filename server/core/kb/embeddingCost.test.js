// @typecheck strict
/**
 * #613: an embedding is priced at the rate of the provider that made it, not
 * always at Azure's. DB-free: the community pricing feed is a fake fetch.
 */
const test = require('node:test');
const assert = require('node:assert');

const { useConfigRows } = require('../../testUtils/configRows');
const { loadPricing } = require('../../testUtils/pricingFeed');

const config = useConfigRows(); // no admin cost overrides
const azureServiceUsageStore = require('../../stores/azureServiceUsageStore');
const { DEFAULTS } = require('../llm/azureServiceCosts');
const { embeddingCostFor, trackEmbeddingTokens } = require('./embeddingCost');

const TOKENS = 1_000_000;

test.before(() => loadPricing({
    'text-embedding-3-large': { input: 0.13, output: 0 },
    'scaleway/qwen/qwen3-embedding-8b': { input: 0.10, output: 0 },
    // The same open weights at another host: the exact scaleway/ key must win.
    'qwen3-embedding-8b': { input: 9.99, output: 0 },
    'ionos/BAAI/bge-m3': { input: 0.05, output: 0 },
    'bge-m3': { input: 9.99, output: 0 },
}));
test.after(config.restore);

const near = (/** @type {number} */ a, /** @type {number} */ b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('an OpenAI-compatible provider is priced at its own model rate', () => {
    near(embeddingCostFor(TOKENS, { source: 'provider', providerType: 'openai', model: 'text-embedding-3-large' }), 0.13);
});

test('Scaleway goes through the exact scaleway/<vendor>/<id> key', () => {
    near(embeddingCostFor(TOKENS, { source: 'provider', providerType: 'scaleway', model: 'qwen3-embedding-8b' }), 0.10);
});

test('IONOS goes through the exact ionos/<org>/<id> key', () => {
    near(embeddingCostFor(TOKENS, { source: 'provider', providerType: 'ionos', model: 'bge-m3' }), 0.05);
});

test('a self-hosted runtime costs nothing', () => {
    assert.strictEqual(embeddingCostFor(TOKENS, { source: 'provider', providerType: 'ollama', model: 'bge-m3' }), 0);
});

test('the legacy azure_openai_embedding_* path keeps the Azure rate', () => {
    near(embeddingCostFor(TOKENS, { source: 'azure', model: 'text-embedding-3-small' }), TOKENS * DEFAULTS.embedding_per_token);
    near(embeddingCostFor(TOKENS), TOKENS * DEFAULTS.embedding_per_token);
});

test('trackEmbeddingTokens logs the provider rate', async (t) => {
    /** @type {any[]} */
    const logged = [];
    t.mock.method(azureServiceUsageStore, 'logAzureServiceUsage', async (/** @type {any} */ u) => { logged.push(u); });
    trackEmbeddingTokens(TOKENS, { source: 'provider', providerType: 'ionos', model: 'bge-m3' });
    assert.strictEqual(logged.length, 1);
    near(logged[0].estimated_cost, 0.05);
});
