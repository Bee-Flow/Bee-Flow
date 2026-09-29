/**
 * The Nextcloud-mirror catalogue: every key is an English key, every value is
 * really Dutch, placeholders survive, and boot runs it.
 *
 * Run: node --test migrations/add-nl-datatables-nextcloud-translations.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS, SAME_AS_ENGLISH } = require('./add-nl-datatables-nextcloud-translations');
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

test('every nc_* and Nextcloud-kind key has Dutch', () => {
    const same = new Set(SAME_AS_ENGLISH);
    const untranslated = Object.keys(GUI_DEFAULTS)
        .filter(k => /^datatables\.(nc_|kind_nextcloud|kindchip_nextcloud|tab_nextcloud|err_nextcloud|err_nc_|err_mirror|err_schema_from_source|err_derived_column|err_already_linked|err_not_nc_org|kind_relation)/.test(k))
        .filter(k => !(k in NL_TRANSLATIONS) && !same.has(k));
    assert.deepStrictEqual(untranslated, []);
});

test('placeholders survive translation', () => {
    const holes = (s) => (String(s).match(/\{[a-z_]+\}/gi) || []).sort();
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.deepStrictEqual(holes(v), holes(GUI_DEFAULTS[k]), `${k}: placeholders differ from English`);
    }
});

test('"ontkoppelen", never "verwijderen", for a mirror — the table in Nextcloud stays', () => {
    for (const k of ['datatables.nc_unlink_open', 'datatables.nc_unlink_question', 'datatables.nc_unlink_confirm']) {
        assert.doesNotMatch(NL_TRANSLATIONS[k], /verwijder/i, k);
    }
});

test('the migration is registered, or it never runs', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../boot/bootMigrations.js'), 'utf8');
    assert.ok(src.includes("'add-nl-datatables-nextcloud-translations'"));
});
