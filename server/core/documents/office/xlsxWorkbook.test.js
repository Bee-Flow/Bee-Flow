// @typecheck noImplicitAny
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

async function sheetXml(/** @type {unknown} */ sheets, /** @type {unknown} */ opts = undefined) {
    const zip = await JSZip.loadAsync(await buildXlsxWorkbook(sheets, opts));
    return zip.file('xl/worksheets/sheet1.xml')?.async('string');
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

test('characters invalid in XML 1.0 never reach the sheet XML', async () => {
    const bad = 'a\u0000b\u0001c\u000Bd\u000Ce\u001Ff￾g\uD800h\tOK\nOK\r';
    const xml = await sheetXml([{ name: 'S', matrix: [['h'], [bad], [{ formula: 'A1\u0001' }]] }], { formulas: true });
    assert.doesNotMatch(xml, /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/);
    assert.doesNotMatch(xml, /\uD800/);
    assert.match(xml, />abcdefgh\tOK\nOK\r</);
});

test('sheet names follow the Excel rules', async () => {
    const zip = await JSZip.loadAsync(await buildXlsxWorkbook([
        { name: "'Q1'", matrix: [] },
        { name: 'History', matrix: [] },
        { name: 'x'.repeat(40), matrix: [] },
        { name: 'x'.repeat(40), matrix: [] },
        { name: 'a\u0001/b', matrix: [] },
        { name: "''", matrix: [] },
        { name: '', matrix: [] },
    ]));
    const wb = await zip.file('xl/workbook.xml')?.async('string');
    const names = [...wb.matchAll(/<sheet name="([^"]*)"/g)].map((m) => m[1]);
    assert.strictEqual(names.length, 7);
    for (const n of names) {
        assert.ok(n.length > 0 && n.length <= 31, n);
        assert.doesNotMatch(n, /^'|'$|[[\]:*?/\\]/);
        assert.notStrictEqual(n.toLowerCase(), 'history');
    }
    assert.strictEqual(new Set(names.map((n) => n.toLowerCase())).size, 7);
    assert.strictEqual(names[0], 'Q1');
});
