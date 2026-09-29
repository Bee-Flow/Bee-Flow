/**
 * `resolveLayerAgentModel` — de enige andere aanroeper die op de weggehaalde
 * default-fallback van `resolveModelForTierName` leunde.
 *
 * Hij probeert de thinking-tier en valt terug op de fast-tier. Dat zijn allebei
 * INGERICHTE tiers. Vroeger kon de tweede aanroep nooit leeg terugkomen, omdat
 * de resolver zelf een hardgecodeerd `gemini-2.0-flash-lite` invulde — dus liep
 * de flowlet-subagent op een Google-model bij een workspace die geen enkele
 * tier had ingericht. Nu is null een echt antwoord, en de route eromheen
 * (routes/ai/automationBuilder/layerAgent.js) weigert er leesbaar op.
 *
 * Run: cd server && node --test --test-force-exit automation/flowletAgent.modelResolve.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { installResolveStub } = require('../testUtils/stubRequire');

const fx = { byTier: {}, throwOn: new Set(), calls: [] };
const restore = installResolveStub({
    '../core/llm/modelResolver': {
        resolveModelForTierName: async (tierName, opts) => {
            fx.calls.push({ tierName, opts });
            if (fx.throwOn.has(tierName)) throw new Error(`config unreachable for ${tierName}`);
            // Geen impliciete invulling: precies wat er is ingericht, of null.
            return fx.byTier[tierName] || opts?.fallback || null;
        },
    },
});

const { resolveLayerAgentModel } = require('./flowletAgent');

test.after(() => restore());
test.beforeEach(() => {
    fx.byTier = {};
    fx.throwOn = new Set();
    fx.calls = [];
});

test('geen enkele tier ingericht → null, geen stil ingevuld model', async () => {
    const model = await resolveLayerAgentModel({ userOrgId: 'org1', userId: 'u1' });
    assert.strictEqual(model, null);
    assert.deepStrictEqual(fx.calls.map(c => c.tierName), ['thinking', 'fast']);
    for (const call of fx.calls) {
        assert.ok(!call.opts?.fallback, `er werd om fallback ${call.opts?.fallback} gevraagd`);
    }
});

test('de thinking-tier wint als hij is ingericht', async () => {
    fx.byTier.thinking = 'org-thinking';
    fx.byTier.fast = 'org-fast';
    assert.strictEqual(await resolveLayerAgentModel({ userOrgId: 'org1' }), 'org-thinking');
});

test('alleen een fast-tier ingericht → dat gekozen model, niet iets anders', async () => {
    fx.byTier.fast = 'org-fast';
    assert.strictEqual(await resolveLayerAgentModel({ userOrgId: 'org1' }), 'org-fast');
});

test('een onleesbare tier-config eindigt op null, nooit op een verzonnen model', async () => {
    fx.throwOn = new Set(['thinking', 'fast']);
    assert.strictEqual(await resolveLayerAgentModel({ userOrgId: 'org1' }), null);
});

test('thinking onleesbaar maar fast ingericht → de ingerichte fast-tier', async () => {
    fx.throwOn = new Set(['thinking']);
    fx.byTier.fast = 'org-fast';
    assert.strictEqual(await resolveLayerAgentModel({ userOrgId: 'org1' }), 'org-fast');
});
