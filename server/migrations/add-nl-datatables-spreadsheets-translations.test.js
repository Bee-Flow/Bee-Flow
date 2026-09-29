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

test('every Dutch key exists in the English catalog', () => {
    const orphans = [...Object.keys(NL_TRANSLATIONS), ...SAME_AS_ENGLISH].filter(k => !(k in GUI_DEFAULTS));
    assert.deepStrictEqual(orphans, []);
});

test('no Dutch value is blank or the English one copied over', () => {
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.ok(String(v || '').trim(), `${k} has no Dutch value`);
        assert.notStrictEqual(v, GUI_DEFAULTS[k], `${k} was never actually translated`);
    }
});

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

test('placeholders survive translation', () => {
    // "{source}" dropped from "in de pas met {source}" is a sentence that no
    // longer says which source — and it is the one word the two kinds differ in.
    const holes = (s) => (String(s).match(/\{[a-z_]+\}/gi) || []).sort();
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.deepStrictEqual(holes(v), holes(GUI_DEFAULTS[k]), `${k}: placeholders differ from English`);
    }
});

test('"ontkoppelen", never "verwijderen", for a mirror — the file stays exactly as it is', () => {
    // The notice is the sentence a person reads with the Unlink button under
    // their cursor; a "verwijder" in it reads as a threat to the file.
    assert.doesNotMatch(NL_TRANSLATIONS['datatables.ss_unlink_notice'], /verwijder/i);
});

test('the migration is registered, or it never runs', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../boot/bootMigrations.js'), 'utf8');
    assert.ok(src.includes("'add-nl-datatables-spreadsheets-translations'"));
});
