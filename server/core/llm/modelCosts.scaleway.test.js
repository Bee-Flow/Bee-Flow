/**
 * DB-free tests — a Scaleway-served model is billed at Scaleway's tariff.
 *
 * The regression this guards: every model Scaleway serves is open-weight, so
 * the same id is sold by Fireworks, Groq, Cerebras, Together and others at
 * their own prices. getModelPricing's fuzzy "a key that ends with /<id>" match
 * therefore returns *a* price for `gpt-oss-120b` — just not Scaleway's, and
 * whichever host happens to sort first in a 3000-entry table. Cost accounting
 * has to pin the price to the provider that actually served the call.
 *
 * Run: node --test core/modelCosts.scaleway.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { installResolveStub } = require('../../testUtils/stubRequire');

// Stands in for the community pricing data. `getModelPricing` deliberately
// answers with a wildly wrong rate for every id: any test that ends up there
// instead of on the Scaleway path fails loudly rather than by a few cents.
const WRONG_HOST_RATE = { input: 9.99, output: 99.9 };
const SCALEWAY_KEYED = {
    'scaleway/openai/gpt-oss-120b': { input: 0.15, output: 0.60, cacheRead: 0 },
    'scaleway/qwen/qwen3.6-35b-a3b': { input: 0.25, output: 1.50, cacheRead: 0 },
};

const restore = installResolveStub({
    '../../stores/configStore': {
        getConfig: () => null,      // no admin cost overrides
        setConfig: () => {},
    },
    './pricingService': {
        getPricingByKey: (key) => SCALEWAY_KEYED[key] || null,
        getModelPricing: () => WRONG_HOST_RATE,
        initPricing: () => {},
        getAllModelPricing: () => ({ 'expensive-frontier-model': { input: 15, output: 120 } }),
    },
});

const {
    registerScalewayModel,
    _resetScalewayModelRegistry,
} = require('../providers/scalewayModels');
const { getModelCost, computeCost } = require('./modelCosts');

test.after(() => restore());
test.beforeEach(() => _resetScalewayModelRegistry());

test('an unregistered model still takes the community price', () => {
    // Nothing has told us who serves this, so the ordinary lookup stands — the
    // Scaleway path must not hijack ids just because the catalog knows them.
    assert.deepStrictEqual(getModelCost('gpt-oss-120b'), WRONG_HOST_RATE);
});

test('a Scaleway-served model is priced from its exact scaleway/ key', () => {
    registerScalewayModel('gpt-oss-120b');
    assert.deepStrictEqual(getModelCost('gpt-oss-120b'), { input: 0.15, output: 0.60, cacheRead: 0 });

    registerScalewayModel('qwen3.6-35b-a3b');
    assert.deepStrictEqual(getModelCost('qwen3.6-35b-a3b'), { input: 0.25, output: 1.50, cacheRead: 0 });
});

test('falls back to the published list price for a model the database lacks', () => {
    // glm-5.2 has no scaleway/ key yet — new preview models reach the console
    // before the community data. The catalog's list price covers the gap
    // instead of letting another host's rate through.
    registerScalewayModel('glm-5.2');
    assert.deepStrictEqual(getModelCost('glm-5.2'), { input: 1.80, output: 5.50, cacheRead: 0 });
});

test('an id outside the catalog falls through to the ordinary lookup', () => {
    // A model Scaleway adds after this catalog was written has no key to build,
    // so it must not silently become free — it takes the normal path.
    registerScalewayModel('qwen4-500b-a30b');
    assert.deepStrictEqual(getModelCost('qwen4-500b-a30b'), WRONG_HOST_RATE);
});

test('computeCost uses the Scaleway rate end to end', () => {
    registerScalewayModel('gpt-oss-120b');
    // 1M input + 1M output at €0.15 / €0.60.
    assert.strictEqual(computeCost('gpt-oss-120b', 1_000_000, 1_000_000), 0.75);
});

test('cached input is billed at the model’s cached rate', () => {
    // deepseek-v4-flash-0731: €0.40 in, €0.80 out, €0.08 cached in.
    registerScalewayModel('deepseek-v4-flash-0731');
    const cost = computeCost('deepseek-v4-flash-0731', 1_000_000, 0, 750_000);
    // 250k uncached at 0.40 + 750k cached at 0.08
    assert.strictEqual(Number(cost.toFixed(6)), 0.16);
});
