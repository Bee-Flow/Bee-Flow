// @typecheck
/**
 * `resolveModelForTierName`: who fills in a model if nobody chose one?
 *
 * This helper had a DEFAULT parameter `fallback = 'gemini-2.0-flash-lite'` and returned
 * `resolved || fallback`. As a result it could never give anything falsy, and no caller could
 * any longer ask "is a model actually configured here?", that gate was unreachable. An organisation
 * that never chose that Google model had text silently run through it, outside the EU overrides
 * and its own tier choice.
 *
 * The rule these tests pin: NOTHING configured and NOTHING requested = null.
 * A fallback is opt-in: whoever wants one names it. A caller that names no fallback should get
 * a readable refusal, not a model that it did not choose itself.
 *
 * Run: cd server && node --test --test-force-exit core/llm/modelResolver.tierFallback.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { useConfigRows } = require('../../testUtils/configRows');

// The real configStore; its table is config.rows.
const config = useConfigRows();

const { resolveModelForTierName } = require('./modelResolver');

test.after(config.restore);
test.beforeEach(config.reset);

test('geen tier ingericht en geen fallback gevraagd → null, geen ingevuld model', async () => {
    const model = await resolveModelForTierName('fast', { userOrgId: 'org1', userId: 'u1' });
    assert.strictEqual(model, null,
        'zonder configuratie hoort er NIETS terug te komen, zodat de aanroeper kan weigeren');
});

test('de weggehaalde default duikt nergens meer op als stil ingevuld model', async () => {
    // The hard-coded Google model was the default parameter. If it ever returns,
    // this test fails on each of the four forms at once.
    for (const opts of [undefined, {}, { userOrgId: 'org1' }, { userId: 'u1' }]) {
        const model = await resolveModelForTierName('fast', opts);
        assert.strictEqual(model, null, `opts=${JSON.stringify(opts)} vulde stilletjes ${model} in`);
    }
});

test('een expliciet gevraagde fallback werkt nog steeds — opt-in, niet default', async () => {
    const model = await resolveModelForTierName('fast', { fallback: 'mistral-small-latest' });
    assert.strictEqual(model, 'mistral-small-latest');
});

test('met configuratie komt het GEKOZEN model terug, niet iets anders', async () => {
    config.rows['chat_model_tiers'] = { fast: { modelId: 'org-chosen-fast' } };
    const model = await resolveModelForTierName('fast', { userOrgId: 'org1', userId: 'u1' });
    assert.strictEqual(model, 'org-chosen-fast');
});

test('een expliciete fallback verdringt het gekozen model niet', async () => {
    config.rows['chat_model_tiers'] = { fast: { modelId: 'org-chosen-fast' } };
    const model = await resolveModelForTierName('fast', { fallback: 'never-used' });
    assert.strictEqual(model, 'org-chosen-fast');
});

test('een tier zonder eigen model valt op de fast-tier terug, niet op een hardgecodeerd model', async () => {
    config.rows['chat_model_tiers'] = { fast: { modelId: 'org-chosen-fast' } };
    const model = await resolveModelForTierName('thinking', { userOrgId: 'org1' });
    assert.strictEqual(model, 'org-chosen-fast', 'de fast-tier is de ingerichte terugval');

    // ... but without a fast tier there is nothing, and then null is the answer.
    config.rows['chat_model_tiers'] = { writer: { modelId: 'org-writer' } };
    assert.strictEqual(await resolveModelForTierName('thinking', { userOrgId: 'org1' }), null);
});

test('een lege tier-map is "niets ingericht", niet "pak maar iets"', async () => {
    config.rows['chat_model_tiers'] = {};
    assert.strictEqual(await resolveModelForTierName('fast', { userOrgId: 'org1' }), null);
});

test('EU-mode ruilt het model, maar verzint er geen als er geen is', async () => {
    config.rows['org_privacy_shield_org1'] = { enabled: true, euModeEnabled: true };
    config.rows['chat_model_tiers_eu'] = { fast: { modelId: 'eu-fast' } };
    config.rows['chat_model_tiers'] = { fast: { modelId: 'global-fast' } };
    assert.strictEqual(await resolveModelForTierName('fast', { userOrgId: 'org1' }), 'eu-fast');

    config.rows['chat_model_tiers_eu'] = {};
    config.rows['chat_model_tiers'] = {};
    assert.strictEqual(await resolveModelForTierName('fast', { userOrgId: 'org1' }), null);
});
