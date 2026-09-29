'use strict';

/**
 * Which model serves an App Studio builder turn
 * (routes/ai/appStudioBuilder/modelSelection.js), measured against the tiers
 * this person may use.
 *
 * It resolved `modelTier` against the tier MAP only: an explicit tier the
 * person's groups do not allow was honoured, `auto` ranked every configured
 * model and took the strongest, and the capability floor could bump a small
 * pick up to any tier at all. What this file pins:
 *
 *   - an explicit tier outside the person's list is refused with the 403
 *     the playbook routes give, before any provider is resolved;
 *   - `auto` ranks only the person's own tiers, and the floor only bumps
 *     within them;
 *   - `auto` with none of the configured tiers theirs is the same 403, while
 *     a workspace with nothing configured keeps its global default;
 *   - an explicit custom tier runs on its own model (the map is the person's
 *     whole map, custom tiers included), and one with no model is
 *     unavailable rather than the global default; auto still never picks one;
 *   - a continuation turn reuses its tier only while the person may still
 *     use it;
 *   - the list is the one the builder's dropdown offers (taskType automation),
 *     asked with the caller's session.
 *
 * Run: cd server && node --test routes/ai/appStudioBuilder/modelSelection.test.js
 */

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

const SERVER = path.resolve(__dirname, '..', '..', '..');
function mock(rel, exports) {
    const p = require.resolve(path.join(SERVER, rel));
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

let tiers = {};
// The global and org custom tiers: part of the map a person picks from
// (getUserTierMap), not of the EU-aware base tiers alone (getEUAwareTiers).
let customTiers = {};
let permitted = new Set();
const asked = [];
const providersResolved = [];
mock('core/llm/modelResolver', {
    getEUAwareTiers: async () => JSON.parse(JSON.stringify(tiers)),
    getUserTierMap: async () => JSON.parse(JSON.stringify({ ...tiers, ...customTiers })),
});
mock('core/aiAgent', {
    getProviderForModel: async (modelId) => { providersResolved.push(modelId); return { providerType: 'claude', url: '', apiKey: 'k' }; },
    getAIConfig: async () => ({ model: 'global-default-model' }),
});
mock('core/entitlements/userTiers', {
    getPermittedTierKeys: async (args) => { asked.push(args); return permitted; },
});

const { resolveBuilderModel } = require('./modelSelection');

// Newest generation ranks first (appStudio/builderModelProfiles): the Flow
// tier's model is the strongest here, then pro, then thinking; fast is small.
const CONFIGURED = {
    fast: { modelId: 'claude-haiku-4-5' },
    thinking: { modelId: 'claude-sonnet-4-6' },
    pro: { modelId: 'claude-opus-4-8' },
    standard: { modelId: 'claude-sonnet-5' },
};
const SESSION = { user: { id: 'me', organizationId: 'orgA' } };
const pick = (over = {}) => resolveBuilderModel({ userOrgForTiers: 'orgA', userId: 'me', session: SESSION, ...over });

test.beforeEach(() => {
    tiers = CONFIGURED;
    customTiers = {};
    permitted = new Set(['auto', 'fast', 'thinking']);
    asked.length = 0;
    providersResolved.length = 0;
});

test('an explicit tier the person may not use is refused by name, and no provider is resolved', async () => {
    const out = await pick({ modelTier: 'pro' });
    assert.deepStrictEqual(out, { error: 'Tier "pro" is not available on your account.', code: 'tier_not_permitted', status: 403 });
    assert.deepStrictEqual(providersResolved, []);
});

test('an explicit tier they may use is honoured, deep_thinking measured as pro', async () => {
    const out = await pick({ modelTier: 'thinking' });
    assert.strictEqual(out.resolvedTier, 'thinking');
    assert.strictEqual(out.modelId, 'claude-sonnet-4-6');
    permitted = new Set(['fast', 'pro']);
    tiers = { ...CONFIGURED, deep_thinking: { modelId: 'claude-opus-4-8' } };
    assert.strictEqual((await pick({ modelTier: 'deep_thinking' })).resolvedTier, 'deep_thinking');
});

test('auto ranks only the person\'s own tiers', async () => {
    const out = await pick({ modelTier: 'auto' });
    assert.strictEqual(out.resolvedTier, 'thinking', 'not standard (sonnet-5) or pro (opus), which are configured but not theirs');
    assert.strictEqual(out.modelId, 'claude-sonnet-4-6');
    assert.strictEqual((await pick({})).resolvedTier, 'thinking', 'no modelTier is auto');
});

test('the capability floor bumps a small auto pick only within the person\'s tiers', async () => {
    permitted = new Set(['fast']);
    const out = await pick({ modelTier: 'auto' });
    assert.strictEqual(out.resolvedTier, 'fast', 'thinking and standard are not theirs to be floored onto');
    assert.strictEqual(out.modelId, 'claude-haiku-4-5');
});

test('auto with none of the configured tiers theirs is the same 403', async () => {
    permitted = new Set(['writer']);
    const out = await pick({ modelTier: 'auto' });
    assert.deepStrictEqual(out, { error: 'Tier "auto" is not available on your account.', code: 'tier_not_permitted', status: 403 });
    assert.deepStrictEqual(providersResolved, []);
});

test('a workspace with nothing configured keeps its global default — a configuration question, not a permission one', async () => {
    tiers = {};
    const out = await pick({ modelTier: 'auto' });
    assert.strictEqual(out.modelId, 'global-default-model');
});

test('a continuation reuses its tier only while the person may still use it', async () => {
    const snapshot = (lastTier) => ({ continueToken: 'cont_1', lastTier });
    const kept = await pick({ continueToken: 'cont_1', priorSnapshot: snapshot('thinking') });
    assert.strictEqual(kept.resolvedTier, 'thinking');
    const revoked = await pick({ continueToken: 'cont_1', priorSnapshot: snapshot('pro') });
    assert.strictEqual(revoked.resolvedTier, 'thinking', 'pro was taken away since the token was minted: auto chooses again, within the list');
    assert.strictEqual(revoked.modelId, 'claude-sonnet-4-6');
});

// The builder's dropdown offers custom tiers (tiers-for-user includes them),
// but the map resolved here was the EU-aware BASE tiers alone. Somebody
// limited to an on-prem custom tier passed the gate, found no model under its
// name, and ran on the workspace's global default -- possibly a cloud model.
test('an explicit custom tier runs on its own model, never on the global default', async () => {
    permitted = new Set(['custom:onprem']);
    customTiers = { 'custom:onprem': { modelId: 'onprem-model', custom: true } };
    const out = await pick({ modelTier: 'custom:onprem' });
    assert.strictEqual(out.resolvedTier, 'custom:onprem');
    assert.strictEqual(out.modelId, 'onprem-model');
    assert.deepStrictEqual(providersResolved, ['onprem-model']);
});

test('a custom tier with no model behind it is unavailable, not quietly the global default', async () => {
    permitted = new Set(['custom:onprem']);
    customTiers = { 'custom:onprem': { modelId: '', custom: true } };
    const out = await pick({ modelTier: 'custom:onprem' });
    assert.strictEqual(out.code, 'model_unavailable', JSON.stringify(out));
    assert.deepStrictEqual(providersResolved, []);
});

test('auto still never lands on a custom tier, now that the map holds them', async () => {
    permitted = new Set(['fast', 'custom:onprem']);
    customTiers = { 'custom:onprem': { modelId: 'claude-opus-4-8', custom: true } };
    const out = await pick({ modelTier: 'auto' });
    assert.strictEqual(out.resolvedTier, 'fast', 'a custom tier is picked by hand, even when it is the strongest');
});

test('the list is the dropdown\'s own: the caller\'s, for automation, with the session', async () => {
    await pick({ modelTier: 'fast' });
    assert.strictEqual(asked.length, 1);
    assert.strictEqual(asked[0].userId, 'me');
    assert.strictEqual(asked[0].taskType, 'automation');
    assert.strictEqual(asked[0].session, SESSION);
});
