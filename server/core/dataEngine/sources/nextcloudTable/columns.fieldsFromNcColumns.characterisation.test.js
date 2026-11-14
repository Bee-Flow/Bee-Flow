// @typecheck
/**
 * Characterisation (golden) test for columns.fieldsFromNcColumns: the whole
 * result (fields, columnMap, relations, warnings, changes, retyped) for a
 * fixed set of Nextcloud column shapes and prior mirror states. Every branch
 * that changes an id, a key, a type, a warning or a change line is in a case:
 * invalid and capped columns, a relation to a linked table, to a linked view,
 * to an unlinked target and with bad settings, kept and new label columns,
 * lists without options, a retype whose old key is taken, a kept field
 * without a key, kept and new declared relations, a relation on a column that
 * is gone or only in the prior shape, reserved keys and a mandatory column.
 *
 * Regenerate the golden file ONLY for an intended behaviour change:
 *   UPDATE_GOLDEN=1 node --test core/dataEngine/sources/nextcloudTable/columns.fieldsFromNcColumns.characterisation.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { fieldsFromNcColumns, matchFieldIdFor } = require('./columns');

const GOLDEN = path.join(__dirname, 'columns.fieldsFromNcColumns.characterisation.golden.json');

/** @type {import('./columns').NcColumn[]} */
const BASE = [
    { id: 1, title: 'Datum', type: 'datetime', subtype: 'date' },
    { id: 2, title: 'Leverancier', type: 'text', subtype: 'line', mandatory: true },
    { id: 3, title: 'Status', type: 'selection', selectionOptions: [{ id: 0, label: 'open' }, { id: 1, label: 'dicht' }] },
    { id: 4, title: 'Klant', type: 'relation', customSettings: { relationType: 'table', targetId: 6, labelColumn: 12 } },
    { id: 5, title: 'Project', type: 'relation', customSettings: { relationType: 'view', targetId: 7, labelColumn: 3 } },
];
const LINKED = { linkedTargets: new Map([[6, 'tbl_klant']]), linkedViews: new Map([[7, 'tbl_proj']]) };
const first = fieldsFromNcColumns(BASE, LINKED);
const rel = { targetDatatableId: 'tbl_lev', targetKey: 'leveranciers', targetName: 'Leveranciers', localFieldId: 'fld_nc2txt', targetFieldId: 'fld_nc20txt' };
const relId = matchFieldIdFor(rel.targetDatatableId, rel.localFieldId, rel.targetFieldId);
const withRel = fieldsFromNcColumns(BASE, { ...LINKED, existingFields: first.fields, declaredRelations: [rel] });

/** @type {Record<string, () => unknown>} */
const CASES = {
    fresh: () => first,
    notAList: () => fieldsFromNcColumns(/** @type {any} */ ('nope')),
    noArgs: () => fieldsFromNcColumns(/** @type {any} */ (undefined)),
    invalidColumns: () => fieldsFromNcColumns(/** @type {any} */ ([null, { id: 'x', title: 'Bad' }, { id: '8', title: 'Stringy', type: 'number' }, { title: 'NoId' }, { id: 1.5, title: 'Half' }])),
    capped: () => fieldsFromNcColumns(Array.from({ length: 103 }, (_, i) => ({ id: i + 1, title: `K${i}`, type: 'text' }))).warnings,
    unlinkedRelations: () => fieldsFromNcColumns(BASE),
    badRelationSettings: () => fieldsFromNcColumns(/** @type {any} */ ([
        { id: 4, title: 'Klant', type: 'relation', customSettings: { relationType: 'table', targetId: 'x', labelColumn: 12 } },
        { id: 5, title: 'Project', type: 'relation', customSettings: { targetId: 7, labelColumn: null } },
        { id: 6, title: 'Geen', type: 'relation' },
        { id: 7, title: 'TableNotView', type: 'relation', customSettings: { relationType: 'other', targetId: 7, labelColumn: 3 } },
    ]), LINKED),
    relationKept: () => fieldsFromNcColumns(BASE, { ...LINKED, existingFields: first.fields }),
    relationRenamedLabelKept: () => fieldsFromNcColumns(BASE.map(c => (c.id === 4 ? { ...c, title: 'Client' } : c)), { ...LINKED, existingFields: first.fields }),
    relationLostTarget: () => fieldsFromNcColumns(BASE, { linkedTargets: new Map(), linkedViews: LINKED.linkedViews, existingFields: first.fields }),
    relationGainedTarget: () => fieldsFromNcColumns(BASE, { ...LINKED, existingFields: fieldsFromNcColumns(BASE).fields }),
    listsWithoutOptions: () => fieldsFromNcColumns([
        { id: 1, title: 'Leeg', type: 'selection', selectionOptions: [] },
        { id: 2, title: 'Multi', type: 'selection', subtype: 'selection-multi' },
        { id: 3, title: 'Check', type: 'selection', subtype: 'check' },
    ]),
    retypeKeepsKey: () => fieldsFromNcColumns(BASE.map(c => (c.id === 1 ? { ...c, type: 'text', subtype: 'line' } : c)), { ...LINKED, existingFields: first.fields }),
    retypeKeyTaken: () => fieldsFromNcColumns(BASE.map(c => (c.id === 1 ? { ...c, type: 'text' } : c)), { ...LINKED, existingFields: first.fields, reservedKeys: new Set(['datum']) }),
    retypeOfLabelIgnored: () => fieldsFromNcColumns(BASE, { ...LINKED, existingFields: [...first.fields.filter(f => f.id !== 'fld_nc4lbl'), { id: 'fld_nc4lbl', key: 'old_label', name: 'x' }] }),
    keptFieldWithoutKey: () => fieldsFromNcColumns(BASE, { ...LINKED, existingFields: first.fields.map(f => ({ id: f.id, name: f.name })) }),
    keptKeyNotStolen: () => fieldsFromNcColumns([{ id: 9, title: 'Supplier', type: 'text' }, ...BASE], {
        ...LINKED,
        existingFields: first.fields.map(f => (f.key === 'leverancier' ? { ...f, key: 'supplier' } : f)),
    }),
    reservedKeys: () => fieldsFromNcColumns(BASE, { ...LINKED, reservedKeys: new Set(['datum', 'klant_label']) }),
    titles: () => fieldsFromNcColumns(/** @type {any} */ ([{ id: 1, title: '   ', type: 'text' }, { id: 2, type: 'text' }, { id: 3, title: 'x'.repeat(300), type: 'text' }, { id: 4, title: ' Spaced ', type: 'text', subtype: 'rich' }])),
    removedAndAdded: () => fieldsFromNcColumns([...BASE.slice(1), { id: 9, title: 'Nieuw', type: 'number' }], { ...LINKED, existingFields: first.fields }),
    priorJunk: () => fieldsFromNcColumns(BASE, { ...LINKED, existingFields: /** @type {any} */ ([null, { id: 7 }, { id: 'fld_other', key: 'other' }, ...first.fields]) }),
    priorNotAList: () => fieldsFromNcColumns(BASE, { ...LINKED, existingFields: /** @type {any} */ ({}) }),
    declaredNew: () => withRel,
    declaredKept: () => fieldsFromNcColumns(BASE, { ...LINKED, existingFields: withRel.fields, declaredRelations: [rel] }),
    declaredKeptNoName: () => fieldsFromNcColumns(BASE, { ...LINKED, existingFields: withRel.fields.map(f => (f.id === relId ? { id: f.id } : f)), declaredRelations: [rel] }),
    declaredDropped: () => fieldsFromNcColumns(BASE, { ...LINKED, existingFields: withRel.fields }),
    declaredKeyReservedFromColumn: () => fieldsFromNcColumns([...BASE, { id: 9, title: 'leveranciers_ref', type: 'text' }], { ...LINKED, existingFields: withRel.fields, declaredRelations: [rel] }),
    declaredOnGoneColumn: () => fieldsFromNcColumns(BASE, { ...LINKED, declaredRelations: [{ ...rel, localFieldId: 'fld_nc99txt' }] }),
    declaredOnPriorOnlyColumn: () => fieldsFromNcColumns(BASE.slice(2), { ...LINKED, existingFields: first.fields, declaredRelations: [rel] }),
    declaredInvalid: () => fieldsFromNcColumns(BASE, { ...LINKED, declaredRelations: /** @type {any} */ ([{ targetDatatableId: 't' }, { ...rel, targetFieldId: '' }]) }),
    declaredNoNames: () => fieldsFromNcColumns(BASE, { ...LINKED, declaredRelations: [{ targetDatatableId: 'tbl_x', localFieldId: 'fld_nc2txt', targetFieldId: 'fld_y' }] }),
    declaredNullThrows: () => { try { return fieldsFromNcColumns(BASE, { declaredRelations: /** @type {any} */ ([null]) }); } catch (e) { return { threw: String(e) }; } },
};

/** JSON round-trip, so the comparison is on what callers store. */
const plain = (/** @type {unknown} */ v) => JSON.parse(JSON.stringify(v));

test('fieldsFromNcColumns: every case matches the golden result', () => {
    const actual = Object.fromEntries(Object.entries(CASES).map(([name, run]) => [name, plain(run())]));
    if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + '\n');
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    assert.deepEqual(Object.keys(actual), Object.keys(golden));
    for (const name of Object.keys(CASES)) assert.deepEqual(actual[name], golden[name], name);
});
