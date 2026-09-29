/**
 * Admin cost overrides (core/llm/modelCosts.js) — are they applied, and does a
 * save keep the others?
 *
 * Neither was true. getCustomOverrides() called the async configStore.getConfig
 * as if it were synchronous, JSON-parsed the Promise, threw, and returned {} —
 * so no override was ever applied — and setModelCost started from that {} and
 * wrote only its own model, wiping every other override on each save. Found by
 * validation batch 2a while it converted routes/ai/config/modelCosts.js.
 *
 * Run: cd server && node --test core/llm/modelCosts.overrides.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { installResolveStub } = require('../../testUtils/stubRequire');

// An async store like the real one: getConfig resolves, mutateConfig applies
// the mutator to the stored value and resolves with the result.
const store = { value: null, failRead: false, reads: 0 };
installResolveStub({
    '../../stores/configStore': {
        getConfig: async () => {
            store.reads += 1;
            if (store.failRead) throw new Error('db down');
            return store.value;
        },
        mutateConfig: async (_key, mutator) => { store.value = mutator(store.value); return store.value; },
        setConfig: async () => { throw new Error('writes go through mutateConfig'); },
    },
    './pricingService': {
        getModelPricing: (name) => (name === 'listed-model' ? { input: 3, output: 15 } : null),
        getPricingByKey: () => null,
        initPricing: () => { },
        getAllModelPricing: () => ({ 'listed-model': { input: 3, output: 15 } }),
    },
});

const costs = require('./modelCosts');

test.beforeEach(() => { store.value = null; store.failRead = false; });

test('a stored override is what a lookup returns', async () => {
    store.value = { 'listed-model': { input: 1, output: 2 } };
    await costs.refreshCustomOverrides();
    assert.deepStrictEqual(costs.getModelCost('listed-model'), { input: 1, output: 2 });
});

test('a row the old code wrote as JSON text is read too', async () => {
    store.value = JSON.stringify({ 'listed-model': { input: 4, output: 5 } });
    await costs.refreshCustomOverrides();
    assert.deepStrictEqual(costs.getModelCost('listed-model'), { input: 4, output: 5 });
});

test('saving one override keeps the others', async () => {
    store.value = { 'model-a': { input: 1, output: 1 } };
    await costs.setModelCost('model-b', 2, 3);
    assert.deepStrictEqual(store.value, {
        'model-a': { input: 1, output: 1 },
        'model-b': { input: 2, output: 3 },
    });
    assert.deepStrictEqual(costs.getModelCost('model-b'), { input: 2, output: 3 }, 'the snapshot follows the write');
});

test('saves made in a loop without awaiting are all kept, in order', async () => {
    // routes/ai/config/modelCosts.js applies a list of changes this way.
    costs.setModelCost('m1', 1, 1);
    costs.setModelCost('m2', 2, 2);
    costs.resetModelCost('m1');
    await costs.setModelCost('m3', 3, 3);
    assert.deepStrictEqual(Object.keys(store.value).sort(), ['m2', 'm3']);
});

test('a reset removes only its own model', async () => {
    store.value = { keep: { input: 1, output: 1 }, drop: { input: 2, output: 2 } };
    await costs.resetModelCost('drop');
    assert.deepStrictEqual(store.value, { keep: { input: 1, output: 1 } });
});

test('a failed read keeps the last good overrides instead of dropping them all', async () => {
    store.value = { 'listed-model': { input: 1, output: 2 } };
    await costs.refreshCustomOverrides();
    store.failRead = true;
    await costs.refreshCustomOverrides();
    assert.deepStrictEqual(costs.getModelCost('listed-model'), { input: 1, output: 2 });
});
