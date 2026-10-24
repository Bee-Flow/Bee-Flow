// @typecheck
'use strict';

/**
 * Importing a workbook as a spreadsheet document (core/documents/sheetImport.js):
 * every worksheet a tab, formulas kept as text, clipping reported, all-or-nothing.
 * Real xlsx bytes (office/xlsxWorkbook.js), stubbed stores.
 *
 * Run: cd server && node --test core/documents/sheetImport.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { makeSheetImport, formatOf, functionsIn } = require('./sheetImport');
const { buildXlsxWorkbook } = require('./office/xlsxWorkbook');

function fakes({ failWriteOn = null, failUpdate = false } = {}) {
    const s = { tables: new Map(), dropped: [], docs: [], updates: [] };
    let n = 0;
    return {
        s,
        cells: {
            async createSheetTable({ name }) { n += 1; s.tables.set(`t${n}`, { name, cells: {} }); return { id: `t${n}` }; },
            async writeCells(owner, id, c) {
                assert.ok(Object.keys(c).length <= 500);
                if (failWriteOn === id) throw new Error('boom');
                Object.assign(s.tables.get(id).cells, c);
                return { cells: c };
            },
            async dropSheetTable(owner, id) { s.dropped.push(id); },
        },
        documents: {
            async createDocument(input) { const d = { id: 'doc1', versionId: 'v1', settings: {}, ...input }; s.docs.push(d); return d; },
            async updateDocument(id, ctx, upd) { if (failUpdate) throw new Error('nope'); s.updates.push([id, ctx, upd]); return { id }; },
        },
    };
}

test('formats come from the name, else the mime', () => {
    assert.strictEqual(formatOf('a.XLSX'), 'xlsx');
    assert.strictEqual(formatOf('a.ods'), 'ods');
    assert.strictEqual(formatOf('data', 'text/csv; charset=utf-8'), 'csv');
    assert.strictEqual(formatOf('a.pdf', 'application/pdf'), null);
});

test('functionsIn ignores text in quotes', () => {
    assert.deepStrictEqual(functionsIn('=SUM(A1:A2)+XLOOKUP(B1,"MAX(",C1)'), ['SUM', 'XLOOKUP']);
});

test('an xlsx becomes a document with a tab per sheet, formulas kept, odd functions listed', async () => {
    const f = fakes();
    const buffer = await buildXlsxWorkbook([
        { name: 'Budget', matrix: [['Item', 'Cost'], ['Rent', 1200], ['Food', 300.5], ['Total', { formula: '=SUM(B2:B3)' }]] },
        { name: 'Notes', matrix: [['x'], [{ formula: '=XLOOKUP(A1,A1:A2,A1:A2)' }]] },
    ], { formulas: true });
    const out = await makeSheetImport(f).importWorkbook({ userId: 'u1', buffer, fileName: 'Budget 2026.xlsx' });
    assert.strictEqual(out.name, 'Budget 2026');
    assert.strictEqual(out.documentId, 'doc1');
    assert.deepStrictEqual(out.tabs, [{ name: 'Budget', rows: 4, cols: 2 }, { name: 'Notes', rows: 2, cols: 1 }]);
    assert.deepStrictEqual(out.unsupportedFunctions, ['XLOOKUP']);
    assert.deepStrictEqual(out.truncated, []);
    assert.deepStrictEqual(f.s.tables.get('t1').cells, { A1: 'Item', B1: 'Cost', A2: 'Rent', B2: '1200', A3: 'Food', B3: '300.5', A4: 'Total', B4: '=SUM(B2:B3)' });
    assert.strictEqual(f.s.docs[0].sheetTableId, 't1');
    assert.strictEqual(f.s.docs[0].docType, 'spreadsheet');
    const tabs = f.s.updates[0][2].settings.sheet.tabs;
    assert.deepStrictEqual(tabs.map((t) => [t.name, t.datatableId]), [['Budget', 't1'], ['Notes', 't2']]);
});

test('a csv is one tab; rows and columns past the sheet are cut and reported', async () => {
    const f = fakes();
    const rows = [];
    for (let r = 0; r < 2005; r += 1) rows.push(Array.from({ length: 28 }, (_, c) => (r === 0 ? `h${c}` : (c === 0 ? String(r) : ''))).join(','));
    const out = await makeSheetImport(f).importWorkbook({ userId: 'u1', buffer: Buffer.from(rows.join('\n')), fileName: 'big.csv', mimeType: 'text/csv' });
    assert.deepStrictEqual(out.tabs, [{ name: 'Sheet1', rows: 2000, cols: 26 }]);
    assert.deepStrictEqual(out.truncated, [{ tab: 'Sheet1', droppedRows: 5, droppedCols: 2 }]);
    assert.strictEqual(f.s.updates.length, 0, 'one default tab needs no settings save');
});

test('more than 20 sheets: the rest is skipped and named', async () => {
    const f = fakes();
    const sheets = Array.from({ length: 22 }, (_, i) => ({ name: `S${i + 1}`, matrix: [['a']] }));
    const out = await makeSheetImport(f).importWorkbook({ userId: 'u1', buffer: await buildXlsxWorkbook(sheets), fileName: 'many.xlsx' });
    assert.strictEqual(out.tabs.length, 20);
    assert.deepStrictEqual(out.skippedSheets, ['S21', 'S22']);
});

test('a failure drops every table made', async () => {
    const f = fakes({ failWriteOn: 't2' });
    const buffer = await buildXlsxWorkbook([{ name: 'A', matrix: [['1']] }, { name: 'B', matrix: [['2']] }]);
    await assert.rejects(makeSheetImport(f).importWorkbook({ userId: 'u1', buffer, fileName: 'x.xlsx' }), /boom/);
    assert.deepStrictEqual(f.s.dropped, ['t1', 't2']);
    assert.strictEqual(f.s.docs.length, 0);
});

test('when the tabs cannot be saved the document keeps its first tab and the rest is given back', async () => {
    const f = fakes({ failUpdate: true });
    const buffer = await buildXlsxWorkbook([{ name: 'A', matrix: [['1']] }, { name: 'B', matrix: [['2']] }]);
    const out = await makeSheetImport(f).importWorkbook({ userId: 'u1', buffer, fileName: 'x.xlsx' });
    assert.deepStrictEqual(out.tabs.map((t) => t.name), ['A']);
    assert.deepStrictEqual(out.skippedSheets, ['B']);
    assert.deepStrictEqual(f.s.dropped, ['t2']);
});

test('a file that is not a workbook is refused before anything is made', async () => {
    const f = fakes();
    await assert.rejects(makeSheetImport(f).importWorkbook({ userId: 'u1', buffer: Buffer.from('hello'), fileName: 'x.xlsx' }), /not a valid \.xlsx|could not be read/);
    await assert.rejects(makeSheetImport(f).importWorkbook({ userId: 'u1', buffer: Buffer.from('x'), fileName: 'x.pdf' }), /Only \.xlsx/);
    assert.strictEqual(f.s.tables.size, 0);
});
