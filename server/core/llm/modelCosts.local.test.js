/**
 * DB-free tests — self-hosted models are billed at €0.
 *
 * The regression this guards: an unknown model used to fall back to UPPER-BOUND
 * rates (the dearest model of all), so a customer running Qwen on their own GPU
 * was charged as if they'd called the most expensive frontier model in the
 * pricing table. Local models must short-circuit before both the unknown-model
 * path (estimate + registry) and the community pricing lookup — open-weight
 * models have cloud list prices too, and inheriting one would bill somebody's own
 * hardware at Together's rates.
 *
 * Run: node --test core/modelCosts.local.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { installResolveStub } = require('../../testUtils/stubRequire');

// A tiny deterministic pricing table stands in for the community data, without a
// network fetch. (It has no family for the models below, on purpose.)
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
        getAllModelPricing: () => PRICING,
    },
});

const { registerLocalModel, _resetLocalModelRegistry } = require('../providers/localModels');
const { getModelCost, computeCost, computeCostSplit, rateUsage, listUnknownModels, resetUnknownModels } = require('./modelCosts');

test.after(() => restore());
test.beforeEach(() => { _resetLocalModelRegistry(); resetUnknownModels(); });

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

test('an UNregistered model is no longer billed at the dearest model of all', () => {
    // WAS: "unregistered models take the upper bound" — computeCost(unknown) was
    // 15 + 120 here, the max over every known model, and the same rule produced
    // $3,200/$9,710 per 1M on the real community data. That is gone. With nothing to
    // borrow from (no same-family model, no provider to take a quartile of) no number
    // is invented: the row is rated 0 and flagged 'unknown', and the registry says so.
    // The estimates that DO exist are covered in modelCosts.unknown.test.js.
    assert.strictEqual(getModelCost('some-brand-new-frontier-model'), null);
    const r = rateUsage({ model: 'some-brand-new-frontier-model', prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
    assert.strictEqual(r.cost_basis, 'unknown');
    assert.strictEqual(r.source, 'none');
    assert.ok(r.notes.includes('unknown_model') && r.notes.includes('no_price_data'));
    assert.strictEqual(r.cost, 0);
    assert.strictEqual(computeCost('some-brand-new-frontier-model', 1_000_000, 1_000_000), 0);
    const seen = listUnknownModels();
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].model, 'some-brand-new-frontier-model');
});

test('a self-hosted model never reaches the unknown-model path', () => {
    // Open-weight id that no price source knows: the unknown path would flag it.
    registerLocalModel('my-own-llama-9:70b');
    const r = rateUsage({ model: 'my-own-llama-9:70b', prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
    assert.strictEqual(r.cost_basis, 'local');
    assert.strictEqual(r.cost, 0);
    assert.strictEqual(r.source, 'local');
    assert.ok(!r.notes.includes('unknown_model'));
    assert.deepStrictEqual(listUnknownModels(), [], 'not in the unknown-model registry');
    // ...also with a provider hint that would otherwise invite an estimate.
    const hinted = rateUsage({ model: 'my-own-llama-9:70b', provider_type: 'openai', prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
    assert.strictEqual(hinted.cost_basis, 'local');
    assert.deepStrictEqual(listUnknownModels(), []);
});

test('cache-aware billing stays at zero for local models', () => {
    registerLocalModel('gpt-oss:120b');
    // promptTokens including the cached-read and cache-write pieces, on the
    // 1h-TTL write premium path.
    assert.strictEqual(computeCost('gpt-oss:120b', 100_000, 20_000, 50_000, 10_000, '1h'), 0);
});
