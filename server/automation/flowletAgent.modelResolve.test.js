// @typecheck
/**
 * `resolveLayerAgentModel` — the only other caller that leaned on the removed default fallback of
 * `resolveModelForTierName`.
 *
 * It tries the thinking tier and falls back to the fast tier. Both are PROVISIONED tiers. Formerly the
 * second call could never come back empty, because the resolver itself filled in a hard-coded
 * `gemini-2.0-flash-lite` — so the flowlet subagent ran on a Google model in a workspace that had no tier
 * provisioned at all. Now null is a real answer, and the route around it
 * (routes/ai/automationBuilder/layerAgent.js) refuses legibly on it.
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
