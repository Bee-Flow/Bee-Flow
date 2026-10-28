/**
 * The Dutch for the Nextcloud trigger's colleagues switch (namespace
 * nc_trigger_scope): every English key has Dutch, every Dutch key an English
 * one, and a second run changes nothing.
 *
 * Run: node --test migrations/add-nl-nc-trigger-scope-2026-10-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS, applyNl } = require('./add-nl-nc-trigger-scope-2026-10-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

test('every English nc_trigger_scope key has Dutch, and every Dutch key an English one', () => {
    const english = Object.keys(GUI_DEFAULTS).filter((k) => k.startsWith('nc_trigger_scope.'));
    assert.ok(english.length >= 3);
    assert.deepStrictEqual(english.filter((k) => !(k in NL_TRANSLATIONS)), []);
    assert.deepStrictEqual(Object.keys(NL_TRANSLATIONS).filter((k) => !(k in GUI_DEFAULTS)), []);
});

test('a blob without the keys gets all of them, own wording is kept, a second run changes nothing', () => {
    const { merged, added } = applyNl({});
    assert.strictEqual(added, Object.keys(NL_TRANSLATIONS).length);
    const own = applyNl({ 'nc_trigger_scope.label': 'Teamgenoten' });
    assert.strictEqual(own.merged['nc_trigger_scope.label'], 'Teamgenoten');
    assert.strictEqual(applyNl({ ...merged }).added, 0);
});
