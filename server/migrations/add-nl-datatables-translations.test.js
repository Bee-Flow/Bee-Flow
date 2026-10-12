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
