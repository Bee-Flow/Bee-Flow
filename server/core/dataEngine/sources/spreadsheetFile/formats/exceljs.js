/**
 * EDITING an .xlsx in place with exceljs — the one library that loads a
 * workbook, lets a few cells change and writes it back with the rest intact:
 * cell styles, fonts, fills, borders, number formats, column widths, row
 * heights, merges, defined names, data validations, most conditional formats,
 * the other sheets and every formula (with its cached result). What it loses
 * — charts, pivot tables, slicers, some images, VBA — is why .xlsm is
 * read-only (a macro workbook written by exceljs is invalid under its own
 * extension) and why the panel tells the owner what a write-through keeps.
 *
 * Three rules keep the file honest:
 *   • a cell that holds a FORMULA is never written — its column is derived
 *     (read-only) for the mirror, and a literal over a formula would freeze
 *     someone's totals; such a write is skipped and reported;
 *   • a date goes in as a UTC wall-clock `Date` (cells.js explains the
 *     convention): exceljs serialises from `getTime()`, so the serial is the
 *     exact wall clock wherever the server runs, and an existing date number
 *     format on the cell is kept;
 *   • an append lands at `lastDataRow + 1`, where lastDataRow is the highest
 *     row with a value inside the header's column span, computed from the
 *     cells — NOT `ws.rowCount`, which counts styled-but-empty rows and would
 *     drop new rows under a run of blank formatted lines. `insertRow(…, 'i')`
 *     inherits the style of the row above, so number formats and borders
 *     carry over to the new row.
 * Formula references are NOT shifted by an insert or a delete (exceljs does
 * not rewrite them); the UI warning says so.
 *
 * exceljs is required lazily: it is ~22 MB of code that only a write-through
 * on an xlsx needs.
 */

'use strict';

const { SpreadsheetSourceError } = require('../errors');
const { headerText } = require('../columns');

let ExcelJSModule = null;
function loadExcelJs() {
    if (!ExcelJSModule) ExcelJSModule = require('exceljs');
    return ExcelJSModule;
}

/** A merged range is ONE cell (its master); exceljs echoes the value into the others. */
function isMergedSlave(cell) {
    return !!cell && cell.isMerged === true && !!cell.master && cell.master.address !== cell.address;
}

/** Is there anything in this cell a person would call a value? */
function hasValue(cell) {
    if (isMergedSlave(cell)) return false;
    const v = cell && cell.value;
    if (v === null || v === undefined || v === '') return false;
    if (typeof v === 'object' && !(v instanceof Date)) {
        if ('richText' in v) return v.richText.some(t => t && t.text);
        if ('formula' in v || 'sharedFormula' in v) return true;
        if ('text' in v) return !!v.text;
        if ('result' in v) return v.result !== null && v.result !== undefined;
        return true;
    }
    return true;
}

function isFormulaCell(ExcelJS, cell) {
    if (!cell) return false;
    if (cell.type === ExcelJS.ValueType.Formula) return true;
    const v = cell.value;
    return !!v && typeof v === 'object' && ('formula' in v || 'sharedFormula' in v);
}

/** The header's column span: 1..last non-empty header cell. */
function headerSpan(ws, headerRow) {
    let span = 0;
    ws.getRow(headerRow).eachCell({ includeEmpty: false }, (cell, col) => {
        if (isMergedSlave(cell)) return;
        const text = headerText(cell.value && typeof cell.value === 'object' && 'richText' in cell.value
            ? cell.value.richText.map(t => t.text).join('') : cell.value);
        if (text !== '') span = Math.max(span, col);
    });
    return span;
}

/** The highest row with a value inside the header's span (the header row when there is none). */
function lastDataRowOf(ws, headerRow, span) {
    let last = headerRow;
    ws.eachRow({ includeEmpty: false }, (row, n) => {
        if (n <= headerRow) return;
        for (let c = 1; c <= span; c += 1) {
            if (hasValue(row.getCell(c))) { last = n; return; }
        }
    });
    return last;
}

function pickWorksheet(wb, sheet) {
    const sheets = wb.worksheets || [];
    if (!sheets.length) throw new SpreadsheetSourceError(404, 'sheet_missing', 'The workbook has no worksheets.');
    if (sheet === undefined || sheet === null || sheet === '') return sheets[0];
    if (typeof sheet === 'number') {
        if (!sheets[sheet]) throw new SpreadsheetSourceError(404, 'sheet_missing', `The workbook has no worksheet #${sheet + 1}.`);
        return sheets[sheet];
    }
    const ws = wb.getWorksheet(String(sheet));
    if (!ws) {
        throw new SpreadsheetSourceError(404, 'sheet_missing',
            `The workbook has no worksheet called "${sheet}" any more.`, { ref: { sheet: String(sheet) } });
    }
    return ws;
}

/** The write codec's output as exceljs wants it. */
function cellValueFor(value) {
    if (value === null || value === undefined || value === '') return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return value;
    return String(value);
}

/**
 * Apply row edits to an xlsx and give back the whole file.
 *
 * Ops (row numbers are 1-based sheet rows, as Excel shows them):
 *   { op:'update', row, cells:{ [col]: value } }     col is 0-based
 *   { op:'append', cells:{ [col]: value } }          → lands at lastDataRow + 1
 *   { op:'delete', row }
 * Updates are applied first, then deletes highest row first (so every row
 * number in the batch still refers to the file as it was read), then
 * appends at the new end.
 *
 * @returns {Promise<{ buffer:Buffer, appended:number[], lastDataRow:number, skipped:Array<{row,col,reason}> }>}
 */
async function editInPlace(buffer, { sheet, headerRow = 1, ops = [] }) {
    const ExcelJS = loadExcelJs();
    const h = Math.max(1, Number(headerRow) || 1);
    const wb = new ExcelJS.Workbook();
    try {
        await wb.xlsx.load(buffer);
    } catch (e) {
        throw new SpreadsheetSourceError(422, 'spreadsheet_rejected',
            `The .xlsx file could not be opened for editing: ${String(e && e.message || e).slice(0, 120)}`);
    }
    const ws = pickWorksheet(wb, sheet);
    const span = headerSpan(ws, h);
    if (!span) {
        throw new SpreadsheetSourceError(422, 'header_missing',
            `Worksheet "${ws.name}" has no header row there any more.`, { ref: { sheet: ws.name } });
    }
    let lastDataRow = lastDataRowOf(ws, h, span);
    const skipped = [];
    const list = Array.isArray(ops) ? ops : [];

    const assertRow = (row) => {
        const n = Number(row);
        if (!Number.isInteger(n) || n <= h || n > lastDataRow) {
            throw new SpreadsheetSourceError(404, 'spreadsheet_not_found', `Row ${row} is no longer in the sheet.`);
        }
        return n;
    };
    const setCells = (row, n, cellsByCol) => {
        for (const [colKey, value] of Object.entries(cellsByCol || {})) {
            const col = Number(colKey);
            if (!Number.isInteger(col) || col < 0 || col >= span) {
                throw new SpreadsheetSourceError(400, 'unknown_field', `Column ${colKey} is outside the header.`);
            }
            const cell = row.getCell(col + 1);
            if (isFormulaCell(ExcelJS, cell)) { skipped.push({ row: n, col, reason: 'formula' }); continue; }
            cell.value = cellValueFor(value);
        }
    };

    for (const op of list.filter(o => o && o.op === 'update')) {
        const n = assertRow(op.row);
        setCells(ws.getRow(n), n, op.cells);
    }

    const deletes = list.filter(o => o && o.op === 'delete').map(o => assertRow(o.row)).sort((a, b) => b - a);
    for (const n of deletes) {
        ws.spliceRows(n, 1);
        lastDataRow -= 1;
    }

    const appended = [];
    for (const op of list.filter(o => o && o.op === 'append')) {
        const n = lastDataRow + 1;
        const values = new Array(span).fill(null);
        ws.insertRow(n, values, 'i');
        setCells(ws.getRow(n), n, op.cells);
        appended.push(n);
        lastDataRow = n;
    }

    const out = Buffer.from(await wb.xlsx.writeBuffer());
    return { buffer: out, appended, lastDataRow, skipped };
}

/** The header span and last data row of a sheet, for a writer that must verify before it edits. */
async function inspect(buffer, { sheet, headerRow = 1 }) {
    const ExcelJS = loadExcelJs();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = pickWorksheet(wb, sheet);
    const h = Math.max(1, Number(headerRow) || 1);
    const span = headerSpan(ws, h);
    return { sheet: ws.name, span, lastDataRow: lastDataRowOf(ws, h, span), rowCount: ws.rowCount };
}

module.exports = { editInPlace, inspect, loadExcelJs, hasValue, lastDataRowOf, headerSpan };
