// @typecheck
/**
 * Characterisation (golden) test for columns.fieldsFromSheet: the whole result
 * (fields, columnMap, relations, warnings, changes, retyped, keyFieldId) for a
 * fixed set of header shapes and prior mirror states. Every branch that
 * changes an id, a key, a type, a warning or a change line is in a case:
 * invalid columns, the column cap, overrides by old id / header hash / column
 * map entry / bare string, an undeclarable type, select without options,
 * a reserved key, a retype whose old key is taken, a case-only rename, a
 * move, kept and new relation fields, relations on a column that is gone, a
 * key column that is not an integer, explicit formats, and derived prior
 * entries.
 *
 * Regenerate the golden file ONLY for an intended behaviour change:
 *   UPDATE_GOLDEN=1 node --test core/dataEngine/sources/spreadsheetFile/columns.fieldsFromSheet.characterisation.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { fieldsFromSheet, matchFieldIdFor, describeHeader } = require('./columns');

const GOLDEN = path.join(__dirname, 'columns.fieldsFromSheet.characterisation.golden.json');

/** @type {import('./columns').SheetColumn[]} */
const BASE = [
    { col: 0, header: 'Datum', type: 'date' },
    { col: 1, header: 'Leverancier', type: 'text' },
    { col: 2, header: 'Nummer', type: 'text', numFmt: '@' },
    { col: 3, header: 'Bedrag', type: 'number', numFmt: '#,##0.00' },
    { col: 4, header: 'Status', type: 'select', options: ['open', 'dicht'] },
    { col: 5, header: 'Totaal', type: 'number', formula: true },
];

const first = fieldsFromSheet(BASE, { keyCol: 2 });
const prior = { existingFields: first.fields, existingColumnMap: first.columnMap };
const idOf = (/** @type {string} */ key) => /** @type {{ id: string }} */ (first.fields.find(f => f.key === key)).id;
const rel = { targetDatatableId: 'tbl_lev', targetKey: 'leveranciers', targetName: 'Leveranciers', localFieldId: idOf('leverancier'), targetFieldId: 'fld_nc20txt' };
const relId = matchFieldIdFor(rel.targetDatatableId, rel.localFieldId, rel.targetFieldId);
const withRel = fieldsFromSheet(BASE, { ...prior, declaredRelations: [rel] });

/** @type {Record<string, () => unknown>} */
const CASES = {
    fresh: () => first,
    notAList: () => fieldsFromSheet(/** @type {any} */ ('nope')),
    noArgs: () => fieldsFromSheet(/** @type {any} */ (undefined)),
    invalidColumns: () => fieldsFromSheet(/** @type {any} */ ([null, { col: -1, header: 'Neg' }, { col: 1.5, header: 'Half' }, { header: 'NoCol' }, { col: 3, header: 'Ok' }])),
    capped: () => fieldsFromSheet(Array.from({ length: 103 }, (_, i) => ({ col: i, header: `K${i}` }))).warnings,
    undeclarableType: () => fieldsFromSheet([{ col: 0, header: 'Bijlage', type: 'file' }, { col: 1, header: 'Geen' }]),
    undeclarableTypeOverridden: () => fieldsFromSheet([{ col: 0, header: 'Bijlage', type: 'file' }], { overrides: { [describeHeader(['Bijlage'])[0].headerHash]: 'number' } }),
    overrideByHash: () => fieldsFromSheet(BASE, { ...prior, overrides: { [/** @type {string} */ (first.columnMap[idOf('bedrag')].headerHash)]: { type: 'text' } } }),
    overrideBareString: () => fieldsFromSheet(BASE, { ...prior, overrides: { [idOf('datum')]: 'datetime' } }),
    overrideByLegacyEntry: () => fieldsFromSheet(BASE, {
        ...prior,
        existingColumnMap: { ...first.columnMap, legacy: { headerHash: first.columnMap[idOf('nummer')].headerHash } },
        overrides: { legacy: { type: 'number' } },
    }),
    overridesIgnored: () => fieldsFromSheet(BASE, { ...prior, overrides: /** @type {any} */ ({ zz: { type: 'text' }, [idOf('datum')]: { type: 'file' }, abc: 7, ['0123456789']: 'bool' }) }),
    overrideToSelectWithoutOptions: () => fieldsFromSheet(BASE, { ...prior, overrides: { [idOf('leverancier')]: 'select' } }),
    selectNoOptions: () => fieldsFromSheet([{ col: 0, header: 'Lijst', type: 'select', options: [' ', null] }]),
    reservedKey: () => fieldsFromSheet(BASE, { reservedKeys: new Set(['datum', 'bedrag']) }),
    reservedKeyKeptField: () => fieldsFromSheet(BASE, { ...prior, reservedKeys: new Set(['datum']) }),
    retypeKeepsKey: () => fieldsFromSheet(BASE.map(c => (c.col === 3 ? { ...c, type: 'text' } : c)), prior),
    retypeKeyTaken: () => fieldsFromSheet(BASE.map(c => (c.col === 3 ? { ...c, type: 'text' } : c)), { ...prior, reservedKeys: new Set(['bedrag']) }),
    retypeFromFieldsOnly: () => fieldsFromSheet(BASE.map(c => (c.col === 0 ? { ...c, type: 'text' } : c)), { existingFields: first.fields }),
    caseRenameAndMove: () => fieldsFromSheet([{ col: 0, header: 'LEVERANCIER', type: 'text' }, { col: 1, header: 'Datum', type: 'date' }, ...BASE.slice(2)], prior),
    keptKeyNotStolen: () => fieldsFromSheet([{ col: 0, header: 'Supplier' }, ...BASE.map(c => ({ ...c, col: c.col + 1 }))], {
        existingFields: first.fields.map(f => (f.key === 'leverancier' ? { ...f, key: 'supplier' } : f)),
        existingColumnMap: first.columnMap,
    }),
    removedAndAdded: () => fieldsFromSheet([...BASE.slice(1), { col: 6, header: 'Nieuw' }], prior),
    priorTypeWins: () => fieldsFromSheet(BASE.map(({ col, header }) => ({ col, header })), prior),
    keyColNotInteger: () => fieldsFromSheet(BASE, { keyCol: /** @type {any} */ ('2') }),
    keyColGone: () => fieldsFromSheet(BASE, { ...prior, keyCol: 9 }),
    formats: () => fieldsFromSheet([
        { col: 0, header: 'A', type: 'text', format: 'percent', numFmt: '0%', dateFormat: 'dd-mm' },
        { col: 1, header: 'B', type: 'datetime', dateFormat: 'yyyy' },
        { col: 2, header: 'C', type: 'number', numFmt: '[$€-413] #,##0.00' },
        { col: 3, header: 'D', type: 'number', numFmt: 0 },
    ]),
    relationNew: () => withRel,
    relationKept: () => fieldsFromSheet(BASE, { existingFields: withRel.fields, existingColumnMap: withRel.columnMap, declaredRelations: [rel] }),
    relationDropped: () => fieldsFromSheet(BASE, { existingFields: withRel.fields, existingColumnMap: withRel.columnMap }),
    relationKeyReservedFromColumn: () => fieldsFromSheet([...BASE, { col: 6, header: 'leveranciers_ref' }], { existingFields: withRel.fields, existingColumnMap: withRel.columnMap, declaredRelations: [rel] }),
    relationOnGoneColumn: () => fieldsFromSheet(BASE, { declaredRelations: [{ ...rel, localFieldId: 'fld_ssdeadbeef00txt' }] }),
    relationOnPriorOnlyColumn: () => fieldsFromSheet(BASE.slice(2), { ...prior, declaredRelations: [rel] }),
    relationsInvalid: () => fieldsFromSheet(BASE, { declaredRelations: /** @type {any} */ ([null, { targetDatatableId: 't' }, { ...rel, targetFieldId: '' }]) }),
    relationNoNames: () => fieldsFromSheet(BASE, { declaredRelations: [{ targetDatatableId: 'tbl_x', localFieldId: rel.localFieldId, targetFieldId: 'fld_y' }] }),
    relationKeptNoName: () => fieldsFromSheet(BASE, {
        existingFields: withRel.fields.map(f => (f.id === relId ? { id: f.id } : f)),
        existingColumnMap: withRel.columnMap,
        declaredRelations: [rel],
    }),
    derivedPriorEntrySkipped: () => fieldsFromSheet(BASE.map(({ col, header, options }) => ({ col, header, options })), {
        existingFields: first.fields,
        existingColumnMap: { ...first.columnMap, [idOf('bedrag')]: { ...first.columnMap[idOf('bedrag')], derived: 'match', type: 'bool' } },
    }),
    priorEntryMissingHash: () => fieldsFromSheet(BASE.map(({ col, header }) => ({ col, header })), {
        existingFields: first.fields,
        existingColumnMap: Object.fromEntries(Object.entries(first.columnMap).map(([id, e]) => [id, { ...e, headerHash: undefined }])),
    }),
    priorJunk: () => fieldsFromSheet(BASE, { existingFields: /** @type {any} */ ([null, { id: 7 }, { id: 'fld_other', key: 'other' }, ...first.fields]), existingColumnMap: /** @type {any} */ ('x') }),
    priorNotAList: () => fieldsFromSheet(BASE, { existingFields: /** @type {any} */ ({}), existingColumnMap: /** @type {any} */ (null), overrides: /** @type {any} */ (null) }),
    keptFieldWithoutKey: () => fieldsFromSheet(BASE, { existingFields: first.fields.map(f => ({ id: f.id, name: f.name })), existingColumnMap: first.columnMap }),
    blankAndDuplicates: () => fieldsFromSheet([{ col: 0, header: '' }, { col: 1, header: 'X' }, { col: 2, header: 'x' }, { col: 26, header: null }]),
};

/** JSON round-trip, so the comparison is on what callers store. */
const plain = (/** @type {unknown} */ v) => JSON.parse(JSON.stringify(v));

test('fieldsFromSheet: every case matches the golden result', () => {
    const actual = Object.fromEntries(Object.entries(CASES).map(([name, run]) => [name, plain(run())]));
    if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + '\n');
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    assert.deepEqual(Object.keys(actual), Object.keys(golden));
    for (const name of Object.keys(CASES)) assert.deepEqual(actual[name], golden[name], name);
});

test('fieldsFromSheet: the inputs it is given are not changed', () => {
    const columns = structuredClone(BASE);
    const ctx = { existingFields: structuredClone(withRel.fields), existingColumnMap: structuredClone(withRel.columnMap), declaredRelations: [{ ...rel }] };
    const before = structuredClone({ columns, ctx });
    fieldsFromSheet(columns, ctx);
    assert.deepEqual({ columns, ctx }, before);
});
