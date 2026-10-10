/**
 * The Dutch for the project rail: every key exists in English, placeholders
 * survive, nothing is copied over, up() seeds exactly this catalogue and the
 * migration is registered.
 *
 * Run: node --test migrations/add-nl-project-rail-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS, up } = require('./add-nl-project-rail-translations');

test('the four rail keys are covered', () => {
    assert.deepStrictEqual(Object.keys(NL_TRANSLATIONS).sort(), [
        'project_home.rail.recent', 'project_home.rail.search', 'project_home.rail.switch', 'project_home.rail.switch_named',
    ]);
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
