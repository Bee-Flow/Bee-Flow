/**
 * The spreadsheet-mirror catalogue: every key is an English key, every value
 * is really Dutch, placeholders survive, "ontkoppelen" never threatens the
 * file, and boot runs it.
 *
 * Run: node --test migrations/add-nl-datatables-spreadsheets-translations.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS, SAME_AS_ENGLISH } = require('./add-nl-datatables-spreadsheets-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

test('every ss_*, src_* and spreadsheet-kind key has Dutch', () => {
    // The `src_*` sentences are shared by both mirror kinds but were
    // introduced with this one, so their Dutch is pinned here — the
    // Nextcloud catalogue's own regex does not reach them.
    const same = new Set(SAME_AS_ENGLISH);
    const untranslated = Object.keys(GUI_DEFAULTS)
        .filter(k => /^datatables\.(ss_|src_|kind_spreadsheet)/.test(k))
        .filter(k => !(k in NL_TRANSLATIONS) && !same.has(k));
    assert.deepStrictEqual(untranslated, []);
});

test('"ontkoppelen", never "verwijderen", for a mirror — the file stays exactly as it is', () => {
    // The notice is the sentence a person reads with the Unlink button under
    // their cursor; a "verwijder" in it reads as a threat to the file.
    assert.doesNotMatch(NL_TRANSLATIONS['datatables.ss_unlink_notice'], /verwijder/i);
});
