// @typecheck
'use strict';

/**
 * A spreadsheet document as an .xlsx (core/documents/sheetExport.js).
 *
 * Run: cd server && node --test core/documents/sheetExport.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const JSZip = require('jszip');
const { buildSheetWorkbook, cellsToMatrix, quoteSheetRefs, xlsxFileName } = require('./sheetExport');

const doc = {
    id: 's1', userId: 'owner', name: 'Büdget 2026!', docType: 'spreadsheet',
    settings: { sheet: { tabs: [
        { id: 't1', name: 'Main', datatableId: 'dt1' },
        { id: 't2', name: 'My Tab', datatableId: 'dt2' },
    ] } },
};
const data = {
    dt1: { A1: 'Item', B1: 'Cost', A2: 'Rent', B2: '1200', A3: 'Tax', B3: '=B2*0.21', B4: "=SUM(B2:B3)+'My Tab'!A1", C5: '=\'My Tab\'!A1', D5: '=My Tab!A1' },
    dt2: { A1: '7', B2: '="My Tab!A1"&Main!B2' },
};
const cells = { async readSheet(owner, table) { assert.strictEqual(owner, 'owner'); return { cells: data[table], rows: 5 }; } };

async function parts(buffer) {
    const zip = await JSZip.loadAsync(buffer);
    return {
        workbook: await zip.file('xl/workbook.xml').async('string'),
        s1: await zip.file('xl/worksheets/sheet1.xml').async('string'),
        s2: await zip.file('xl/worksheets/sheet2.xml').async('string'),
    };
}

test('one worksheet per tab, same names and order, numbers and formulas real', async () => {
    const out = await buildSheetWorkbook(doc, { cells });
    assert.match(out.contentType, /spreadsheetml\.sheet/);
    assert.strictEqual(out.filename, 'Budget-2026.xlsx');
    const { workbook, s1 } = await parts(out.buffer);
    assert.match(workbook, /<sheet name="Main" sheetId="1"[^>]*\/><sheet name="My Tab" sheetId="2"/);
    assert.match(s1, /<c r="B2"><v>1200<\/v><\/c>/);
    assert.match(s1, /<c r="B3"><f>B2\*0\.21<\/f><\/c>/);
    assert.match(s1, /<c r="A2" t="inlineStr">/);
});

test('a reference to a tab is quoted for Excel, a string literal is not touched', async () => {
    const { s1, s2 } = await parts((await buildSheetWorkbook(doc, { cells })).buffer);
    assert.match(s1, /<c r="C5"><f>&apos;My Tab&apos;!A1<\/f><\/c>/);
    assert.match(s1, /<f>SUM\(B2:B3\)\+&apos;My Tab&apos;!A1<\/f>/);
    assert.match(s2, /<f>&quot;My Tab!A1&quot;&amp;&apos;Main&apos;!B2<\/f>/);
});

test('quoteSheetRefs: doubled quotes, no double quoting, not inside a longer word', () => {
    assert.strictEqual(quoteSheetRefs('=Totals!A1', ['Totals']), "='Totals'!A1");
    assert.strictEqual(quoteSheetRefs("='Totals'!A1", ['Totals']), "='Totals'!A1");
    assert.strictEqual(quoteSheetRefs('=MyTotals!A1', ['Totals']), '=MyTotals!A1');
    assert.strictEqual(quoteSheetRefs("=Bob's!A1", ["Bob's"]), "='Bob''s'!A1");
    assert.strictEqual(quoteSheetRefs('plain', ['Totals']), 'plain');
});

test('cellsToMatrix: columns from A, empty cells empty, rows up to the last used', () => {
    assert.deepStrictEqual(cellsToMatrix({ B2: 'x', A1: 'y' }), [['y'], ['', 'x']]);
    assert.deepStrictEqual(cellsToMatrix({}), []);
});

test('xlsxFileName is ASCII safe', () => {
    assert.strictEqual(xlsxFileName('../etc/pass"wd'), 'etc-pass-wd.xlsx');
    assert.strictEqual(xlsxFileName(''), 'spreadsheet.xlsx');
});

test('charts become native charts on their tab (no tab = first tab), with computed values cached', async () => {
    const withCharts = { ...doc, settings: { sheet: { ...doc.settings.sheet, charts: [
        { id: 'c1', type: 'bar', dataRange: 'B2:B3', categoriesRange: 'A2:A3', anchor: 'E2', width: 320, height: 220 },
        { id: 'c2', type: 'line', dataRange: 'A1:A1', anchor: 'D2', width: 320, height: 220, tab: 't2' },
        { id: 'c3', type: 'scatter', dataRange: 'A1:A1', anchor: 'D2', width: 320, height: 220, tab: 't2' },
    ] } } };
    const { buffer } = await buildSheetWorkbook(withCharts, { cells });
    const zip = await JSZip.loadAsync(buffer);
    const names = Object.keys(zip.files).filter((n) => /^xl\/charts\/chart\d\.xml$/.test(n));
    assert.strictEqual(names.length, 2, 'the scatter without categories is left out');
    const first = (await zip.file('xl/charts/chart1.xml').async('string')).replace(/&apos;/g, "'");
    assert.match(first, /<c:f>'Main'!\$B\$2:\$B\$3<\/c:f>/);
    assert.match(first, /<c:pt idx="1"><c:v>252<\/c:v>/, 'B3 = B2*0.21 computed');
    const second = (await zip.file('xl/charts/chart2.xml').async('string')).replace(/&apos;/g, "'");
    assert.match(second, /<c:lineChart>/);
    assert.match(second, /'My Tab'!\$A\$1/);
    assert.match(await zip.file('xl/worksheets/sheet2.xml').async('string'), /<drawing r:id="rId1"\/>/);
});

test('a Dutch sheet goes to Excel with real numbers and , between arguments', async () => {
    const nlDoc = { ...doc, settings: { sheet: { tabs: [doc.settings.sheet.tabs[0]], locale: 'nl', charts: [
        { id: 'c1', type: 'bar', dataRange: 'B2:B3', anchor: 'E2', width: 320, height: 220 },
    ] } } };
    const nlCells = { async readSheet() { return { cells: { A1: 'Item', B2: '1,5', B3: '€ 10', B4: '=SUM(B2;B3)', B5: '=IF(B4>1;"a;b";"c")', B6: '1,5 kg' } }; } };
    const { buffer } = await buildSheetWorkbook(nlDoc, { cells: nlCells });
    const zip = await JSZip.loadAsync(buffer);
    const s1 = await zip.file('xl/worksheets/sheet1.xml').async('string');
    assert.match(s1, /<c r="B2"><v>1\.5<\/v><\/c>/);
    assert.match(s1, /<c r="B3"><v>10<\/v><\/c>/);
    assert.match(s1, /<f>SUM\(B2,B3\)<\/f>/);
    assert.match(s1, /<f>IF\(B4&gt;1,&quot;a;b&quot;,&quot;c&quot;\)<\/f>/);
    assert.match(s1, /<c r="B6" t="inlineStr">/, 'a number with a unit stays text');
    const chart = await zip.file('xl/charts/chart1.xml').async('string');
    assert.match(chart, /<c:pt idx="1"><c:v>10<\/c:v>/, 'the chart cache computes with the sheet\'s locale');
});

test('an en sheet leaves 1,5 as text', async () => {
    const enCells = { async readSheet() { return { cells: { A1: 'x', B2: '1,5' } }; } };
    const { buffer } = await buildSheetWorkbook({ ...doc, settings: { sheet: { tabs: [doc.settings.sheet.tabs[0]] } } }, { cells: enCells });
    const s1 = await (await JSZip.loadAsync(buffer)).file('xl/worksheets/sheet1.xml').async('string');
    assert.match(s1, /<c r="B2" t="inlineStr">/);
});
