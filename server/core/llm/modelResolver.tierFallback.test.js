/**
 * `resolveModelForTierName` — wie vult er een model in als niemand er een koos?
 *
 * Deze helper had een DEFAULT-parameter `fallback = 'gemini-2.0-flash-lite'` en
 * gaf `resolved || fallback` terug. Daardoor kon hij nooit iets falsy geven, en
 * kon geen enkele aanroeper nog vragen "is er eigenlijk wel een model
 * ingericht?" — die poort was onbereikbaar. Een organisatie die dat Google-model
 * nooit koos liet er stilzwijgend tekst doorheen lopen, buiten de EU-overrides
 * en de eigen tierkeuze om.
 *
 * De regel die deze tests vastzetten: NIETS ingericht en NIETS gevraagd = null.
 * Een fallback is opt-in — wie er een wil, noemt hem. Een aanroeper die geen
 * fallback noemt hoort een leesbare weigering te geven, niet een model dat hij
 * zelf niet koos.
 *
 * Run: cd server && node --test --test-force-exit core/llm/modelResolver.tierFallback.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { installResolveStub } = require('../../testUtils/stubRequire');

const fixtures = { map: {}, throwOn: null };
const restore = installResolveStub({
    '../../stores/configStore': {
        getConfig: async (key) => {
            if (fixtures.throwOn && key === fixtures.throwOn) throw new Error('cfg boom');
            return Object.prototype.hasOwnProperty.call(fixtures.map, key) ? fixtures.map[key] : null;
        },
    },
});

const { resolveModelForTierName } = require('./modelResolver');

test.after(() => restore());
test.beforeEach(() => {
    fixtures.map = {};
    fixtures.throwOn = null;
});

test('geen tier ingericht en geen fallback gevraagd → null, geen ingevuld model', async () => {
    const model = await resolveModelForTierName('fast', { userOrgId: 'org1', userId: 'u1' });
    assert.strictEqual(model, null,
        'zonder configuratie hoort er NIETS terug te komen, zodat de aanroeper kan weigeren');
});

test('de weggehaalde default duikt nergens meer op als stil ingevuld model', async () => {
    // Het hardgecodeerde Google-model was de default-parameter. Als het ooit
    // terugkeert, faalt deze test op elk van de vier vormen tegelijk.
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
    fixtures.map['chat_model_tiers'] = { fast: { modelId: 'org-chosen-fast' } };
    const model = await resolveModelForTierName('fast', { userOrgId: 'org1', userId: 'u1' });
    assert.strictEqual(model, 'org-chosen-fast');
});

test('een expliciete fallback verdringt het gekozen model niet', async () => {
    fixtures.map['chat_model_tiers'] = { fast: { modelId: 'org-chosen-fast' } };
    const model = await resolveModelForTierName('fast', { fallback: 'never-used' });
    assert.strictEqual(model, 'org-chosen-fast');
});

test('een tier zonder eigen model valt op de fast-tier terug, niet op een hardgecodeerd model', async () => {
    fixtures.map['chat_model_tiers'] = { fast: { modelId: 'org-chosen-fast' } };
    const model = await resolveModelForTierName('thinking', { userOrgId: 'org1' });
    assert.strictEqual(model, 'org-chosen-fast', 'de fast-tier is de ingerichte terugval');

    // ... maar zonder fast-tier is er niets, en dan is null het antwoord.
    fixtures.map['chat_model_tiers'] = { writer: { modelId: 'org-writer' } };
    assert.strictEqual(await resolveModelForTierName('thinking', { userOrgId: 'org1' }), null);
});

test('een lege tier-map is "niets ingericht", niet "pak maar iets"', async () => {
    fixtures.map['chat_model_tiers'] = {};
    assert.strictEqual(await resolveModelForTierName('fast', { userOrgId: 'org1' }), null);
});

test('EU-mode ruilt het model, maar verzint er geen als er geen is', async () => {
    fixtures.map['org_privacy_shield_org1'] = { enabled: true, euModeEnabled: true };
    fixtures.map['chat_model_tiers_eu'] = { fast: { modelId: 'eu-fast' } };
    fixtures.map['chat_model_tiers'] = { fast: { modelId: 'global-fast' } };
    assert.strictEqual(await resolveModelForTierName('fast', { userOrgId: 'org1' }), 'eu-fast');

    fixtures.map['chat_model_tiers_eu'] = {};
    fixtures.map['chat_model_tiers'] = {};
    assert.strictEqual(await resolveModelForTierName('fast', { userOrgId: 'org1' }), null);
});
