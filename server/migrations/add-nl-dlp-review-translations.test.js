/**
 * These nine keys were the bug: Dutch values sitting in the ENGLISH catalogue.
 * That failure mode is silent in both directions — a Dutch reader sees Dutch
 * and a English reader sees Dutch too, and nothing errors — so the two
 * assertions that would have caught it are pinned here: the English catalogue
 * must not be Dutch any more, and every key this dialog reads must have a real
 * Dutch value to fall back to.
 *
 * Run: node --test --test-force-exit migrations/add-nl-dlp-review-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS } = require('./add-nl-dlp-review-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

test('every Dutch key exists in the English catalog', () => {
    const orphans = Object.keys(NL_TRANSLATIONS).filter(k => !(k in GUI_DEFAULTS));
    assert.deepStrictEqual(orphans, []);
});

test('no Dutch value is blank or the English one copied over', () => {
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.ok(String(v || '').trim(), `${k} has no Dutch value`);
        assert.notStrictEqual(v, GUI_DEFAULTS[k], `${k} was never actually translated`);
    }
});

test('the English catalog is no longer Dutch for these keys', () => {
    // The original defect. A handful of Dutch words that also read as English
    // ("Tip") are not enough to key on, so this looks for the ones that cannot
    // be anything but Dutch.
    const DUTCH_MARKERS = /\b(gedetecteerd|persoonsgegevens|verzenden|controleer|bijlage|hieronder|selecteer|ongedaan|voordat|toegevoegd)\b/i;
    const dutch = Object.keys(NL_TRANSLATIONS).filter(k => DUTCH_MARKERS.test(GUI_DEFAULTS[k] || ''));
    assert.deepStrictEqual(dutch, [], 'these English catalog entries still hold Dutch text');
});

test('placeholders survive translation', () => {
    // "{auto}" dropped from the Dutch sentence is a summary that no longer says
    // how much was found.
    const holes = (s) => (String(s).match(/\{[a-z_]+\}/g) || []).sort();
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.deepStrictEqual(holes(v), holes(GUI_DEFAULTS[k]), `${k}: placeholders differ from English`);
    }
});

test('the migration is registered, or it never runs', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../boot/bootMigrations.js'), 'utf8');
    assert.ok(src.includes("'add-nl-dlp-review-translations'"),
        'add it to the NL_TRANSLATIONS list in boot/bootMigrations.js');
});
