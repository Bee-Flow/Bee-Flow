// @typecheck strict
/**
 * DB-free tests: an IONOS-served model is billed at IONOS's EUR tariff, never
 * at another host's rate for the same open weights.
 *
 * Run: node --test core/llm/modelCosts.ionos.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { useConfigRows } = require('../../testUtils/configRows');
const { loadPricing } = require('../../testUtils/pricingFeed');

const WRONG_HOST_RATE = { input: 9.99, output: 99.9, cacheRead: 0 };
const WRONG_HOST_IDS = ['gpt-oss-120b', 'openai/gpt-oss-120b', 'meta-llama/Llama-3.3-70B-Instruct', 'acme/brand-new-7b'];
const config = useConfigRows();

const { registerIonosModel, _resetIonosModelRegistry } = require('../providers/ionosModels');
const { getModelCost, computeCost } = require('./modelCosts');

test.before(() => loadPricing({
    'ionos/openai/gpt-oss-120b': { input: 0.20, output: 0.70, cacheRead: 0 },
    ...Object.fromEntries(WRONG_HOST_IDS.map((id) => [id, WRONG_HOST_RATE])),
}));
test.after(config.restore);
test.beforeEach(() => _resetIonosModelRegistry());

test('an unregistered model takes the ordinary lookup', () => {
    assert.deepStrictEqual(getModelCost('meta-llama/Llama-3.3-70B-Instruct'), WRONG_HOST_RATE);
});

test('an IONOS-served model with a community ionos/ key uses that key', () => {
    registerIonosModel('openai/gpt-oss-120b');
    assert.deepStrictEqual(getModelCost('openai/gpt-oss-120b'), { input: 0.20, output: 0.70, cacheRead: 0 });
});

test('falls back to the catalog list price', () => {
    registerIonosModel('meta-llama/Llama-3.3-70B-Instruct');
    assert.deepStrictEqual(getModelCost('meta-llama/Llama-3.3-70B-Instruct'), { input: 0.65, output: 0.65, cacheRead: 0 });
    assert.strictEqual(computeCost('meta-llama/Llama-3.3-70B-Instruct', 1_000_000, 1_000_000), 1.3);
});

test('a served id outside the catalog is never priced from another host', () => {
    registerIonosModel('acme/brand-new-7b');
    assert.notDeepStrictEqual(getModelCost('acme/brand-new-7b'), WRONG_HOST_RATE);
});
