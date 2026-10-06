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

test('the "Continues on" table speaks Dutch: its columns, list buttons, trail and run sentence', () => {
    const KEYS = [
        'col_result', 'col_problem', 'open_rows', 'open_row_one', 'show_all_rows', 'show_all_columns',
        'trail', 'crumb_row', 'each_all_worked', 'each_one_worked', 'each_some_failed', 'each_capped',
    ].map(k => `automations.output.${k}`);
    const missing = KEYS.filter(k => !String(NL_TRANSLATIONS[k] || '').trim());
    assert.deepStrictEqual(missing, [], `no Dutch for: ${missing.join(', ')}`);
    for (const k of KEYS) assert.ok(k in GUI_DEFAULTS, `${k} is not in the English catalog`);
});
