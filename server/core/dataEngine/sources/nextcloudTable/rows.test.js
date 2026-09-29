/**
 * One Nextcloud row → one mirror row: keyed by the mirror's field keys, the
 * id is Nextcloud's, unknown columns are ignored, missing ones are NULL, and
 * the derived columns come from the indexes.
 */
const test = require('node:test');
const assert = require('node:assert');
const { mirrorRowFromNc, fieldsByIdOf } = require('./rows');

const meta = {
    fields: [
        { id: 'fld_nc2txt', key: 'leverancier', type: 'text' },
        { id: 'fld_nc6num', key: 'totaal', type: 'number' },
        { id: 'fld_nc9rel', key: 'lev', type: 'relation' },
        { id: 'fld_nc9lbl', key: 'lev_label', type: 'text', derived: true },
        { id: 'fld_ncrelabc', key: 'leveranciers_ref', type: 'relation', derived: true },
    ],
};
const columnMap = {
    fld_nc2txt: { ncColumnId: 2, ncType: 'text', ncSubtype: 'line' },
    fld_nc6num: { ncColumnId: 6, ncType: 'number' },
    fld_nc9rel: { ncColumnId: 9, ncType: 'relation' },
    fld_nc9lbl: { derived: 'label', forFieldId: 'fld_nc9rel' },
    fld_ncrelabc: { derived: 'match', localFieldId: 'fld_nc2txt', targetFieldId: 'fld_nc20txt' },
};

test('values are keyed by field key, id is the Nextcloud row id as a string', () => {
    const { id, values } = mirrorRowFromNc(
        { id: 17, data: [{ columnId: 2, value: 'Acme' }, { columnId: 6, value: 121 }, { columnId: 99, value: 'ignored' }] },
        { columnMap, fieldsById: fieldsByIdOf(meta) },
    );
    assert.equal(id, '17');
    assert.equal(values.leverancier, 'Acme');
    assert.equal(values.totaal, 121);
    assert.equal(values.lev, null);              // not in the row → NULL
    assert.equal(values.lev_label, null);
    assert.equal(values.leveranciers_ref, null);
    assert.equal('column_99' in values, false);
});

test('derived columns are filled from the relation and label indexes, a miss is NULL', () => {
    const relationIndexes = new Map([['fld_ncrelabc', new Map([['Acme', '40']])]]);
    const labelIndexes = new Map([['fld_nc9rel', new Map([['7', 'Acme BV']])]]);
    const hit = mirrorRowFromNc(
        { id: 1, data: [{ columnId: 2, value: 'Acme' }, { columnId: 9, value: 7 }] },
        { columnMap, fieldsById: fieldsByIdOf(meta), relationIndexes, labelIndexes },
    ).values;
    assert.equal(hit.lev, '7');
    assert.equal(hit.lev_label, 'Acme BV');
    assert.equal(hit.leveranciers_ref, '40');
    const miss = mirrorRowFromNc(
        { id: 2, data: [{ columnId: 2, value: 'Nobody' }, { columnId: 9, value: 8 }] },
        { columnMap, fieldsById: fieldsByIdOf(meta), relationIndexes, labelIndexes },
    ).values;
    assert.equal(miss.lev, '8');
    assert.equal(miss.lev_label, null);
    assert.equal(miss.leveranciers_ref, null);
});
