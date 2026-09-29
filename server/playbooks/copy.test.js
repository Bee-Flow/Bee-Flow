'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('./copy');

test('the locale a playbook stores decides the pack, and the language a model is asked for', () => {
    assert.equal(C.normaliseLocale('en'), 'en');
    assert.equal(C.normaliseLocale('nl-NL'), 'nl');
    assert.equal(C.normaliseLocale('EN_us'), 'en');
    assert.equal(C.normaliseLocale(''), 'nl');
    assert.equal(C.normaliseLocale(null, 'en'), 'en');
    assert.equal(C.normaliseLocale('nonsense'), 'nl');
    // The model is asked for the language by name, including one we ship no copy for.
    assert.equal(C.languageName('nl'), 'Dutch');
    assert.equal(C.languageName('en'), 'English');
    assert.equal(C.languageName('de'), 'German');
    assert.equal(C.languageName(undefined), 'English');
    // Copy exists for Dutch and English; every other interface language reads English.
    assert.equal(C.packLocale('nl'), 'nl');
    assert.equal(C.packLocale('de'), 'en');
    assert.equal(C.packLocale(null), 'nl');   // an old playbook, before the locale was stored
});

test('every summary the engine writes has both languages, with the numbers in them', () => {
    const nl = C.copyFor('nl');
    const en = C.copyFor('en');
    assert.equal(nl.tableCreated('Facturen', 8), 'Tabel "Facturen" aangemaakt met 8 kolommen.');
    assert.equal(en.tableCreated('Invoices', 8), 'Table "Invoices" created with 8 columns.');
    // A mirror is named after where its rows live (the registry's builder
    // kind); a kind the copy has no word for is still a mirror, never Nextcloud.
    assert.equal(en.tableVerified('Invoices', 6, { isMirror: true, mirrorKind: 'nextcloud', hasStatus: false }), 'Table "Invoices" checked: 6 columns recognised (Nextcloud mirror), no status column.');
    assert.equal(en.tableVerified('Invoices', 6, { isMirror: true, mirrorKind: 'spreadsheet' }), 'Table "Invoices" checked: 6 columns recognised (spreadsheet mirror).');
    assert.equal(nl.tableVerified('Facturen', 6, { isMirror: true, mirrorKind: 'spreadsheet' }), 'Tabel "Facturen" gecontroleerd: 6 kolommen herkend (spreadsheet-spiegel).');
    assert.equal(en.tableVerified('Invoices', 6, { isMirror: true }), 'Table "Invoices" checked: 6 columns recognised (mirror of an external source).');
    assert.equal(en.rowsAdded(1, 1), '1 row added to the table (1 now).');
    assert.equal(en.rowsAdded(32, 32), '32 rows added to the table (32 now).');
    assert.equal(en.rowsAdded(null, null), 'Rows added to the table.');
    assert.equal(en.designSummary('Invoices', 1, 9, 'cloud'), 'Design "Invoices": 1 screen, 9 elements, look cloud.');
    assert.equal(en.designSummary('Invoices', 3, 9, 'cloud'), 'Design "Invoices": 3 screens, 9 elements, look cloud.');
    // The two packs answer the same questions — a missing one would read as English in a Dutch demo.
    assert.deepEqual(Object.keys(nl).sort(), Object.keys(en).sort());
    // An interface language we have no words for reads English, never a key.
    assert.equal(C.copyFor('de').tableCreated('Rechnungen', 3), 'Table "Rechnungen" created with 3 columns.');
});
