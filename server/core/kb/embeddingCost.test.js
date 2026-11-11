/**
 * KB embedding cost is priced by the provider that did the embedding, not
 * always at Azure's rate (#613).
 *
 * DB-free: the config table is the stand-in of testUtils/configRows, the
 * community pricing file comes from testUtils/pricingFeed (the real
 * pricingService and modelCosts run), and the usage store's insert is caught
 * where embeddingCost calls it.
 *
 * Run: cd server && node --test core/kb/embeddingCost.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { useConfigRows } = require('../../testUtils/configRows');
const { loadPricing } = require('../../testUtils/pricingFeed');

const config = useConfigRows();

const azureServiceUsageStore = require('../../stores/azureServiceUsageStore');
const { _resetScalewayModelRegistry } = require('../providers/scalewayModels');
const { _resetIonosModelRegistry } = require('../providers/ionosModels');
const { invalidateFxCache } = require('../text/currency');
const { trackEmbeddingTokens, trackEmbeddingCost } = require('./embeddingCost');

/** @type {Array<Record<string, any>>} */
const logged = [];
const realLog = azureServiceUsageStore.logAzureServiceUsage;

// Another host's price for the same open weights: a fuzzy match would land here.
const WRONG_HOST = { input: 9.99, output: 0 };

test.before(async () => {
    azureServiceUsageStore.logAzureServiceUsage = async (entry) => { logged.push(entry); };
    await loadPricing({
        'scaleway/qwen/qwen3-embedding-8b': { input: 0.12, output: 0 },
        'qwen3-embedding-8b': WRONG_HOST,
        'bge-m3': WRONG_HOST,
        'text-embedding-3-large': { input: 0.13, output: 0 },
    });
});
test.after(() => {
    azureServiceUsageStore.logAzureServiceUsage = realLog;
    config.restore();
});
test.beforeEach(() => {
    logged.length = 0;
    config.reset();
    invalidateFxCache();
    _resetScalewayModelRegistry();
    _resetIonosModelRegistry();
});

const MILLION = 1_000_000;
const close = (/** @type {number} */ a, /** @type {number} */ b) => Math.abs(a - b) < 1e-9;

test('a Scaleway target is priced at the Scaleway card (exact key), in USD at the configured rate', async () => {
    config.rows.currency_fx_usd_eur = 0.8; // 1 USD = 0.8 EUR
    await trackEmbeddingTokens(MILLION, { providerType: 'scaleway', modelId: 'qwen3-embedding-8b' });
    assert.strictEqual(logged.length, 1);
    const [row] = logged;
    assert.strictEqual(row.service_type, 'embedding');
    assert.strictEqual(row.tokens, MILLION);
    assert.ok(close(row.estimated_cost, 0.12 / 0.8), `EUR 0.12 per 1M at 0.8 EUR/USD, got ${row.estimated_cost}`);
    assert.strictEqual(row.metadata.provider_type, 'scaleway');
    assert.strictEqual(row.metadata.model, 'qwen3-embedding-8b');
    assert.strictEqual(row.metadata.price_currency, 'EUR');
    assert.ok(close(row.metadata.price_cost, 0.12));
    assert.strictEqual(row.metadata.price_source, 'litellm:scaleway');
});

test('an IONOS target is priced at the IONOS list price, never another host\'s rate', async () => {
    config.rows.currency_fx_usd_eur = 1;
    await trackEmbeddingTokens(MILLION, { providerType: 'ionos', modelId: 'BAAI/bge-m3' });
    const [row] = logged;
    assert.ok(close(row.estimated_cost, 0.02), `IONOS bge-m3 lists EUR 0.02 per 1M, got ${row.estimated_cost}`);
    assert.strictEqual(row.metadata.price_source, 'repo:ionos');
});

test('a self-hosted target costs nothing, decided on the stored provider type', async () => {
    // The model id is one a cloud host prices: the stored type decides, not the name.
    await trackEmbeddingTokens(MILLION, { providerType: 'ollama', modelId: 'qwen3-embedding-8b' });
    const [row] = logged;
    assert.strictEqual(row.estimated_cost, 0);
    assert.strictEqual(row.tokens, MILLION);
    assert.strictEqual(row.metadata.cost_basis, 'local');
});

test('another cloud provider is priced through modelCosts with its own model', async () => {
    await trackEmbeddingTokens(MILLION, { providerType: 'openai', modelId: 'text-embedding-3-large' });
    const [row] = logged;
    assert.ok(close(row.estimated_cost, 0.13), `got ${row.estimated_cost}`);
    assert.strictEqual(row.metadata.price_currency, 'USD');
});

test('an Azure target, and no target at all (the legacy Azure path), are rated as before', async () => {
    const { computeEmbeddingCost } = require('../llm/azureServiceCosts');
    const expected = computeEmbeddingCost(MILLION);
    assert.ok(expected > 0);

    await trackEmbeddingTokens(MILLION, { providerType: 'azure', modelId: 'text-embedding-3-large' });
    await trackEmbeddingTokens(MILLION);
    await trackEmbeddingCost(['abcd'.repeat(10)], null);
    assert.strictEqual(logged.length, 3);
    for (const row of logged.slice(0, 2)) {
        assert.deepStrictEqual(row, { service_type: 'embedding', tokens: MILLION, estimated_cost: expected, source: 'kb_upload' });
    }
    assert.ok(!('metadata' in logged[2]));
});

test('a failing price lookup is logged, never thrown', async () => {
    config.failOn(true);
    config.rows.currency_fx_usd_eur = 0.8;
    await assert.doesNotReject(trackEmbeddingTokens(MILLION, { providerType: 'scaleway', modelId: 'qwen3-embedding-8b' }));
});
