/**
 * DB-free tests for modelResolver.getUserTierMap (H6 adoption lock).
 *
 * directChat's inline tier-merge block was replaced by getUserTierMap — these
 * tests pin the merge contract both relied on: base tiers pass through, org
 * custom tiers beat global ones on id collision, custom:true is stamped, EU
 * mode swaps euModelId, and a configStore failure degrades to base tiers.
 */

const test = require('node:test');
const assert = require('node:assert');

const { installResolveStub } = require('../../testUtils/stubRequire');

const fixtures = { map: {}, throwOn: null, calls: [] };
const restore = installResolveStub({
    '../../stores/configStore': {
        getConfig: async (key) => {
            fixtures.calls.push(key);
            if (fixtures.throwOn && key === fixtures.throwOn) throw new Error('cfg boom');
            return Object.prototype.hasOwnProperty.call(fixtures.map, key) ? fixtures.map[key] : null;
        },
    },
});

const { getUserTierMap, getTierConfig } = require('./modelResolver');

test.after(() => restore());
test.beforeEach(() => {
    fixtures.map = {};
    fixtures.throwOn = null;
    fixtures.calls = [];
});

const BASE = {
    fast: { modelId: 'm-fast', label: 'Fast' },
    smart: { modelId: 'm-smart', euModelId: 'm-smart-eu', label: 'Smart' },
};

test('base tiers pass through when no custom tiers are configured', async () => {
    fixtures.map['chat_model_tiers'] = structuredClone(BASE);
    const tiers = await getUserTierMap({ userOrgId: null, userId: 'u1' });
    assert.strictEqual(tiers.fast.modelId, 'm-fast');
    assert.strictEqual(tiers.smart.modelId, 'm-smart');
    assert.strictEqual('custom:a' in tiers, false);
});

test('org custom tier beats global on id collision; custom:true stamped', async () => {
    fixtures.map['chat_model_tiers'] = structuredClone(BASE);
    fixtures.map['custom_chat_model_tiers'] = [
        { id: 'custom:a', modelId: 'g-a', label: 'Global A', maxTokens: 1000 },
        { id: 'custom:b', modelId: 'g-b', label: 'Global B' },
    ];
    fixtures.map['custom_chat_model_tiers_org_org1'] = [
        { id: 'custom:a', modelId: 'o-a', label: 'Org A', temperature: 0.2 },
    ];
    const tiers = await getUserTierMap({ userOrgId: 'org1', userId: 'u1' });
    assert.strictEqual(tiers['custom:a'].modelId, 'o-a', 'org overrides global on collision');
    assert.strictEqual(tiers['custom:a'].label, 'Org A');
    assert.strictEqual(tiers['custom:a'].custom, true);
    assert.strictEqual(tiers['custom:b'].modelId, 'g-b');
    assert.strictEqual(tiers['custom:b'].custom, true);
    assert.strictEqual(tiers.fast.modelId, 'm-fast', 'base tiers intact');
});

test('EU mode (org shield) swaps euModelId on custom tiers', async () => {
    fixtures.map['chat_model_tiers'] = structuredClone(BASE);
    fixtures.map['org_privacy_shield_org1'] = { enabled: true, euModeEnabled: true };
    fixtures.map['custom_chat_model_tiers'] = [
        { id: 'custom:b', modelId: 'g-b', euModelId: 'g-b-eu' },
        { id: 'custom:c', modelId: 'g-c' }, // no euModelId → keeps modelId
    ];
    const tiers = await getUserTierMap({ userOrgId: 'org1', userId: 'u1' });
    assert.strictEqual(tiers['custom:b'].modelId, 'g-b-eu');
    assert.strictEqual(tiers['custom:c'].modelId, 'g-c');
});

test('no userOrgId → the org-scoped custom-tier key is never fetched', async () => {
    fixtures.map['chat_model_tiers'] = structuredClone(BASE);
    fixtures.map['custom_chat_model_tiers'] = [{ id: 'custom:a', modelId: 'g-a' }];
    await getUserTierMap({ userOrgId: null, userId: 'u1' });
    assert.ok(!fixtures.calls.some(k => k.startsWith('custom_chat_model_tiers_org_')));
});

test('configStore failure inside the merge degrades to base tiers', async () => {
    fixtures.map['chat_model_tiers'] = structuredClone(BASE);
    fixtures.throwOn = 'custom_chat_model_tiers';
    const tiers = await getUserTierMap({ userOrgId: 'org1', userId: 'u1' });
    assert.strictEqual(tiers.fast.modelId, 'm-fast');
    assert.ok(!Object.keys(tiers).some(k => k.startsWith('custom:')));
});

test('non-array custom configs are tolerated', async () => {
    fixtures.map['chat_model_tiers'] = structuredClone(BASE);
    fixtures.map['custom_chat_model_tiers'] = { not: 'an array' };
    fixtures.map['custom_chat_model_tiers_org_org1'] = 'nope';
    const tiers = await getUserTierMap({ userOrgId: 'org1', userId: 'u1' });
    assert.strictEqual(tiers.fast.modelId, 'm-fast');
    assert.ok(!Object.keys(tiers).some(k => k.startsWith('custom:')));
});

// ─── Mistral in the tier system ──────────────────────────────────────────────
// Small 4 / Medium 3.5 reason only when asked, and the switch is none/high.
// What each tier asks for must land on the right side of it — the fast tier
// on `none` (the generic 'medium' default would map to `high`, the slowest
// setting there is), the thinking tiers on a value that maps to `high`.

test('Mistral: the fast tier on a reasoning model asks for none', async () => {
    fixtures.map['chat_model_tiers'] = { fast: { modelId: 'mistral-small-latest' } };
    const cfg = await getTierConfig('fast');
    assert.strictEqual(cfg.reasoningEffort, 'none');
});

test('Mistral: the thinking tiers ask for a value that maps to high', async () => {
    const { normalizeMistralEffort } = require('../providers/mistralModels');
    fixtures.map['chat_model_tiers'] = {
        thinking: { modelId: 'mistral-small-latest' },
        deep_thinking: { modelId: 'mistral-medium-latest' },
        standard: { modelId: 'mistral-small-latest' },
    };
    const thinking = await getTierConfig('thinking');
    const deep = await getTierConfig('deep_thinking');
    const standard = await getTierConfig('standard');
    assert.strictEqual(normalizeMistralEffort(thinking.modelId, thinking.reasoningEffort), 'high');
    assert.strictEqual(normalizeMistralEffort(deep.modelId, deep.reasoningEffort), 'high');
    assert.strictEqual(normalizeMistralEffort(standard.modelId, standard.reasoningEffort), 'none');
});

test('Mistral: an admin-chosen effort is kept, and a model without the switch is left alone', async () => {
    fixtures.map['chat_model_tiers'] = {
        fast: { modelId: 'mistral-small-latest', reasoningEffort: 'high' },
        standard: { modelId: 'mistral-large-latest' },
    };
    assert.strictEqual((await getTierConfig('fast')).reasoningEffort, 'high');
    // Large 3 is not a reasoning model: no summary switched on for it.
    assert.notStrictEqual((await getTierConfig('standard')).reasoningSummary, true);
});
