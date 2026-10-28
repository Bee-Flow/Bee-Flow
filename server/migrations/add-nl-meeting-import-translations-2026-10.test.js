/**
 * The Dutch for the meeting import outcome. Pins the silent failure modes: an
 * English key without Dutch leaves English on a Dutch screen, and a Dutch key
 * without an English one is never read.
 *
 * Run: node --test migrations/add-nl-meeting-import-translations-2026-10.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS, applyNl } = require('./add-nl-meeting-import-translations-2026-10');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

test('every English meetings.import_error_ / import_running key has Dutch, and every Dutch key an English one', () => {
    const english = Object.keys(GUI_DEFAULTS).filter((k) => k.startsWith('meetings.import_error_') || k === 'meetings.import_running');
    assert.ok(english.length >= 11);
    assert.deepStrictEqual(english.filter((k) => !(k in NL_TRANSLATIONS)), []);
    assert.deepStrictEqual(Object.keys(NL_TRANSLATIONS).filter((k) => !(k in GUI_DEFAULTS)), []);
});

test('a blob without the keys gets all of them, own wording is kept, a second run changes nothing', () => {
    const { merged, added } = applyNl({ 'meetings.import_error_empty': 'Eigen tekst' });
    assert.strictEqual(added, Object.keys(NL_TRANSLATIONS).length - 1);
    assert.strictEqual(merged['meetings.import_error_empty'], 'Eigen tekst');
    assert.strictEqual(applyNl(merged).added, 0);
});
