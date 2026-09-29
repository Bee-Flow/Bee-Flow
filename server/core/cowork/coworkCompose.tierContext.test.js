/**
 * De composer schrijft de opdracht UIT DE WOORDEN VAN DE GEBRUIKER — dus ook
 * hij lost zijn model op onder de org van die gebruiker (EU-overrides en
 * org-tiers meegerekend), niet onder de globale kaart. De route levert
 * {userId, userOrgId}; dit bewijst dat compose ze werkelijk doorgeeft, en
 * dat een mislukte resolutie nog steeds netjes in de fallback-spec eindigt.
 *
 * Run: node --test --test-force-exit core/cowork/coworkCompose.tierContext.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');

let captured = null;

const restore = installResolveStub({
    '../llm/modelResolver': {
        resolveModelForTier: async (raw, opts) => { captured = { raw, opts }; return null; },
        TIER_DEFAULTS: { fast: {} },
    },
    '../aiAgent': { getProviderForModel: async () => ({}) },
    '../providers/index': { getAdapter: () => null },
});

const { composeCowork } = require('./coworkCompose');

test('compose geeft de identiteit door aan de tier-resolutie', async () => {
    const spec = await composeCowork({
        brief: 'Wens me elke ochtend een goede morgen.',
        userId: 'u1',
        userOrgId: 'org-eu',
    });
    assert.ok(captured, 'resolveModelForTier hoort aangeroepen te zijn');
    assert.strictEqual(captured.raw, 'tier:fast');
    assert.strictEqual(captured.opts?.userOrgId, 'org-eu');
    assert.strictEqual(captured.opts?.userId, 'u1');
    // Resolutie leverde null → compose valt terug, hij faalt niet.
    assert.ok(spec && typeof spec.title === 'string' && spec.title.length > 0);
});

test.after(() => restore());
