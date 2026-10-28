/**
 * The Dutch for Studio documents inside apps (namespace studio_app_documents).
 * Pins the silent failure modes: an English key without Dutch leaves English
 * on a Dutch screen, a Dutch key without an English one is never read, and a
 * lost placeholder drops the number the sentence is about.
 *
 * Run: node --test migrations/add-nl-app-studio-documents-2026-10-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS, SAME_AS_ENGLISH, applyNl } = require('./add-nl-app-studio-documents-2026-10-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

const placeholders = (/** @type {string} */ s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('every English studio_app_documents key has Dutch with the same placeholders, and every Dutch key an English one', () => {
    const english = Object.keys(GUI_DEFAULTS).filter((k) => k.startsWith('studio_app_documents.'));
    assert.ok(english.length >= 90);
    assert.deepStrictEqual(english.filter((k) => !(k in NL_TRANSLATIONS) && !SAME_AS_ENGLISH.includes(k)), []);
    assert.deepStrictEqual(Object.keys(NL_TRANSLATIONS).filter((k) => !(k in GUI_DEFAULTS)), []);
    for (const [k, nl] of Object.entries(NL_TRANSLATIONS)) {
        assert.deepStrictEqual(placeholders(nl), placeholders(GUI_DEFAULTS[k]), k);
    }
});

test('a blob without the keys gets all of them, own wording is kept, a second run changes nothing', () => {
    const { merged, added } = applyNl({});
    assert.strictEqual(added, Object.keys(NL_TRANSLATIONS).length);
    const own = applyNl({ 'studio_app_documents.before': 'Eerst' });
    assert.strictEqual(own.merged['studio_app_documents.before'], 'Eerst');
    assert.strictEqual(applyNl({ ...merged }).added, 0);
});
