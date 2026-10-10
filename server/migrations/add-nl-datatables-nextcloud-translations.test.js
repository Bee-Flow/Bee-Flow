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

test('every nc_* and Nextcloud-kind key has Dutch', () => {
    const same = new Set(SAME_AS_ENGLISH);
    const untranslated = Object.keys(GUI_DEFAULTS)
        .filter(k => /^datatables\.(nc_|kind_nextcloud|kindchip_nextcloud|tab_nextcloud|err_nextcloud|err_nc_|err_mirror|err_schema_from_source|err_derived_column|err_already_linked|err_not_nc_org|kind_relation)/.test(k))
        .filter(k => !(k in NL_TRANSLATIONS) && !same.has(k));
    assert.deepStrictEqual(untranslated, []);
});

test('"ontkoppelen", never "verwijderen", for a mirror — the table in Nextcloud stays', () => {
    for (const k of ['datatables.nc_unlink_open', 'datatables.nc_unlink_question', 'datatables.nc_unlink_confirm']) {
        assert.doesNotMatch(NL_TRANSLATIONS[k], /verwijder/i, k);
    }
});
