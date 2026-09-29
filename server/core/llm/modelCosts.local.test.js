/**
 * DB-free tests — self-hosted models are billed at €0.
 *
 * The regression this guards: computeCost falls back to UPPER-BOUND rates for
 * any model it doesn't recognise, so a customer running Qwen on their own GPU
 * was charged as if they'd called the most expensive frontier model in the
 * pricing table. Local models must short-circuit before both that fallback and
 * the community pricing lookup — open-weight models have cloud list prices too,
 * and inheriting one would bill somebody's own hardware at Together's rates.
 *
 * Run: node --test core/modelCosts.local.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { installResolveStub } = require('../../testUtils/stubRequire');

// A tiny deterministic pricing table stands in for the community data, so the
// upper-bound fallback has something to compute from without a network fetch.
const PRICING = {
    'deepseek-r1': { input: 0.55, output: 2.19 },
    'expensive-frontier-model': { input: 15, output: 120 },
};

const restore = installResolveStub({
    '../../stores/configStore': {
        getConfig: () => null,      // no admin cost overrides
        setConfig: () => {},
    },
    './pricingService': {
        getModelPricing: (name) => PRICING[name] || null,
        initPricing: () => {},
        getAllModelPricing: () => PRICING,   // feeds the upper-bound fallback
    },
});

const { registerLocalModel, _resetLocalModelRegistry } = require('../providers/localModels');
const { getModelCost, computeCost, computeCostSplit } = require('./modelCosts');

test.after(() => restore());
test.beforeEach(() => _resetLocalModelRegistry());

test('a registered self-hosted model costs nothing', () => {
    registerLocalModel('qwen3:30b-a3b');
    assert.deepStrictEqual(getModelCost('qwen3:30b-a3b'), { input: 0, output: 0, cacheRead: 0 });
    assert.strictEqual(computeCost('qwen3:30b-a3b', 1_000_000, 500_000), 0);
    assert.deepStrictEqual(
        computeCostSplit('qwen3:30b-a3b', 1_000_000, 500_000),
        { input_cost: 0, output_cost: 0 },
    );
});

test('the €0 answer beats the cloud list price for the same open-weight model', () => {
    // Served from a cloud host, deepseek-r1 has a real per-token price…
    assert.deepStrictEqual(getModelCost('deepseek-r1'), { input: 0.55, output: 2.19 });
    // …run on the customer's own GPU, it must not inherit it.
    registerLocalModel('deepseek-r1');
    assert.deepStrictEqual(getModelCost('deepseek-r1'), { input: 0, output: 0, cacheRead: 0 });
    assert.strictEqual(computeCost('deepseek-r1', 1_000_000, 1_000_000), 0);
});

test('an UNregistered model still gets the upper-bound safety net', () => {
    // The protection against silently charging €0 for a real cloud call stays
    // intact — only models we know are self-hosted are free.
    assert.strictEqual(getModelCost('some-brand-new-frontier-model'), null);
    assert.ok(
        computeCost('some-brand-new-frontier-model', 1_000_000, 1_000_000) > 0,
        'unknown models are still billed at the upper bound',
    );
});

test('cache-aware billing stays at zero for local models', () => {
    registerLocalModel('gpt-oss:120b');
    // promptTokens including the cached-read and cache-write pieces, on the
    // 1h-TTL write premium path.
    assert.strictEqual(computeCost('gpt-oss:120b', 100_000, 20_000, 50_000, 10_000, '1h'), 0);
});
