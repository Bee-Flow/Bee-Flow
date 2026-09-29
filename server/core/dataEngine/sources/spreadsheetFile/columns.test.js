/**
 * Header cells → mirror fields: ids derived from the header text, keys kept,
 * a rename is drop + add, a move keeps the id, a retype is a drop-and-add
 * under the same key, and declared relations under the fld_ssrel prefix.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { FIELD_ID_RE } = require('../../dataModel/datatableFields');
const { KEY_RE } = require('../../dataModel/vocabulary');
const columns = require('./columns');

// Facturen.xlsx on the sandbox, as the wizard would send it.
const FACTUREN = [
    { col: 0, header: 'Datum', type: 'date' },
    { col: 1, header: 'Leverancier', type: 'text' },
    { col: 2, header: 'Factuurnummer', type: 'text' },
    { col: 3, header: 'Excl. btw', type: 'number', numFmt: '#,##0.00' },
    { col: 4, header: 'Btw', type: 'number' },
    { col: 5, header: 'Totaal', type: 'number', formula: true, numFmt: '[$€-413] #,##0.00' },
    { col: 6, header: 'Betaald', type: 'bool' },
];

const hashOf = (seed) => crypto.createHash('sha256').update(`ss\0${seed}`).digest('hex').slice(0, 10);

test('the seven columns become seven fields with hashed ids, slug keys and the declared types', () => {
    const { fields, columnMap, changes, warnings, keyFieldId } = columns.fieldsFromSheet(FACTUREN, { keyCol: 2 });
    assert.deepEqual(fields.map(f => [f.key, f.type]), [
        ['datum', 'date'], ['leverancier', 'text'], ['factuurnummer', 'text'], ['excl_btw', 'number'],
        ['btw', 'number'], ['totaal', 'number'], ['betaald', 'bool'],
    ]);
    for (const f of fields) { assert.match(f.id, FIELD_ID_RE); assert.match(f.key, KEY_RE); assert.equal(f.id.length, 19); }
    assert.equal(fields[0].id, `fld_ss${hashOf('datum')}dat`);
    assert.equal(fields[3].id, `fld_ss${hashOf('excl_btw')}num`);
    assert.equal(fields[2].required, true);
    assert.equal(keyFieldId, fields[2].id);
    assert.equal(columnMap[fields[2].id].key, true);
    assert.deepEqual(columnMap[fields[0].id], { col: 0, header: 'Datum', headerHash: hashOf('datum'), type: 'date', format: 'date' });
    assert.equal(columnMap[fields[3].id].numFmt, '#,##0.00');
    assert.equal(columnMap[fields[5].id].format, 'currency');
    assert.equal(columnMap[fields[5].id].formula, true);
    assert.equal(fields[5].derived, true);
    assert.equal(changes.length, 7);
    assert.ok(changes.every(c => c.startsWith('added:')));
    assert.deepEqual(warnings, []);
});

test('the same header always gives the same id, whatever the case, spacing or position', () => {
    const a = columns.fieldsFromSheet([{ col: 0, header: 'Excl. btw', type: 'number' }]);
    const b = columns.fieldsFromSheet([{ col: 5, header: '  EXCL BTW ', type: 'number' }]);
    assert.equal(a.fields[0].id, b.fields[0].id);
    assert.equal(a.fields[0].key, b.fields[0].key);
});

test('a moved column keeps its id and key, only col changes', () => {
    const first = columns.fieldsFromSheet(FACTUREN);
    const moved = [FACTUREN[1], FACTUREN[0], ...FACTUREN.slice(2)].map((c, i) => ({ ...c, col: i }));
    const next = columns.fieldsFromSheet(moved, { existingFields: first.fields, existingColumnMap: first.columnMap });
    assert.deepEqual(next.fields.map(f => f.id).sort(), first.fields.map(f => f.id).sort());
    assert.equal(next.columnMap[first.fields[0].id].col, 1);
    assert.equal(next.columnMap[first.fields[1].id].col, 0);
    assert.deepEqual(next.changes.sort(), ['moved:datum', 'moved:leverancier']);
    assert.deepEqual(next.retyped, []);
});

test('a renamed header is a drop and an add — no position guessing', () => {
    const first = columns.fieldsFromSheet(FACTUREN);
    const renamed = FACTUREN.map(c => (c.col === 1 ? { ...c, header: 'Supplier' } : c));
    const next = columns.fieldsFromSheet(renamed, { existingFields: first.fields, existingColumnMap: first.columnMap });
    const oldId = first.fields[1].id;
    assert.ok(!next.fields.some(f => f.id === oldId));
    const added = next.fields.find(f => f.key === 'supplier');
    assert.ok(added);
    assert.equal(added.id, `fld_ss${hashOf('supplier')}txt`);
    assert.deepEqual(next.changes.sort(), ['added:supplier', 'removed:leverancier']);
    assert.deepEqual(next.retyped, []);
});

test('a retype is a new id under the old key, and the old field is reported for dropping', () => {
    const first = columns.fieldsFromSheet(FACTUREN);
    const retyped = FACTUREN.map(c => (c.col === 2 ? { ...c, type: 'number' } : c));
    const next = columns.fieldsFromSheet(retyped, { existingFields: first.fields, existingColumnMap: first.columnMap });
    const f = next.fields.find(x => x.key === 'factuurnummer');
    assert.equal(f.id, `fld_ss${hashOf('factuurnummer')}num`);
    assert.equal(f.type, 'number');
    assert.deepEqual(next.retyped.map(x => x.id), [first.fields[2].id]);
    assert.ok(next.changes.includes('retyped:factuurnummer'));
});

test('types are declared: without a type the prior declaration wins, never the data', () => {
    const first = columns.fieldsFromSheet(FACTUREN);
    const bare = FACTUREN.map(({ col, header, formula }) => ({ col, header, formula }));
    const next = columns.fieldsFromSheet(bare, { existingFields: first.fields, existingColumnMap: first.columnMap });
    assert.deepEqual(next.fields.map(f => f.id), first.fields.map(f => f.id));
    assert.deepEqual(next.retyped, []);
    // a brand-new column with no type arrives as text
    const grown = columns.fieldsFromSheet([...bare, { col: 7, header: 'Opmerking' }], { existingFields: first.fields, existingColumnMap: first.columnMap });
    assert.equal(grown.fields.find(f => f.key === 'opmerking').type, 'text');
});

test('overrides keyed by the OLD field id retype a column (PUT /:id/source)', () => {
    const first = columns.fieldsFromSheet(FACTUREN);
    const oldId = first.fields[4].id;                      // Btw, number
    const next = columns.fieldsFromSheet(FACTUREN, {
        existingFields: first.fields, existingColumnMap: first.columnMap,
        overrides: { [oldId]: { type: 'text' } },
    });
    const f = next.fields.find(x => x.key === 'btw');
    assert.equal(f.type, 'text');
    assert.equal(f.id, `fld_ss${hashOf('btw')}txt`);
    assert.deepEqual(next.retyped.map(x => x.id), [oldId]);
    // an unknown type in an override is ignored
    const same = columns.fieldsFromSheet(FACTUREN, { existingFields: first.fields, existingColumnMap: first.columnMap, overrides: { [oldId]: { type: 'file' } } });
    assert.deepEqual(same.retyped, []);
});

test('blank and duplicate headers get letter names, col_<letter> keys and distinct ids', () => {
    const { fields, columnMap, warnings } = columns.fieldsFromSheet([
        { col: 0, header: 'Naam', type: 'text' },
        { col: 1, header: '', type: 'text' },
        { col: 2, header: 'naam', type: 'text' },
        { col: 3, header: null, type: 'number' },
    ]);
    assert.deepEqual(fields.map(f => [f.key, f.name]), [['naam', 'Naam'], ['col_b', 'B'], ['naam_2', 'naam #2'], ['col_d', 'D']]);
    assert.equal(fields[1].id, `fld_ss${hashOf('#col1')}txt`);
    assert.equal(fields[2].id, `fld_ss${hashOf('naam#2')}txt`);
    assert.equal(fields[3].id, `fld_ss${hashOf('#col3')}num`);
    assert.equal(new Set(fields.map(f => f.id)).size, 4);
    assert.equal(columnMap[fields[1].id].header, '');
    assert.deepEqual(warnings, []);
});

test('a select column carries its options; one without options falls back to text', () => {
    const { fields, columnMap, warnings } = columns.fieldsFromSheet([
        { col: 0, header: 'Status', type: 'select', options: ['open', 'open', 'betaald', ' ', { label: 'vervallen' }] },
        { col: 1, header: 'Leeg', type: 'select', options: [] },
    ]);
    assert.equal(fields[0].type, 'select');
    assert.deepEqual(fields[0].options, ['open', 'betaald', 'vervallen']);
    assert.deepEqual(columnMap[fields[0].id].options, ['open', 'betaald', 'vervallen']);
    assert.equal(fields[0].id.endsWith('sel'), true);
    assert.equal(fields[1].type, 'text');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /without options/);
});

test('a declared match relation becomes a derived relation field under fld_ssrel', () => {
    const first = columns.fieldsFromSheet(FACTUREN);
    const local = first.fields[1].id;                     // Leverancier
    const rel = { targetDatatableId: 'tbl_lev', targetKey: 'leveranciers', targetName: 'Leveranciers', localFieldId: local, targetFieldId: 'fld_nc20txt' };
    const next = columns.fieldsFromSheet(FACTUREN, { existingFields: first.fields, existingColumnMap: first.columnMap, declaredRelations: [rel] });
    const id = columns.matchFieldIdFor('tbl_lev', local, 'fld_nc20txt');
    assert.match(id, /^fld_ssrel[0-9a-f]{10}$/);
    assert.match(id, FIELD_ID_RE);
    const f = next.fields.find(x => x.id === id);
    assert.deepEqual(f, { id, key: 'leveranciers_ref', name: 'Leveranciers row', type: 'relation', derived: true, relation: { table: 'tbl_lev', fk: false } });
    assert.deepEqual(next.columnMap[id], { derived: 'match', localFieldId: local, targetFieldId: 'fld_nc20txt' });
    assert.deepEqual(next.relations, [{ fieldId: id, kind: 'match', targetDatatableId: 'tbl_lev', localFieldId: local, targetFieldId: 'fld_nc20txt' }]);
    assert.ok(next.changes.includes('added:leveranciers_ref'));
    // the same triple under the Nextcloud prefix is a different id
    const nc = require('../mirror/keys').matchFieldIdFor('tbl_lev', local, 'fld_nc20txt');
    assert.equal(nc.slice(9), id.slice(9));
    assert.notEqual(nc, id);
    // a relation on a column that is gone is skipped with a warning
    const gone = columns.fieldsFromSheet(FACTUREN, { declaredRelations: [{ ...rel, localFieldId: 'fld_ssdeadbeef00txt' }] });
    assert.equal(gone.relations.length, 0);
    assert.match(gone.warnings[0], /no longer has/);
});

test('a key column that vanished from the header is reported, and more than 100 columns are capped', () => {
    const first = columns.fieldsFromSheet(FACTUREN, { keyCol: 2 });
    const without = FACTUREN.filter(c => c.col !== 2);
    const next = columns.fieldsFromSheet(without, { existingFields: first.fields, existingColumnMap: first.columnMap, keyCol: 2 });
    assert.equal(next.keyFieldId, null);
    assert.match(next.warnings[0], /key column/);
    const many = Array.from({ length: 120 }, (_, i) => ({ col: i, header: `Kolom ${i}`, type: 'text' }));
    const capped = columns.fieldsFromSheet(many);
    assert.equal(capped.fields.length, 100);
    assert.match(capped.warnings[0], /first 100 of 120/);
});

test('describeHeader and columnLetter are what infer and the wizard share', () => {
    const d = columns.describeHeader(['Naam', 'Naam', '', new Date(Date.UTC(2024, 0, 1)), 2024]);
    assert.deepEqual(d.map(x => [x.col, x.letter, x.name, x.blankHeader, x.duplicateHeader]), [
        [0, 'A', 'Naam', false, false], [1, 'B', 'Naam #2', false, true], [2, 'C', 'C', true, false],
        [3, 'D', '2024-01-01', false, false], [4, 'E', '2024', false, false],
    ]);
    assert.equal(columns.columnLetter(0), 'A');
    assert.equal(columns.columnLetter(25), 'Z');
    assert.equal(columns.columnLetter(26), 'AA');
    assert.equal(columns.columnLetter(99), 'CV');
    assert.equal(columns.columnLetter(-1), '');
    assert.deepEqual(columns.parseFieldId(`fld_ss${hashOf('datum')}dat`), { headerHash: hashOf('datum'), typeCode: 'dat' });
    assert.equal(columns.parseFieldId('fld_nc1dat'), null);
});
