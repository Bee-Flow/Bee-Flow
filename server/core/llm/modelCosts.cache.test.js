/**
 * DB-free tests — prompt-cache pricing per provider token-accounting contract.
 *
 * The regression this guards: computeCost used to do
 * `promptTokens - cachedTokens - cacheCreationTokens` for EVERY provider. That
 * is right for OpenAI/Gemini (prompt_tokens is the full input, cached tokens
 * are a subset) but wrong for Anthropic, whose `usage.input_tokens` is already
 * the uncached remainder — core/providers/claude.js maps it to prompt_tokens
 * verbatim. Subtracting again clamped the uncached input to 0 on every cache
 * hit, so the full-price part of a cached Claude turn was billed at nothing:
 * ai_usage_log.estimated_cost/billed_cost, the PAYG meter events derived from
 * them, and the org cost caps in core/limits.js were all under-counted.
 *
 * Run: cd server && node --test core/llm/modelCosts.cache.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { installResolveStub } = require('../../testUtils/stubRequire');

// Deterministic stand-in for the community pricing data — no network fetch.
// Rates are USD per 1M tokens.
const PRICING = {
    'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3 },
    'gpt-4o': { input: 2.5, output: 10, cacheRead: 1.25 },
};

const restore = installResolveStub({
    '../../stores/configStore': { getConfig: () => null, setConfig: () => { } },
    './pricingService': {
        getModelPricing: (name) => PRICING[name] || null,
        getPricingByKey: () => null,
        initPricing: () => { },
        getAllModelPricing: () => PRICING,
    },
});

const { computeCost, computeCostSplit, getCacheDiscount } = require('./modelCosts');

test.after(() => restore());

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg} — got ${a}, expected ${b}`);
const round = (n) => Math.round(n * 10000) / 10000;

test('Anthropic cache HIT still bills the uncached input at full price', () => {
    // Anthropic shape: input_tokens = 2000 (uncached only), cache_read = 30000.
    const cost = computeCost('claude-sonnet-4-5', 2000, 500, 30000, 0, '5m');
    const expected = (2000 / 1e6) * 3      // uncached input at full rate
        + (30000 / 1e6) * 0.3              // cache reads at the cached rate
        + (500 / 1e6) * 15;                // output
    near(cost, expected, 'cached Claude turn');
    // And specifically: the uncached component is NOT dropped.
    assert.ok(cost > computeCost('claude-sonnet-4-5', 0, 500, 30000, 0, '5m'),
        'a turn with uncached input must cost more than the same turn without it');
});

test('Anthropic cache WRITE bills uncached input on top of the write premium', () => {
    const cost = computeCost('claude-sonnet-4-5', 2000, 500, 0, 30000, '5m');
    const expected = (2000 / 1e6) * 3
        + (30000 / 1e6) * 3 * 1.25         // 5m write premium
        + (500 / 1e6) * 15;
    near(cost, expected, 'cache-write Claude turn');
});

test('computeCostSplit reports the same uncached input in input_cost', () => {
    const split = computeCostSplit('claude-sonnet-4-5', 2000, 500, 30000, 0, '5m');
    near(split.input_cost, (2000 / 1e6) * 3 + (30000 / 1e6) * 0.3, 'split input_cost');
    near(split.output_cost, (500 / 1e6) * 15, 'split output_cost');
});

test('OpenAI keeps the subtracting contract — cached tokens are inside prompt_tokens', () => {
    // 32000 prompt_tokens of which 30000 were cached ⇒ 2000 uncached.
    const cost = computeCost('gpt-4o', 32000, 500, 30000, 0, null);
    const expected = (2000 / 1e6) * 2.5 + (30000 / 1e6) * 1.25 + (500 / 1e6) * 10;
    near(cost, expected, 'cached OpenAI turn');
});

test('a nonsensical OpenAI report (cached > prompt) never yields a negative input cost', () => {
    const cost = computeCost('gpt-4o', 1000, 0, 30000, 0, null);
    near(cost, (30000 / 1e6) * 1.25, 'clamped to the cache-read component only');
});

test('an uncached Claude turn is unaffected', () => {
    near(computeCost('claude-sonnet-4-5', 2000, 500), (2000 / 1e6) * 3 + (500 / 1e6) * 15,
        'no-cache Claude turn');
});

test('the OpenAI cached-read discount follows the model, not one flat rate', () => {
    // It used to be a flat 0.5 for everything matching /gpt|o\d/, which
    // over-charged every GPT-5-era cache hit by 5x whenever the pricing
    // database had no explicit cache_read rate for the model.
    assert.strictEqual(round(getCacheDiscount('gpt-6-astra')), 0.1);
    assert.strictEqual(round(getCacheDiscount('gpt-5.6-luna')), 0.1);
    assert.strictEqual(round(getCacheDiscount('gpt-5.2')), 0.1);
    // The o-series publishes its own, higher, rates per model.
    assert.strictEqual(round(getCacheDiscount('o3')), 0.25);
    assert.strictEqual(round(getCacheDiscount('o3-mini')), 0.5);
    assert.strictEqual(round(getCacheDiscount('o4-mini')), 0.25);
    // The GPT-4 era really was 50% — that part of the old heuristic was right.
    assert.strictEqual(round(getCacheDiscount('gpt-4o')), 0.5);
    assert.strictEqual(round(getCacheDiscount('gpt-4.1')), 0.5);
    // An id from a generation we have never seen follows its family, not gpt-4.
    assert.strictEqual(round(getCacheDiscount('gpt-7-nova')), 0.1);
});

test('non-OpenAI providers are untouched by the OpenAI split', () => {
    assert.strictEqual(round(getCacheDiscount('claude-opus-5')), 0.1);
    assert.strictEqual(round(getCacheDiscount('gemini-3-pro')), 0.1);
    // Mistral bills cached input at 10% of the input price on every current
    // model (docs.mistral.ai/studio/conversations/advanced/prompt-caching).
    assert.strictEqual(round(getCacheDiscount('mistral-large-latest')), 0.1);
    assert.strictEqual(round(getCacheDiscount('ministral-8b-latest')), 0.1);
});

test('EU regional processing adds its 10% uplift to the bill', () => {
    const { registerEuServedModel, _resetEuServedRegistry } = require('../providers/openaiModels');
    try {
        const listRate = computeCost('gpt-4o', 1000, 100, 0, 0, null);
        registerEuServedModel('gpt-4o');
        // gpt-4o predates the uplift cutoff (2026-03-05) — same price in the EU.
        near(computeCost('gpt-4o', 1000, 100, 0, 0, null), listRate, 'pre-cutoff model');

        // A model released after the cutoff does carry it.
        const usRate = computeCost('gpt-5.6-luna', 1000, 100, 0, 0, null);
        registerEuServedModel('gpt-5.6-luna');
        near(computeCost('gpt-5.6-luna', 1000, 100, 0, 0, null), usRate * 1.1, 'post-cutoff model');

        // And the split must keep summing to the total.
        const split = computeCostSplit('gpt-5.6-luna', 1000, 100, 0, 0, null);
        near(split.input_cost + split.output_cost, usRate * 1.1, 'split sums to the uplifted total');
    } finally {
        _resetEuServedRegistry();
    }
});

test('a model served from the default endpoint is never uplifted', () => {
    const { _resetEuServedRegistry } = require('../providers/openaiModels');
    _resetEuServedRegistry();
    const { getRegionalUplift } = require('./modelCosts');
    assert.strictEqual(getRegionalUplift('gpt-5.6-luna'), 1);
    assert.strictEqual(getRegionalUplift('claude-opus-5'), 1);
});

test('a Mistral-served model is billed at Mistral\'s list price, cached input at 10%', () => {
    const { registerMistralModel, _resetMistralRegistries } = require('../providers/mistralModels');
    try {
        registerMistralModel('mistral-small-latest');
        // Small 4: 0.15 in / 0.015 cached / 0.6 out per 1M. 1M prompt tokens of
        // which 800k cached, 100k out.
        const expected = (200_000 / 1e6) * 0.15 + (800_000 / 1e6) * 0.015 + (100_000 / 1e6) * 0.6;
        near(computeCost('mistral-small-latest', 1_000_000, 100_000, 800_000, 0, null), expected, 'Small 4 with a cache hit');
    } finally {
        _resetMistralRegistries();
    }
});

test('Mistral\'s regional endpoints add their 10% to the bill, and only while flagged', () => {
    const { registerMistralModel, setMistralRegionalModel, _resetMistralRegistries } = require('../providers/mistralModels');
    const { getRegionalUplift } = require('./modelCosts');
    try {
        registerMistralModel('mistral-large-latest');
        const listRate = computeCost('mistral-large-latest', 1000, 100, 0, 0, null);
        setMistralRegionalModel('mistral-large-latest', true);
        assert.strictEqual(getRegionalUplift('mistral-large-latest'), 1.1);
        near(computeCost('mistral-large-latest', 1000, 100, 0, 0, null), listRate * 1.1, 'regional endpoint');
        setMistralRegionalModel('mistral-large-latest', false);
        near(computeCost('mistral-large-latest', 1000, 100, 0, 0, null), listRate, 'back on the global endpoint');
    } finally {
        _resetMistralRegistries();
    }
});
