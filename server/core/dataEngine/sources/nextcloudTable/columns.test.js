/**
 * Nextcloud columns → mirror fields: the ids are DERIVED, the keys are KEPT,
 * a retype is a drop-and-add under the same key, and a relation resolves only
 * when its target is linked.
 */
const test = require('node:test');
const assert = require('node:assert');
const { FIELD_ID_RE } = require('../../dataModel/datatableFields');
const { KEY_RE } = require('../../dataModel/vocabulary');
const columns = require('./columns');

// Table 4 "Facturen" on the local sandbox, verbatim.
const FACTUREN = [
    { id: 1, title: 'Datum', type: 'datetime', subtype: 'date' },
    { id: 2, title: 'Leverancier', type: 'text', subtype: 'line' },
    { id: 3, title: 'Factuurnummer', type: 'text', subtype: 'line', mandatory: true },
    { id: 4, title: 'Excl. btw', type: 'number', subtype: '' },
    { id: 5, title: 'Btw', type: 'number' },
    { id: 6, title: 'Totaal', type: 'number' },
];

test('the six sandbox columns become six fields with derived ids and slug keys', () => {
    const { fields, columnMap, changes, warnings } = columns.fieldsFromNcColumns(FACTUREN);
    assert.deepEqual(fields.map(f => [f.id, f.key, f.type]), [
        ['fld_nc1dat', 'datum', 'date'],
        ['fld_nc2txt', 'leverancier', 'text'],
        ['fld_nc3txt', 'factuurnummer', 'text'],
        ['fld_nc4num', 'excl_btw', 'number'],
        ['fld_nc5num', 'btw', 'number'],
        ['fld_nc6num', 'totaal', 'number'],
    ]);
    for (const f of fields) { assert.match(f.id, FIELD_ID_RE); assert.match(f.key, KEY_RE); }
    assert.equal(fields[2].required, true);
    assert.equal(columnMap.fld_nc4num.ncColumnId, 4);
    assert.equal(columnMap.fld_nc4num.ncType, 'number');
    assert.equal(changes.length, 6);
    assert.deepEqual(warnings, []);
});

test('a rename in Nextcloud keeps the key and moves the name', () => {
    const first = columns.fieldsFromNcColumns(FACTUREN);
    const renamed = FACTUREN.map(c => (c.id === 2 ? { ...c, title: 'Supplier' } : c));
    const next = columns.fieldsFromNcColumns(renamed, { existingFields: first.fields });
    const f = next.fields.find(x => x.id === 'fld_nc2txt');
    assert.equal(f.key, 'leverancier');
    assert.equal(f.name, 'Supplier');
    assert.deepEqual(next.changes, ['renamed:leverancier']);
    assert.deepEqual(next.retyped, []);
});

test('a retype is a new id under the old key, and the old field is reported for dropping', () => {
    const first = columns.fieldsFromNcColumns(FACTUREN);
    const retyped = FACTUREN.map(c => (c.id === 2 ? { ...c, type: 'number', subtype: '' } : c));
    const next = columns.fieldsFromNcColumns(retyped, { existingFields: first.fields });
    const f = next.fields.find(x => x.key === 'leverancier');
    assert.equal(f.id, 'fld_nc2num');
    assert.equal(f.type, 'number');
    assert.deepEqual(next.retyped.map(x => x.id), ['fld_nc2txt']);
    assert.ok(next.changes.includes('retyped:leverancier'));
});

test('a column dropped in Nextcloud is reported as removed', () => {
    const first = columns.fieldsFromNcColumns(FACTUREN);
    const next = columns.fieldsFromNcColumns(FACTUREN.slice(0, 5), { existingFields: first.fields });
    assert.deepEqual(next.changes, ['removed:totaal']);
    assert.deepEqual(next.retyped, []);
});

test('keys are slugged, prefixed when they start with a digit, and de-duplicated', () => {
    const { fields } = columns.fieldsFromNcColumns([
        { id: 10, title: '2024 Q1', type: 'text' },
        { id: 11, title: 'Btw', type: 'number' },
        { id: 12, title: 'BTW.', type: 'number' },
        { id: 13, title: '', type: 'text' },
        { id: 14, title: 'id', type: 'text' },
        { id: 15, title: 'pg_secret', type: 'text' },
    ]);
    assert.deepEqual(fields.map(f => f.key), ['c_2024_q1', 'btw', 'btw_2', 'column_13', 'id_col', 'c_pg_secret']);
});

test('selection columns carry their options as labels, de-duplicated; a check is a bool; multi is a list', () => {
    const { fields, columnMap } = columns.fieldsFromNcColumns([
        { id: 7, title: 'Status', type: 'selection', subtype: '', selectionOptions: [{ id: 0, label: 'open' }, { id: 1, label: 'open' }, { id: 2, label: 'betaald' }] },
        { id: 8, title: 'Tags', type: 'selection', subtype: 'selection-multi', selectionOptions: [{ id: 0, label: 'a' }] },
        { id: 9, title: 'Akkoord', type: 'selection', subtype: 'check' },
        { id: 10, title: 'Leeg', type: 'selection', subtype: '', selectionOptions: [] },
    ]);
    assert.deepEqual(fields.map(f => [f.key, f.type, f.options]), [
        ['status', 'select', ['open', 'open (2)', 'betaald']],
        ['tags', 'multiselect', ['a']],
        ['akkoord', 'bool', undefined],
        ['leeg', 'text', undefined],
    ]);
    assert.deepEqual(columnMap.fld_nc7sel.options, [{ id: 0, label: 'open' }, { id: 1, label: 'open (2)' }, { id: 2, label: 'betaald' }]);
});

const REL = { id: 9, title: 'Leverancier', type: 'relation', customSettings: { relationType: 'table', targetId: 6, labelColumn: 12 } };

test('a Nextcloud relation whose target is linked becomes a relation without FK plus a label column', () => {
    const { fields, relations, columnMap } = columns.fieldsFromNcColumns([REL], { linkedTargets: new Map([[6, 'tbl_lev']]) });
    assert.deepEqual(fields.map(f => [f.id, f.key, f.type]), [
        ['fld_nc9rel', 'leverancier', 'relation'],
        ['fld_nc9lbl', 'leverancier_label', 'text'],
    ]);
    assert.deepEqual(fields[0].relation, { table: 'tbl_lev', fk: false });
    assert.equal(fields[1].derived, true);
    assert.deepEqual(relations, [{ fieldId: 'fld_nc9rel', kind: 'nc', targetDatatableId: 'tbl_lev', labelFieldId: 'fld_nc9lbl', labelNcColumnId: 12 }]);
    assert.deepEqual(columnMap.fld_nc9lbl, { derived: 'label', forFieldId: 'fld_nc9rel' });
});

test('a Nextcloud relation whose target is NOT linked arrives as a number, with a warning', () => {
    const { fields, relations, warnings } = columns.fieldsFromNcColumns([REL]);
    assert.deepEqual(fields.map(f => [f.id, f.type]), [['fld_nc9num', 'number']]);
    assert.deepEqual(relations, []);
    assert.match(warnings[0], /not linked here/);
});

test('a declared match relation adds a derived relation column named after the target', () => {
    const base = columns.fieldsFromNcColumns(FACTUREN);
    const { fields, relations, columnMap } = columns.fieldsFromNcColumns(FACTUREN, {
        existingFields: base.fields,
        declaredRelations: [{ targetDatatableId: 'tbl_lev', targetKey: 'leveranciers', targetName: 'Leveranciers', localFieldId: 'fld_nc2txt', targetFieldId: 'fld_nc20txt' }],
    });
    const ref = fields.find(f => f.type === 'relation');
    assert.equal(ref.key, 'leveranciers_ref');
    assert.equal(ref.derived, true);
    assert.match(ref.id, /^fld_ncrel[0-9a-f]{10}$/);
    assert.deepEqual(ref.relation, { table: 'tbl_lev', fk: false });
    assert.deepEqual(relations, [{ fieldId: ref.id, kind: 'match', targetDatatableId: 'tbl_lev', localFieldId: 'fld_nc2txt', targetFieldId: 'fld_nc20txt' }]);
    assert.deepEqual(columnMap[ref.id], { derived: 'match', localFieldId: 'fld_nc2txt', targetFieldId: 'fld_nc20txt' });
    // Deterministic across passes.
    assert.equal(columns.matchFieldIdFor('tbl_lev', 'fld_nc2txt', 'fld_nc20txt'), ref.id);
});

test('type mapping covers every Nextcloud type and subtype', () => {
    const m = columns.mirrorTypeFor;
    assert.equal(m('text', 'line'), 'text');
    assert.equal(m('text', 'long'), 'text');
    assert.equal(m('text', 'rich'), 'richtext');
    assert.equal(m('text', 'link'), 'text');
    assert.equal(m('number', ''), 'number');
    assert.equal(m('number', 'progress'), 'number');
    assert.equal(m('number', 'stars'), 'number');
    assert.equal(m('datetime', ''), 'datetime');
    assert.equal(m('datetime', 'date'), 'date');
    assert.equal(m('datetime', 'time'), 'text');
    assert.equal(m('selection', ''), 'select');
    assert.equal(m('selection', 'check'), 'bool');
    assert.equal(m('selection', 'selection-multi'), 'multiselect');
    assert.equal(m('usergroup', ''), 'text');
    assert.equal(m('relation', ''), 'relation');
    assert.equal(m('something-new', ''), 'text');
});
