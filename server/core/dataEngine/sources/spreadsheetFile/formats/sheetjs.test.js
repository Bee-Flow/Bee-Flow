/**
 * SheetJS reads: dates come back as wall-clock Dates under any timezone, raw
 * text stays text, formulas flag their column, the sheetRows cap holds, xls
 * and ods parse, a non-ZIP .xlsx is refused — and the formats/ door caps,
 * dispatches and limits.
 */
const test = require('node:test');
const assert = require('node:assert');

// A sheet's "15-01-2026" must survive a server in Los Angeles.
process.env.TZ = 'America/Los_Angeles';

const ExcelJS = require('exceljs');
const XLSX = require('@e965/xlsx');
const sheetjs = require('./sheetjs');
const formats = require('./index');

async function facturenXlsx({ rows = 3 } = {}) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Facturen');
    ws.addRow(['Datum', 'Factuurnummer', 'Bedrag', 'Betaald', 'Totaal', 'Tijdstip']);
    for (let i = 0; i < rows; i += 1) {
        const r = ws.addRow([new Date(Date.UTC(2026, 0, 15 + i)), `0${123 + i}`, 1234.5 + i, i % 2 === 0, { formula: `C${i + 2}*2`, result: (1234.5 + i) * 2 }, new Date(Date.UTC(2026, 0, 15 + i, 13, 45, 30))]);
        r.getCell(1).numFmt = 'dd-mm-yyyy';
        r.getCell(3).numFmt = '[$€-413] #,##0.00';
        r.getCell(6).numFmt = 'yyyy-mm-dd hh:mm';
    }
    const hidden = wb.addWorksheet('Verborgen');
    hidden.state = 'hidden';
    hidden.addRow(['x']);
    return Buffer.from(await wb.xlsx.writeBuffer());
}

test('listSheets: names, order, hidden flag and extents', async () => {
    const buf = await facturenXlsx();
    const sheets = await sheetjs.listSheets(buf, 'xlsx');
    assert.deepEqual(sheets, [
        { name: 'Facturen', index: 0, hidden: false, rows: 4, cols: 6 },
        { name: 'Verborgen', index: 1, hidden: true, rows: 1, cols: 1 },
    ]);
});

test('readSheet: dates as wall-clock Dates (no TZ skew), raw text kept, formulas flag the column, number formats reported', async () => {
    assert.notEqual(new Date(2026, 0, 15).getTimezoneOffset(), 0);   // the process really is in Los Angeles
    const buf = await facturenXlsx();
    const r = await sheetjs.readSheet(buf, { format: 'xlsx', sheet: 'Facturen', headerRow: 1, maxRows: 100, maxCols: 100 });
    assert.equal(r.sheet, 'Facturen');
    assert.deepEqual(r.header, ['Datum', 'Factuurnummer', 'Bedrag', 'Betaald', 'Totaal', 'Tijdstip']);
    assert.equal(r.rows.length, 3);
    assert.deepEqual(r.rowNumbers, [2, 3, 4]);
    const [d, nr, amount, paid, total, when] = r.rows[0];
    assert.ok(d instanceof Date);
    assert.equal(d.toISOString(), '2026-01-15T00:00:00.000Z');
    assert.equal(when.toISOString(), '2026-01-15T13:45:30.000Z');
    assert.strictEqual(nr, '0123');
    assert.strictEqual(amount, 1234.5);
    assert.strictEqual(paid, true);
    assert.strictEqual(r.rows[1][3], false);
    assert.strictEqual(total, 2469);
    assert.deepEqual([...r.formulaCols], [4]);
    assert.deepEqual([...r.dateCols].sort(), [0, 5]);
    assert.equal(r.numFmts.get(0), 'dd-mm-yyyy');
    assert.equal(r.numFmts.get(2), '[$€-413] #,##0.00');
    assert.equal(r.numFmts.get(5), 'yyyy-mm-dd hh:mm');
    assert.equal(r.lastDataRow, 4);
    assert.equal(r.truncated, false);
    assert.deepEqual(r.warnings, []);
});

test('readSheet: the sheetRows cap stops the parse and sets truncated; the sheet is otherwise unread', async () => {
    const buf = await facturenXlsx({ rows: 200 });
    const r = await sheetjs.readSheet(buf, { format: 'xlsx', sheet: 'Facturen', headerRow: 1, maxRows: 10, maxCols: 100 });
    assert.equal(r.rows.length, 10);
    assert.equal(r.truncated, true);
    assert.equal(r.lastDataRow, 11);
    assert.deepEqual(r.rowNumbers, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const exact = await sheetjs.readSheet(buf, { format: 'xlsx', sheet: 'Facturen', headerRow: 1, maxRows: 200, maxCols: 100 });
    assert.equal(exact.rows.length, 200);
    assert.equal(exact.truncated, false);
});

test('readSheet: header row 2, blank rows dropped, blank header cells kept as null, cells beyond the header ignored', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Data');
    ws.addRow(['Titel van het overzicht']);
    ws.addRow(['A', null, 'C', null, null, 'extra']);
    ws.addRow([1, 2, 3, null, null, null, 'beyond']);
    ws.addRow([]);
    ws.addRow([null, null, null]);
    ws.addRow([4, null, 6]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const r = await sheetjs.readSheet(buf, { format: 'xlsx', headerRow: 2, maxRows: 100, maxCols: 100 });
    assert.deepEqual(r.header, ['A', null, 'C', null, null, 'extra']);
    assert.deepEqual(r.rows, [[1, 2, 3, null, null, null], [4, null, 6, null, null, null]]);
    assert.deepEqual(r.rowNumbers, [3, 6]);
    assert.equal(r.lastDataRow, 6);
    assert.match(r.warnings[0], /right of the last header column \(6\)/);
    const capped = await sheetjs.readSheet(buf, { format: 'xlsx', headerRow: 2, maxRows: 100, maxCols: 2 });
    assert.deepEqual(capped.header, ['A', null]);
    assert.match(capped.warnings[0], /first 2 of 6/);
});

test('readSheet: a missing sheet, a blank header row and a non-ZIP .xlsx are refused with the right codes', async () => {
    const buf = await facturenXlsx();
    await assert.rejects(sheetjs.readSheet(buf, { format: 'xlsx', sheet: 'Nope', headerRow: 1, maxRows: 10, maxCols: 10 }), (e) => {
        assert.equal(e.code, 'sheet_missing'); assert.equal(e.status, 404); assert.deepEqual(e.ref, { sheet: 'Nope' }); return true;
    });
    await assert.rejects(sheetjs.readSheet(buf, { format: 'xlsx', sheet: 'Facturen', headerRow: 40, maxRows: 10, maxCols: 10 }), (e) => e.code === 'header_missing' && e.status === 422);
    await assert.rejects(sheetjs.readSheet(Buffer.from('Naam;Bedrag\nA;1\n'), { format: 'xlsx', headerRow: 1, maxRows: 10, maxCols: 10 }), (e) => e.code === 'format_unsupported' && e.status === 415);
    await assert.rejects(sheetjs.readSheet(Buffer.from('<html><table><tr><td>1</td></tr></table></html>'), { format: 'xls', headerRow: 1, maxRows: 10, maxCols: 10 }), (e) => e.code === 'format_unsupported');
    await assert.rejects(sheetjs.listSheets(Buffer.from('PK\x03\x04 but not really a zip'), 'xlsx'), (e) => e.code === 'spreadsheet_rejected');
    // a sheet by index and the first sheet by default
    assert.equal((await sheetjs.readSheet(buf, { format: 'xlsx', sheet: 1, headerRow: 1, maxRows: 10, maxCols: 10 })).sheet, 'Verborgen');
    assert.equal((await sheetjs.readSheet(buf, { format: 'xlsx', headerRow: 1, maxRows: 10, maxCols: 10 })).sheet, 'Facturen');
});

test('xls and ods parse through the same reader, dates included', async () => {
    const src = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([['Datum', 'Naam', 'Bedrag'], [46037, 'Acme', 12.5], [46038, 'Beta', 7]]);
    ws.A2.z = 'dd/mm/yyyy'; ws.A3.z = 'dd/mm/yyyy';
    XLSX.utils.book_append_sheet(src, ws, 'Blad1');
    for (const bookType of ['xls', 'ods']) {
        const buf = XLSX.write(src, { type: 'buffer', bookType });
        const r = await sheetjs.readSheet(buf, { format: bookType, sheet: 'Blad1', headerRow: 1, maxRows: 10, maxCols: 10 });
        assert.deepEqual(r.header, ['Datum', 'Naam', 'Bedrag'], bookType);
        assert.equal(r.rows[0][0].toISOString(), '2026-01-15T00:00:00.000Z', bookType);
        assert.equal(r.rows[1][1], 'Beta', bookType);
        assert.equal(r.rows[1][2], 7, bookType);
        assert.deepEqual([...r.dateCols], [0], bookType);
        const sheets = await sheetjs.listSheets(buf, bookType);
        assert.equal(sheets[0].name, 'Blad1', bookType);
    }
    // the smallest ODS this product itself writes (no styles.xml) reads too
    const { buildSpreadsheet } = require('../../../../../integrations/officegen');
    const { buffer } = await buildSpreadsheet({ matrix: [['a', 'b'], [1, 'x']], sheetName: 'Blad1', format: 'ods' });
    const r = await sheetjs.readSheet(buffer, { format: 'ods', headerRow: 1, maxRows: 10, maxCols: 10 });
    assert.deepEqual(r.rows, [[1, 'x']]);
    assert.equal(sheetjs.isZipPackage(buffer), true);
    assert.equal(sheetjs.isCfbPackage(XLSX.write(src, { type: 'buffer', bookType: 'xls' })), true);
});

test('cellValue: error cells and blanks are null, booleans are booleans', () => {
    assert.equal(sheetjs.cellValue({ t: 'e', v: 7, w: '#DIV/0!' }), null);
    assert.equal(sheetjs.cellValue({ t: 'z' }), null);
    assert.equal(sheetjs.cellValue(undefined), null);
    assert.strictEqual(sheetjs.cellValue({ t: 'b', v: 1 }), true);
    assert.strictEqual(sheetjs.cellValue({ t: 's', v: '0123' }), '0123');
    assert.strictEqual(sheetjs.cellValue({ t: 'n', v: 12.5, z: '0.00' }), 12.5);
    assert.equal(sheetjs.cellValue({ t: 'n', v: 46037, z: 'm/d/yy' }).toISOString(), '2026-01-15T00:00:00.000Z');
});

test('the formats door: caps, dispatch by format, read-only reasons, csv sheets', async () => {
    assert.equal(formats.MAX_FILE_BYTES, 20 * 1024 * 1024);
    assert.equal(formats.MAX_COLS, 100);
    assert.equal(formats.MAX_ROWS, 10_000);
    assert.equal(formats.MAX_CELLS, 1_000_000);
    assert.equal(formats.PARSE_CONCURRENCY, 2);
    assert.deepEqual([...formats.READ_FORMATS], ['xlsx', 'xlsm', 'xls', 'csv', 'ods']);
    assert.deepEqual([...formats.EDIT_FORMATS], ['xlsx', 'csv']);
    const buf = await facturenXlsx();
    const r = await formats.readSheet(buf, { format: 'xlsx', sheet: 'Facturen' });
    assert.equal(r.rows.length, 3);
    const c = await formats.readSheet(Buffer.from('A;B\n1;2\n'), { format: 'csv' });
    assert.deepEqual(c.rows, [['1', '2']]);
    assert.deepEqual(await formats.listSheets(Buffer.from('A;B\n1;2\n\n'), 'csv'), [{ name: null, index: 0, hidden: false, rows: 3, cols: 2 }]);
    await assert.rejects(formats.readSheet(buf, { format: 'gsheet' }), (e) => e.code === 'format_unsupported' && e.status === 415);
    await assert.rejects(formats.readSheet(buf, { format: 'xlsx', headerRow: 51 }), (e) => e.code === 'spreadsheet_rejected');
    await assert.rejects(formats.readSheet(Buffer.alloc(formats.MAX_FILE_BYTES + 1), { format: 'xlsx' }), (e) => e.code === 'spreadsheet_too_large' && e.status === 413);
    for (const format of ['xls', 'ods', 'xlsm']) {
        await assert.rejects(formats.editInPlace(buf, { format, ops: [] }), (e) => {
            assert.equal(e.code, 'spreadsheet_write_unsupported'); assert.equal(e.status, 409); assert.equal(e.reason, format); return true;
        });
    }
    assert.equal(formats.canEdit('xlsx'), true);
    assert.equal(formats.canEdit('ods'), false);
    const edited = await formats.editInPlace(buf, { format: 'xlsx', sheet: 'Facturen', ops: [{ op: 'update', row: 2, cells: { 1: 'F-1' } }] });
    assert.equal((await formats.readSheet(edited.buffer, { format: 'xlsx' })).rows[0][1], 'F-1');
});

test('the formats door lets at most two parses run at once', async () => {
    const states = [];
    let release;
    const gate = new Promise((res) => { release = res; });
    const slow = () => formats.withSlot(async () => { states.push(formats.limiterState()); await gate; });
    const a = slow(); const b = slow(); const c = slow();
    await new Promise((res) => setImmediate(res));
    assert.equal(states.length, 2);
    assert.deepEqual(formats.limiterState(), { inFlight: 2, waiting: 1, limit: 2 });
    release();
    await Promise.all([a, b, c]);
    assert.equal(states.length, 3);
    assert.deepEqual(formats.limiterState(), { inFlight: 0, waiting: 0, limit: 2 });
    // a failing parse frees its slot
    await assert.rejects(formats.withSlot(() => { throw new Error('boom'); }), /boom/);
    assert.equal(formats.limiterState().inFlight, 0);
});

test('readSheet: a formula column whose every cached result is an error is still flagged as a formula column (a write into it would be dropped)', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Blad1');
    ws.addRow(['Nr', 'Bedrag', 'Per stuk']);
    ws.addRow(['A', 10, { formula: 'B2/0', result: { error: '#DIV/0!' } }]);
    ws.addRow(['B', 20, { formula: 'B3/0', result: { error: '#DIV/0!' } }]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const r = await sheetjs.readSheet(buf, { format: 'xlsx', headerRow: 1, maxRows: 100, maxCols: 100 });
    assert.deepEqual([...r.formulaCols], [2]);
    assert.deepEqual(r.rows, [['A', 10, null], ['B', 20, null]], 'the error values read as empty, as before');
});
