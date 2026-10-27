/**
 * The Dutch for the datatable storage refusals. Pins the silent failure modes:
 * an English datatables.quota_* key without Dutch leaves English on a Dutch
 * screen, a Dutch key without an English one is never read, and a lost
 * placeholder drops the number the sentence is about.
 *
 * Run: node --test migrations/add-nl-datatable-quota-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS, applyNl } = require('./add-nl-datatable-quota-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

const placeholders = (/** @type {string} */ s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('every English datatables.quota_ key has Dutch with the same placeholders, and every Dutch key an English one', () => {
    const english = Object.keys(GUI_DEFAULTS).filter((k) => k.startsWith('datatables.quota_'));
    assert.ok(english.length >= 6);
    assert.deepStrictEqual(english.filter((k) => !(k in NL_TRANSLATIONS)), []);
    assert.deepStrictEqual(Object.keys(NL_TRANSLATIONS).filter((k) => !(k in GUI_DEFAULTS)), []);
    for (const [k, nl] of Object.entries(NL_TRANSLATIONS)) {
        assert.deepStrictEqual(placeholders(nl), placeholders(GUI_DEFAULTS[k]), k);
        assert.match(nl, /beheerder/, `${k} says who can raise the limit`);
    }
});

test('a blob without the keys gets all of them, own wording is kept, a second run changes nothing', () => {
    const { merged, added } = applyNl({});
    assert.strictEqual(added, Object.keys(NL_TRANSLATIONS).length);
    const own = applyNl({ 'datatables.quota_sheet_tabs': 'Eigen woorden' });
    assert.strictEqual(own.merged['datatables.quota_sheet_tabs'], 'Eigen woorden');
    assert.strictEqual(applyNl({ ...merged }).added, 0);
});
