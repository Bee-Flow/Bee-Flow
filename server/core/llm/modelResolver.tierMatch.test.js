/**
 * Reverse-mapping a model id back to a tier is deterministic.
 *
 * Several tiers pointing at ONE model is the normal case on a self-hosted box
 * with a single good model, and common on cloud setups where Fast and Thinking
 * share a model and differ only in effort. The old `Object.entries(...).find()`
 * let storage order decide: `chat_model_tiers` lives in a Postgres `jsonb`
 * column, whose key order is length-then-bytewise, so `pro` (3 chars) sorted
 * ahead of `fast` and every agent on that model silently inherited Deep
 * Thinking's ceiling and reasoning effort — minutes per turn on a single-slot
 * runtime, configured by nobody.
 *
 * Run: cd server && node --test --test-force-exit core/llm/modelResolver.tierMatch.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { findTierKeyForModel, TIER_MATCH_PRIORITY, TIER_DEFAULTS } = require('./modelResolver');

/** A tier map in the key order Postgres jsonb hands back: length, then bytewise. */
function asJsonbOrder(tiers) {
    const keys = Object.keys(tiers).sort((a, b) => (a.length - b.length) || (a < b ? -1 : 1));
    const out = {};
    for (const k of keys) out[k] = tiers[k];
    return out;
}

const ONE_MODEL = asJsonbOrder({
    fast: { modelId: 'gemma-4-26b-a4b', maxTokens: 2048, reasoningEffort: 'none' },
    standard: { modelId: 'gemma-4-26b-a4b', maxTokens: 4096 },
    swarm: { modelId: 'gemma-4-26b-a4b', maxTokens: 4096 },
    thinking: { modelId: 'gemma-4-26b-a4b', maxTokens: 8192, reasoningEffort: 'medium' },
    writer: { modelId: 'gemma-4-26b-a4b', maxTokens: 8192 },
    pro: { modelId: 'gemma-4-26b-a4b', maxTokens: 12288, reasoningEffort: 'high' },
});

test('the storage order that caused the bug is reproduced by the fixture', () => {
    // Guards the premise: if jsonb ever stopped sorting this way the test below
    // would pass for the wrong reason.
    assert.strictEqual(Object.keys(ONE_MODEL)[0], 'pro');
});

test('all tiers on one model resolves to the cheapest, not to storage order', () => {
    assert.strictEqual(findTierKeyForModel(ONE_MODEL, 'gemma-4-26b-a4b'), 'fast');
});

test('the ladder is ordered cheapest-first by output ceiling', () => {
    const ceilings = TIER_MATCH_PRIORITY.map(k => TIER_DEFAULTS[k].maxTokens);
    const ascending = [...ceilings].sort((a, b) => a - b);
    assert.deepStrictEqual(ceilings, ascending, `ladder out of order: ${TIER_MATCH_PRIORITY.join(' < ')}`);
});

test('a model on exactly one tier resolves to that tier, cheap or not', () => {
    const tiers = asJsonbOrder({
        fast: { modelId: 'lfm2-1.2b-extract' },
        pro: { modelId: 'gemma-4-26b-a4b' },
    });
    assert.strictEqual(findTierKeyForModel(tiers, 'gemma-4-26b-a4b'), 'pro');
    assert.strictEqual(findTierKeyForModel(tiers, 'lfm2-1.2b-extract'), 'fast');
});

test('a model on no tier resolves to null rather than to a default tier', () => {
    assert.strictEqual(findTierKeyForModel(ONE_MODEL, 'some-other-model'), null);
});

test('custom tiers are still found, after the built-in ladder', () => {
    const tiers = {
        'custom:abc': { modelId: 'qwen3.5-9b' },
        fast: { modelId: 'gemma-4-26b-a4b' },
    };
    assert.strictEqual(findTierKeyForModel(tiers, 'qwen3.5-9b'), 'custom:abc');
    // A built-in tier still wins over a custom one on the same model: the
    // ladder runs first.
    const shared = { 'custom:abc': { modelId: 'gemma-4-26b-a4b' }, thinking: { modelId: 'gemma-4-26b-a4b' } };
    assert.strictEqual(findTierKeyForModel(shared, 'gemma-4-26b-a4b'), 'thinking');
});

test('missing or malformed input never throws', () => {
    assert.strictEqual(findTierKeyForModel(null, 'x'), null);
    assert.strictEqual(findTierKeyForModel({}, 'x'), null);
    assert.strictEqual(findTierKeyForModel(ONE_MODEL, null), null);
    assert.strictEqual(findTierKeyForModel({ fast: null, pro: undefined }, 'x'), null);
});
