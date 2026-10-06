/**
 * The Dutch catalogue for the nested-data mapping work. The coverage direction
 * for all of `automations.builder.*` lives in
 * add-nl-builder-values-translations.test.js; this file checks the catalogue
 * itself.
 *
 * Run: node --test migrations/add-nl-builder-mapping-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS, SAME_IN_DUTCH } = require('./add-nl-builder-mapping-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

test('every Dutch key exists in the English catalog', () => {
    const orphans = Object.keys(NL_TRANSLATIONS).filter(k => !(k in GUI_DEFAULTS));
    assert.deepStrictEqual(orphans, []);
});

test('no Dutch value is blank or the English one copied over', () => {
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.ok(String(v || '').trim(), `${k} has no Dutch value`);
        if (!SAME_IN_DUTCH.has(k)) assert.notStrictEqual(v, GUI_DEFAULTS[k], `${k} was never actually translated`);
    }
});

test('placeholders survive translation', () => {
    const holes = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.deepStrictEqual(holes(v), holes(GUI_DEFAULTS[k]), `${k}: placeholders differ from English`);
    }
});

test('the vocabulary never says string, array or object', () => {
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.doesNotMatch(v, /\b(string|array|object|boolean)\b/i, `${k} leaks a technical type word`);
    }
});

test('the words the product shares between the two languages really are the English ones', () => {
    for (const k of SAME_IN_DUTCH) assert.strictEqual(NL_TRANSLATIONS[k], GUI_DEFAULTS[k], k);
});
