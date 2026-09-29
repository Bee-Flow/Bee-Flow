/**
 * exceljs edits: a round trip keeps number formats, widths, fonts, the other
 * sheet and every untouched formula; dates go in as UTC wall clock whatever
 * the process timezone; an append lands under the last DATA row, not under
 * styled empty rows; a formula cell is never overwritten.
 */
const test = require('node:test');
const assert = require('node:assert');

// A sheet's "15-01-2026" must survive a server in Los Angeles; Node honours a
// TZ set before the first Date is built.
process.env.TZ = 'America/Los_Angeles';

const ExcelJS = require('exceljs');
const XLSX = require('@e965/xlsx');
const { editInPlace, inspect, hasValue } = require('./exceljs');

async function facturen() {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Facturen');
    ws.columns = [{ header: 'Datum', width: 14 }, { header: 'Factuurnummer', width: 18 }, { header: 'Bedrag' }, { header: 'Betaald' }, { header: 'Totaal' }];
    ws.getRow(1).font = { bold: true };
    ws.addRow([new Date(Date.UTC(2026, 0, 15)), 'F-2026-001', 1234.5, true, { formula: 'C2*1.21', result: 1493.745 }]);
    ws.addRow([new Date(Date.UTC(2026, 0, 16)), 'F-2026-002', 10, false, { formula: 'C3*1.21', result: 12.1 }]);
    ws.addRow([new Date(Date.UTC(2026, 0, 17)), 'F-2026-003', 5, true, { formula: 'C4*1.21', result: 6.05 }]);
    for (const r of [2, 3, 4]) {
        ws.getCell(`A${r}`).numFmt = 'dd-mm-yyyy';
        ws.getCell(`C${r}`).numFmt = '[$€-413] #,##0.00';
        ws.getCell(`C${r}`).font = { italic: true };
        ws.getCell(`E${r}`).numFmt = '[$€-413] #,##0.00';
    }
    ws.getCell('B9').numFmt = '0.00%';          // styled, empty, far below the data
    ws.getCell('B9').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
    ws.mergeCells('G1:H1');
    ws.getCell('G1').value = 'Opmerkingen';
    const other = wb.addWorksheet('Leveranciers');
    other.addRow(['Acme', 'Amsterdam']);
    other.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF0000' } };
    other.getColumn(2).width = 33;
    return Buffer.from(await wb.xlsx.writeBuffer());
}

function sheetjsCells(buffer, sheet) {
    const wb = XLSX.read(buffer, { type: 'buffer', cellNF: true, cellDates: false, cellFormula: true, raw: true });
    return wb.Sheets[sheet];
}

test('inspect: the last data row comes from the cells, not from the styled rowCount', async () => {
    const buf = await facturen();
    const i = await inspect(buf, { sheet: 'Facturen', headerRow: 1 });
    assert.equal(i.span, 7);              // up to the last non-empty header cell (G1), F being a blank header
    assert.equal(i.lastDataRow, 4);
    assert.equal(i.rowCount, 9);
});

test('an update, an append and a delete keep formats, widths, fonts, merges, the other sheet and untouched formulas', async () => {
    const buf = await facturen();
    const { buffer, appended, lastDataRow, skipped } = await editInPlace(buf, {
        sheet: 'Facturen', headerRow: 1,
        ops: [
            { op: 'update', row: 2, cells: { 2: 99.5, 3: false, 4: 1 } },                    // 4 = Totaal, a formula → skipped
            { op: 'append', cells: { 0: new Date(Date.UTC(2026, 1, 1)), 1: 'F-2026-004', 2: 7, 3: true } },
            { op: 'delete', row: 3 },
        ],
    });
    assert.deepEqual(appended, [4]);
    assert.equal(lastDataRow, 4);
    assert.deepEqual(skipped, [{ row: 2, col: 4, reason: 'formula' }]);

    const s = sheetjsCells(buffer, 'Facturen');
    assert.equal(s.C2.v, 99.5);
    assert.equal(s.C2.z, '[$€-413] #,##0.00');
    assert.equal(s.D2.v, false);
    assert.equal(s.E2.f, 'C2*1.21');                       // the formula survived the write into E2
    assert.equal(s.B3.v, 'F-2026-003');                    // row 3 was deleted, row 4 moved up
    assert.equal(s.E3.f, 'C4*1.21');                       // exceljs does not rewrite references (documented)
    assert.equal(s.B4.v, 'F-2026-004');                    // the appended row
    assert.equal(s.A4.v, 46054);                            // 2026-02-01 as a serial
    assert.ok(XLSX.SSF.is_date(s.A4.z));                   // inherited the date format of the row above
    assert.equal(s.C4.z, '[$€-413] #,##0.00');             // and the money format
    assert.equal(s.D4.v, true);
    assert.equal(s.E4, undefined);                          // nothing written into the formula column

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.getWorksheet('Facturen');
    assert.equal(ws.getColumn(1).width, 14);
    assert.equal(ws.getColumn(2).width, 18);
    assert.equal(ws.getRow(1).font.bold, true);
    assert.equal(ws.getCell('C2').font.italic, true);
    assert.equal(ws.getCell('C2').numFmt, '[$€-413] #,##0.00');
    assert.equal(ws.getCell('G1').isMerged, true);
    const other = wb.getWorksheet('Leveranciers');
    assert.equal(other.getCell('A1').value, 'Acme');
    assert.equal(other.getCell('A1').fill.fgColor.argb, 'FFFF0000');
    assert.equal(other.getColumn(2).width, 33);
});

test('dates are written as UTC wall clock: the serial is the clock the person typed, in any timezone', async () => {
    // Whatever TZ this runs in, 2026-02-20 13:45:30 must come back as exactly that.
    const buf = await facturen();
    const when = new Date(Date.UTC(2026, 1, 20, 13, 45, 30));
    const { buffer } = await editInPlace(buf, { sheet: 'Facturen', headerRow: 1, ops: [{ op: 'update', row: 2, cells: { 0: when } }] });
    const s = sheetjsCells(buffer, 'Facturen');
    assert.equal(s.A2.z, 'dd-mm-yyyy');                    // the cell's own format kept
    const p = XLSX.SSF.parse_date_code(s.A2.v);
    assert.deepEqual([p.y, p.m, p.d, p.H, p.M, p.S], [2026, 2, 20, 13, 45, 30]);
    assert.equal(require('../cells').serialToIso(s.A2.v), '2026-02-20T13:45:30.000Z');
    assert.notEqual(new Date(2026, 1, 20).getTimezoneOffset(), 0);      // the process really is off UTC
});

test('an append lands under the last data row even when styled empty rows sit below', async () => {
    const buf = await facturen();
    const { buffer, appended } = await editInPlace(buf, { sheet: 'Facturen', headerRow: 1, ops: [{ op: 'append', cells: { 1: 'F-2026-004' } }, { op: 'append', cells: { 1: 'F-2026-005' } }] });
    assert.deepEqual(appended, [5, 6]);
    const s = sheetjsCells(buffer, 'Facturen');
    assert.equal(s.B5.v, 'F-2026-004');
    assert.equal(s.B6.v, 'F-2026-005');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    assert.equal(wb.getWorksheet('Facturen').getCell('B11').numFmt, '0.00%');   // the styled blank cell shifted down, kept
});

test('null clears a cell, a missing sheet and a vanished row are refused, a bad file is rejected', async () => {
    const buf = await facturen();
    const { buffer } = await editInPlace(buf, { sheet: 'Facturen', headerRow: 1, ops: [{ op: 'update', row: 2, cells: { 1: null } }] });
    assert.equal(sheetjsCells(buffer, 'Facturen').B2, undefined);
    await assert.rejects(editInPlace(buf, { sheet: 'Nope', headerRow: 1, ops: [] }), (e) => e.code === 'sheet_missing' && e.status === 404);
    await assert.rejects(editInPlace(buf, { sheet: 'Facturen', headerRow: 1, ops: [{ op: 'update', row: 5, cells: { 1: 'x' } }] }), (e) => e.code === 'spreadsheet_not_found');
    await assert.rejects(editInPlace(buf, { sheet: 'Facturen', headerRow: 1, ops: [{ op: 'update', row: 1, cells: { 1: 'x' } }] }), (e) => e.code === 'spreadsheet_not_found');
    await assert.rejects(editInPlace(buf, { sheet: 'Facturen', headerRow: 1, ops: [{ op: 'update', row: 2, cells: { 9: 'x' } }] }), (e) => e.code === 'unknown_field');
    await assert.rejects(editInPlace(buf, { sheet: 'Facturen', headerRow: 7, ops: [] }), (e) => e.code === 'header_missing');
    await assert.rejects(editInPlace(Buffer.from('not a workbook'), { sheet: null, headerRow: 1, ops: [] }), (e) => e.code === 'spreadsheet_rejected');
    // the first sheet is the default
    const first = await editInPlace(buf, { headerRow: 1, ops: [{ op: 'update', row: 2, cells: { 1: 'F-X' } }] });
    assert.equal(sheetjsCells(first.buffer, 'Facturen').B2.v, 'F-X');
});

test('hasValue knows rich text, formulas and empties', () => {
    assert.equal(hasValue({ value: null }), false);
    assert.equal(hasValue({ value: '' }), false);
    assert.equal(hasValue({ value: 0 }), true);
    assert.equal(hasValue({ value: { richText: [{ text: '' }] } }), false);
    assert.equal(hasValue({ value: { richText: [{ text: 'x' }] } }), true);
    assert.equal(hasValue({ value: { formula: 'A1', result: null } }), true);
    assert.equal(hasValue({ value: new Date() }), true);
});
