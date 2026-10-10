/**
 * The Dutch for the project rail: every key exists in English, placeholders
 * survive, nothing is copied over, up() seeds exactly this catalogue and the
 * migration is registered.
 *
 * Run: node --test migrations/add-nl-project-rail-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS, SAME_AS_ENGLISH, up } = require('./add-nl-project-rail-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

const holes = (s) => (String(s).match(/\{[a-z_]+\}/gi) || []).sort();

test('every Dutch key exists in the English catalog', () => {
    const orphans = [...Object.keys(NL_TRANSLATIONS), ...SAME_AS_ENGLISH].filter((k) => !(k in GUI_DEFAULTS));
    assert.deepStrictEqual(orphans, []);
});

test('the four rail keys are covered', () => {
    assert.deepStrictEqual(Object.keys(NL_TRANSLATIONS).sort(), [
        'project_home.rail.recent', 'project_home.rail.search', 'project_home.rail.switch', 'project_home.rail.switch_named',
    ]);
});

test('no Dutch value is blank or the English copied over', () => {
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.ok(String(v || '').trim(), `${k} has no Dutch value`);
        assert.notStrictEqual(v, GUI_DEFAULTS[k], `${k}: identical to English`);
    }
});

test('placeholders survive translation exactly', () => {
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.deepStrictEqual(holes(v), holes(GUI_DEFAULTS[k]), `${k}: placeholders differ from English`);
    }
});

test('no dashes are used as punctuation', () => {
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) assert.ok(!/[–—]/.test(v), `${k} (nl) uses a dash`);
});

test('up() seeds exactly this catalogue into the Dutch strings', async () => {
    const calls = [];
    const languageStore = {
        addMissingGUITranslations: async (locale, translations) => {
            calls.push({ locale, translations });
            return { added: 0 };
        },
    };
    assert.deepStrictEqual(await up({ languageStore }), { added: 0 });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].locale, 'nl');
    assert.deepStrictEqual(calls[0].translations, NL_TRANSLATIONS);
});

test('the migration is registered, or it never runs', () => {
    const { NL_TRANSLATIONS: bootList } = require('../boot/bootMigrations');
    assert.ok(bootList.includes('add-nl-project-rail-translations'),
        'add it to the NL_TRANSLATIONS list in boot/bootMigrations.js');
});
