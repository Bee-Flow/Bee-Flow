/**
 * One sheet row → one mirror row: keyed by the mirror's field keys, cells
 * read through the codec for the declared type, unknown columns ignored,
 * short rows NULL, coercions counted, match relations from the indexes, and
 * no row for a raw without an id.
 */
const test = require('node:test');
const assert = require('node:assert');
const { rowFromSheet, fieldsByIdOf } = require('./rows');

const meta = {
    fields: [
        { id: 'fld_ss1111111111dat', key: 'datum', type: 'date' },
        { id: 'fld_ss2222222222txt', key: 'leverancier', type: 'text' },
        { id: 'fld_ss3333333333num', key: 'bedrag', type: 'number' },
        { id: 'fld_ss4444444444bol', key: 'betaald', type: 'bool' },
        { id: 'fld_ss5555555555dtm', key: 'tijdstip', type: 'datetime' },
        { id: 'fld_ssrel0000000001', key: 'leveranciers_ref', type: 'relation', derived: true },
    ],
};
const columnMap = {
    fld_ss1111111111dat: { col: 0, header: 'Datum', headerHash: '1111111111', type: 'date' },
    fld_ss2222222222txt: { col: 1, header: 'Leverancier', headerHash: '2222222222', type: 'text' },
    fld_ss3333333333num: { col: 2, header: 'Bedrag', headerHash: '3333333333', type: 'number' },
    fld_ss4444444444bol: { col: 3, header: 'Betaald', headerHash: '4444444444', type: 'bool' },
    fld_ss5555555555dtm: { col: 9, header: 'Tijdstip', headerHash: '5555555555', type: 'datetime' },
    fld_ssrel0000000001: { derived: 'match', localFieldId: 'fld_ss2222222222txt', targetFieldId: 'fld_nc20txt' },
    fld_ssunknown00txt: { col: 4, header: 'Weg', headerHash: 'unknown000', type: 'text' },   // no field for it → ignored
};

test('values are keyed by field key, read through the codec, and short rows are NULL', () => {
    const raw = { id: 'F-2026-001', rowNumber: 2, cells: [new Date(Date.UTC(2026, 0, 15)), 'Acme', '1.234,56', 'ja', 'ignored'] };
    const { id, values } = rowFromSheet(raw, { columnMap, fieldsById: fieldsByIdOf(meta) });
    assert.equal(id, 'F-2026-001');
    assert.deepEqual(values, {
        datum: '2026-01-15', leverancier: 'Acme', bedrag: 1234.56, betaald: true, tijdstip: null, leveranciers_ref: null,
    });
    assert.equal('weg' in values, false);
});

test('a cell that does not fit its declared type lands NULL and is counted per key', () => {
    const coercion = {};
    const ctx = { columnMap, fieldsById: fieldsByIdOf(meta), coercion };
    rowFromSheet({ id: 'r2', cells: ['gisteren', 'Acme', 'n.v.t.', 'ja'] }, ctx);
    rowFromSheet({ id: 'r3', cells: [null, 'Beta', 'x', 'soms'] }, ctx);
    rowFromSheet({ id: 'r4', cells: [null, null, 5, null] }, ctx);      // blanks are not coercions
    assert.deepEqual(coercion, { datum: 1, bedrag: 2, betaald: 1 });
});

test('a match relation is filled from the index; a miss is NULL', () => {
    const relationIndexes = new Map([['fld_ssrel0000000001', new Map([['Acme', '40']])]]);
    const ctx = { columnMap, fieldsById: fieldsByIdOf(meta), relationIndexes };
    assert.equal(rowFromSheet({ id: 'r2', cells: [null, 'Acme'] }, ctx).values.leveranciers_ref, '40');
    assert.equal(rowFromSheet({ id: 'r3', cells: [null, 'Nobody'] }, ctx).values.leveranciers_ref, null);
    assert.equal(rowFromSheet({ id: 'r4', cells: [null, null] }, ctx).values.leveranciers_ref, null);
});

test('a raw without an id (blank row, missing or duplicate key) gives no row', () => {
    const ctx = { columnMap, fieldsById: fieldsByIdOf(meta) };
    assert.equal(rowFromSheet({ id: null, cells: ['x'] }, ctx), null);
    assert.equal(rowFromSheet({ cells: ['x'] }, ctx), null);
    assert.equal(rowFromSheet(null, ctx), null);
});

test('the entry type wins over the field type, so a retype in flight reads the new way', () => {
    const fieldsById = fieldsByIdOf({ fields: [{ id: 'fld_ss3333333333num', key: 'bedrag', type: 'text' }] });
    const { values } = rowFromSheet({ id: 'r2', cells: [null, null, '12'] }, { columnMap: { fld_ss3333333333num: { col: 2, type: 'number' } }, fieldsById });
    assert.strictEqual(values.bedrag, 12);
});
