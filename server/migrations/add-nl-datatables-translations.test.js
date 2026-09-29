/**
 * A Dutch key that matches no English key is stored, never read, and the UI
 * quietly stays English — with no error anywhere. That is the only failure
 * mode a two-key catalogue has, so it is the one thing worth pinning.
 *
 * Run: node --test migrations/add-nl-datatables-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS, SAME_AS_ENGLISH } = require('./add-nl-datatables-translations');
// The Nextcloud-mirror and spreadsheet-mirror halves of the section have
// their own catalogues; the rule "every datatables.* key has Dutch" holds
// over the UNION of the three.
const NC = require('./add-nl-datatables-nextcloud-translations');
const SS = require('./add-nl-datatables-spreadsheets-translations');
// … and the form-answers half (`datatables.frm_*`) lives with the Forms
// catalogue, which is the fourth member of the union.
const FA = require('./add-nl-forms-answers-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

test('every Dutch key exists in the English catalog', () => {
    const orphans = [...Object.keys(NL_TRANSLATIONS), ...SAME_AS_ENGLISH].filter(k => !(k in GUI_DEFAULTS));
    assert.deepStrictEqual(orphans, []);
});

test('no Dutch value is blank or the English one copied over', () => {
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.ok(String(v || '').trim(), `${k} has no Dutch value`);
        assert.notStrictEqual(v, GUI_DEFAULTS[k],
            `${k} was never actually translated — if the Dutch really is the English word, move it to SAME_AS_ENGLISH`);
    }
});

test('every English datatables.* key has a Dutch one (or is declared identical)', () => {
    // The other direction, and the one that actually decides whether a Dutch
    // user sees Dutch. A missing key is not an error anywhere: t() falls back
    // to English and the screen looks fine to whoever wrote it. This section's
    // copy is consent- and processing-record-flavoured ("this sentence goes
    // into your organisation's processing record", "type the table's name to
    // confirm"), so half-translated is the one outcome worth failing a build.
    const same = new Set([...SAME_AS_ENGLISH, ...NC.SAME_AS_ENGLISH, ...SS.SAME_AS_ENGLISH, ...FA.SAME_AS_ENGLISH]);
    const untranslated = Object.keys(GUI_DEFAULTS)
        .filter(k => k.startsWith('datatables.') && !(k in NL_TRANSLATIONS) && !(k in NC.NL_TRANSLATIONS) && !(k in SS.NL_TRANSLATIONS) && !(k in FA.NL_TRANSLATIONS) && !same.has(k));
    assert.deepStrictEqual(untranslated, []);
});

test('placeholders survive translation', () => {
    // "{n}" dropped from "hoogstens {limit} rijen tegelijk" is a sentence that
    // no longer says what the limit is — which is why the toast exists.
    const holes = (s) => (String(s).match(/\{[a-z_]+\}/gi) || []).sort();
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.deepStrictEqual(holes(v), holes(GUI_DEFAULTS[k]), `${k}: placeholders differ from English`);
    }
});

test('the migration is registered, or it never runs', () => {
    // A migration file that boot never requires is a file that does nothing —
    // and the symptom (Dutch that silently stays English) looks identical to a
    // typo, so it is worth one assertion rather than an afternoon.
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../boot/bootMigrations.js'), 'utf8');
    assert.ok(src.includes("'add-nl-datatables-translations'"),
        'add it to the NL_TRANSLATIONS list in boot/bootMigrations.js');
});
