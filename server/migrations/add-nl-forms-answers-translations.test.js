/**
 * The Forms catalogue: every key is an English key, every value is really
 * Dutch, placeholders survive, every forms.* / datatables.frm_* key has
 * Dutch, "verwijderen" is never said about the answers table when the form
 * goes, and boot runs it.
 *
 * Run: node --test migrations/add-nl-forms-answers-translations.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS, SAME_AS_ENGLISH } = require('./add-nl-forms-answers-translations');
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

test('every forms.*, sidebar.forms*, datatables.frm_* key has Dutch', () => {
    const same = new Set(SAME_AS_ENGLISH);
    const untranslated = Object.keys(GUI_DEFAULTS)
        .filter(k => /^(forms\.|sidebar\.(all_)?forms|studio\.tab\.forms_desc|datatables\.frm_|datatables\.managed_definition_owned)/.test(k))
        .filter(k => !(k in NL_TRANSLATIONS) && !same.has(k));
    assert.deepStrictEqual(untranslated, []);
});

test('placeholders survive translation', () => {
    const holes = (s) => (String(s).match(/\{[a-z_]+\}/gi) || []).sort();
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.deepStrictEqual(holes(v), holes(GUI_DEFAULTS[k]), `${k}: placeholders differ from English`);
    }
});

test('"dit account", never "jij"; and the answers table is never threatened when the form goes', () => {
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.doesNotMatch(v, /\bjij\b|\bjouw\b/i, `${k} addresses the reader as "jij"`);
    }
    // deleting the FORM keeps the table — the sentence must say so, not "verwijder" the table
    assert.match(NL_TRANSLATIONS['forms.settings.delete_notice'], /tabel blijft staan/);
    assert.match(NL_TRANSLATIONS['forms.settings.stop_body'], /blijven zoals ze zijn/);
});

test('the migration is registered, or it never runs', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../boot/bootMigrations.js'), 'utf8');
    assert.ok(src.includes("'add-nl-forms-answers-translations'"));
});
