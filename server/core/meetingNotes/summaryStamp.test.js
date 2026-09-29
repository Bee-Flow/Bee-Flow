'use strict';

/**
 * De sjabloonstempel — pure vorm van `summary_template_id` + `_version`.
 *
 * Wat hier vastligt is precies wat het scherm later als waarheid presenteert:
 * welk sjabloon, welke versie, en wanneer we het NIET weten.
 *
 * Run: cd server && node --test --test-force-exit core/meetingNotes/summaryStamp.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
    BUILTIN_STAMP_PREFIX,
    EMPTY_STAMP,
    stampForBuiltin,
    stampForTemplate,
    parseStamp,
} = require('./summaryStamp');

test('een ingebouwd sjabloon krijgt een gemarkeerd id en géén versie', () => {
    assert.deepStrictEqual(stampForBuiltin('standup'), {
        summaryTemplateId: 'builtin:standup',
        summaryTemplateVersion: null,
    });
    // Ingebouwde sjablonen leven in code, niet in een tabel: er is geen
    // versie om te tonen, en er wordt er dus ook geen verzonnen.
    assert.strictEqual(stampForBuiltin('general').summaryTemplateVersion, null);
});

test('een onbekende ingebouwde sleutel stempelt general — de prompt die echt gebruikt is', () => {
    // builtinPrompt() valt terug op general; de stempel moet dezelfde val
    // maken, anders noemt de notitie een sjabloon dat hem niet geschreven heeft.
    assert.strictEqual(stampForBuiltin('does-not-exist').summaryTemplateId, 'builtin:general');
    assert.strictEqual(stampForBuiltin(null).summaryTemplateId, 'builtin:general');
});

test('een opgeslagen sjabloon draagt zijn id en de versie van dit moment', () => {
    assert.deepStrictEqual(stampForTemplate({ id: 'tpl-9', version: 4 }), {
        summaryTemplateId: 'tpl-9',
        summaryTemplateVersion: 4,
    });
});

test('een sjabloonrij zonder bruikbare versie levert null, geen verzonnen 1', () => {
    for (const version of [undefined, null, 0, -3, 'v4', NaN, 2.5]) {
        const stamp = stampForTemplate({ id: 'tpl-9', version });
        assert.strictEqual(stamp.summaryTemplateId, 'tpl-9', `id blijft bij version=${String(version)}`);
        assert.strictEqual(stamp.summaryTemplateVersion, null, `versie is null bij version=${String(version)}`);
    }
});

test('geen sjabloon = een leeg paar, niet "laat de velden weg"', () => {
    // Dit is de WIS-waarde: een eenmalige prompt moet een oude stempel
    // weghalen, en dat kan alleen als er iets geschreven wordt.
    assert.deepStrictEqual(EMPTY_STAMP, { summaryTemplateId: null, summaryTemplateVersion: null });
    assert.deepStrictEqual(stampForTemplate(null), { summaryTemplateId: null, summaryTemplateVersion: null });
    assert.deepStrictEqual(stampForTemplate({ version: 3 }), { summaryTemplateId: null, summaryTemplateVersion: null });
});

test('EMPTY_STAMP is bevroren en wordt per aanroep gekopieerd', () => {
    assert.ok(Object.isFrozen(EMPTY_STAMP));
    const a = stampForTemplate(null);
    a.summaryTemplateId = 'besmet';
    assert.strictEqual(EMPTY_STAMP.summaryTemplateId, null, 'een caller kan de gedeelde waarde niet vervuilen');
});

test('parseStamp onderscheidt ingebouwd van opgeslagen', () => {
    assert.deepStrictEqual(parseStamp('builtin:sales'), { kind: 'builtin', key: 'sales' });
    assert.deepStrictEqual(parseStamp('7f0e-uuid'), { kind: 'custom', key: '7f0e-uuid' });
    assert.strictEqual(BUILTIN_STAMP_PREFIX, 'builtin:');
});

test('parseStamp geeft null voor niets en voor onleesbaar', () => {
    for (const bad of [null, undefined, '', '   ', 42, {}, [], 'builtin:']) {
        assert.strictEqual(parseStamp(bad), null, `onleesbaar: ${JSON.stringify(bad)}`);
    }
});
