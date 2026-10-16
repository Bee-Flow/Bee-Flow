/**
 * Cell values in the .xlsx writer: text is text, a formula is only what the
 * caller marks as one ({ formula }).
 *
 * Run: node --test core/documents/office/xlsxWorkbook.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const JSZip = require('jszip');
const { buildXlsxWorkbook } = require('./xlsxWorkbook');
const { rowsToMatrix } = require('./officegen');

async function sheetXml(sheets, opts) {
    const zip = await JSZip.loadAsync(await buildXlsxWorkbook(sheets, opts));
    return zip.file('xl/worksheets/sheet1.xml').async('string');
}

test('text starting with = + - @ tab or CR is written as a text cell', async () => {
    const xml = await sheetXml([{ name: 'S', matrix: [['h'], ['=1+1'], ['+SUM(A1)'], ['@A1'], ['\t=1'], ['\r=1'], ['-cmd']] }], { formulas: true });
    assert.strictEqual((xml.match(/<f>/g) || []).length, 0);
    assert.strictEqual((xml.match(/t="inlineStr"/g) || []).length, 7);
    assert.match(xml, />=1\+1</);
});

test('a { formula } cell is a formula, only when formulas is on', async () => {
    const matrix = [['h'], [{ formula: '=SUM(A1:A1)' }], [{ formula: 'A1*2' }], [{ formula: '  ' }]];
    const on = await sheetXml([{ name: 'S', matrix }], { formulas: true });
    assert.match(on, /<c r="A2"><f>SUM\(A1:A1\)<\/f><\/c>/);
    assert.match(on, /<c r="A3"><f>A1\*2<\/f><\/c>/);
    assert.doesNotMatch(on, /r="A4"><f>/);
    const off = await sheetXml([{ name: 'S', matrix }]);
    assert.strictEqual((off.match(/<f>/g) || []).length, 0);
});

test('rowsToMatrix keeps a { formula } cell only on request', () => {
    const rows = [['x', { formula: '=A1' }]];
    assert.deepStrictEqual(rowsToMatrix(rows, null, { keepFormulas: true }), [['x', { formula: '=A1' }]]);
    assert.deepStrictEqual(rowsToMatrix(rows), [['x', JSON.stringify({ formula: '=A1' })]]);
});
