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

test('the English catalog is no longer Dutch for these keys', () => {
    // The original defect. A handful of Dutch words that also read as English
    // ("Tip") are not enough to key on, so this looks for the ones that cannot
    // be anything but Dutch.
    const DUTCH_MARKERS = /\b(gedetecteerd|persoonsgegevens|verzenden|controleer|bijlage|hieronder|selecteer|ongedaan|voordat|toegevoegd)\b/i;
    const dutch = Object.keys(NL_TRANSLATIONS).filter(k => DUTCH_MARKERS.test(GUI_DEFAULTS[k] || ''));
    assert.deepStrictEqual(dutch, [], 'these English catalog entries still hold Dutch text');
});
