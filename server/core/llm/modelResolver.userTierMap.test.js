/**
 * getUserTierMap adds an organisation's custom tiers to the tier map it
 * returns. The base map comes from the config store, which hands every caller
 * the SAME cached object: the custom tiers must not be written onto it, or one
 * organisation's tiers appear in everybody's map.
 *
 * Run: cd server && node --test core/llm/modelResolver.userTierMap.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const configStore = require('../../stores/configStore');
const { getUserTierMap, getEUAwareTiers } = require('./modelResolver');

function stubConfig(t) {
    // One object per key, returned by reference on every read: the store's cache.
    const cache = {
        chat_model_tiers: { fast: { modelId: 'm-fast' }, thinking: { modelId: 'm-think' } },
        custom_chat_model_tiers: [{ id: 'custom:global', modelId: 'm-global', label: 'Global' }],
        custom_chat_model_tiers_org_orgA: [{ id: 'custom:secret-a', modelId: 'm-a', label: 'Org A only' }],
    };
    t.mock.method(configStore, 'getConfig', async (key) => (Object.hasOwn(cache, key) ? cache[key] : null));
    return cache;
}

test('an organisation sees its own custom tiers and the global ones', async (t) => {
    stubConfig(t);
    const tiers = await getUserTierMap({ userOrgId: 'orgA', userId: 'u1' });
    assert.strictEqual(tiers['custom:secret-a'].modelId, 'm-a');
    assert.strictEqual(tiers['custom:global'].modelId, 'm-global');
    assert.strictEqual(tiers.fast.modelId, 'm-fast');
});

test('one organisation\'s custom tiers do not leak into the shared tier config or another organisation\'s map', async (t) => {
    const cache = stubConfig(t);
    await getUserTierMap({ userOrgId: 'orgA', userId: 'u1' });

    assert.deepStrictEqual(Object.keys(cache.chat_model_tiers), ['fast', 'thinking'], 'the cached config object is untouched');
    const forB = await getUserTierMap({ userOrgId: 'orgB', userId: 'u2' });
    assert.strictEqual(forB['custom:secret-a'], undefined, 'org B does not get org A\'s tier');
    assert.strictEqual(forB['custom:global'].modelId, 'm-global');
    const plain = await getEUAwareTiers({ userOrgId: 'orgB', userId: 'u2' });
    assert.deepStrictEqual(Object.keys(plain), ['fast', 'thinking']);
});
