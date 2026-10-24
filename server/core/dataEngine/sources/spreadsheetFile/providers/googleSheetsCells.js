// @typecheck
/**
 * Cell-precise access to a native Google Sheet, for ./googleDrive.js: list
 * the tabs, sample a tab for number formats and formulas, read it with
 * UNFORMATTED_VALUE + SERIAL_NUMBER, and write single rows through
 * batchUpdate with typed ExtendedValues so a cell keeps its own format.
 *
 * Every function takes the drive context `d` that makeApi builds:
 *   { clients(), idOf(file), probe(file), guard(file, ifMatch) }
 */

'use strict';

const { SpreadsheetSourceError } = require('../errors');
const { formatOf } = require('./index');
const {
    ERROR_STRINGS, quoteTab, refOf, translate, readCell, gridCell, extendedValue, rawValue, rowNumberOfRange,
} = require('./googleDriveFormat');

const sheetName = (sheet) => (typeof sheet === 'string' ? sheet : (sheet && sheet.name) || '');

async function listSheets(d, file) {
    const { sheets } = await d.clients();
    let res;
    try {
        res = await sheets.spreadsheets.get({
            spreadsheetId: d.idOf(file),
            fields: 'sheets.properties(sheetId,title,index,hidden,gridProperties(rowCount,columnCount))',
        });
    } catch (e) {
        throw translate(e, 'spreadsheet', file);
    }
    return (res.data.sheets || []).map((s) => {
        const p = s.properties || {};
        return {
            id: p.sheetId != null ? p.sheetId : null,
            name: p.title || '',
            index: p.index || 0,
            rowCount: p.gridProperties && p.gridProperties.rowCount != null ? p.gridProperties.rowCount : null,
            colCount: p.gridProperties && p.gridProperties.columnCount != null ? p.gridProperties.columnCount : null,
            hidden: !!p.hidden,
        };
    });
}

/** The gid a write needs; a sheet given by name alone costs one lookup. */
async function gidOf(d, file, sheet) {
    if (sheet && typeof sheet === 'object' && sheet.id != null) return sheet.id;
    if (sheet && typeof sheet === 'object' && sheet.gid != null) return sheet.gid;
    const name = sheetName(sheet);
    const found = (await listSheets(d, file)).find((s) => s.name === name);
    if (!found) {
        throw new SpreadsheetSourceError(404, 'sheet_missing', `The sheet '${name}' no longer exists in this Google Sheet.`, { ref: { ...refOf(file), sheet: name } });
    }
    return found.id;
}

/** includeGridData rows → the value matrix, the dominant date format per column, and the formula columns. */
function tallyGrid(grid, headerRow) {
    const matrix = [];
    const formatTally = new Map();   // col → { DATE:n, DATE_TIME:n, TIME:n }
    const formulaCols = new Set();
    grid.forEach((r, ri) => {
        const cells = (r && r.values) || [];
        const row = [];
        cells.forEach((c, ci) => {
            const g = gridCell(c);
            row.push(g.value);
            if (ri < headerRow) return;   // header and above: no type evidence
            if (g.formula) formulaCols.add(ci);
            if (g.numberFormatType && /^(DATE|DATE_TIME|TIME)$/.test(g.numberFormatType) && g.value !== null) {
                const t = formatTally.get(ci) || {};
                t[g.numberFormatType] = (t[g.numberFormatType] || 0) + 1;
                formatTally.set(ci, t);
            }
        });
        matrix.push(row);
    });
    const numberFormat = new Map();
    for (const [col, t] of formatTally) {
        const best = Object.entries(t).sort((a, b) => b[1] - a[1])[0];
        numberFormat.set(col, best ? best[0] : null);
    }
    return { rows: matrix, numberFormat, formulaCols };
}

async function sample(d, file, sheet, { headerRow = 1, rows = 500 } = {}) {
    const { sheets } = await d.clients();
    const tab = sheetName(sheet);
    let res;
    try {
        res = await sheets.spreadsheets.get({
            spreadsheetId: d.idOf(file),
            includeGridData: true,
            ranges: [`${quoteTab(tab)}!1:${headerRow + rows}`],
            fields: 'sheets.data.rowData.values(effectiveValue,effectiveFormat.numberFormat.type,userEnteredValue.formulaValue)',
        });
    } catch (e) {
        throw translate(e, `sheet '${tab}'`, file, tab);
    }
    const rowData = (((res.data.sheets || [])[0] || {}).data || [])[0];
    return tallyGrid((rowData && rowData.rowData) || [], headerRow);
}

/** values.get of one A1 range of a tab, typed (UNFORMATTED_VALUE + SERIAL_NUMBER). */
async function getValues(d, file, tab, range) {
    const { sheets } = await d.clients();
    try {
        return await sheets.spreadsheets.values.get({
            spreadsheetId: d.idOf(file),
            range: `${quoteTab(tab)}!${range}`,
            valueRenderOption: 'UNFORMATTED_VALUE',
            dateTimeRenderOption: 'SERIAL_NUMBER',
        });
    } catch (e) {
        throw translate(e, `sheet '${tab}'`, file, tab);
    }
}

/**
 * Rows 1..(headerRow + maxRows) — `maxRows` DATA rows after the header;
 * the engine asks for one more than its cap to learn it was truncated.
 */
async function readSheet(d, file, sheet, { headerRow = 1, maxRows = 10000, maxCols = 100 } = {}) {
    const res = await getValues(d, file, sheetName(sheet), `1:${headerRow + maxRows}`);
    let errorCells = 0;
    const rows = (res.data.values || []).map((r) => (r || []).slice(0, maxCols).map((v) => {
        const out = readCell(v);
        if (out === null && typeof v === 'string' && ERROR_STRINGS.has(v)) errorCells += 1;
        return out;
    }));
    return { rows, errorCells };
}

async function readRow(d, file, sheet, rowNumber) {
    const n = Number(rowNumber);
    const res = await getValues(d, file, sheetName(sheet), `${n}:${n}`);
    return ((res.data.values || [])[0] || []).map(readCell);
}

/** One row of the tab as values.get hands it back (typed): is it empty? */
async function rowIsBlank(d, file, tab, rowNumber) {
    const res = await getValues(d, file, tab, `${rowNumber}:${rowNumber}`);
    const row = ((res.data && res.data.values) || [])[0] || [];
    return row.every((v) => v === null || v === undefined || v === '');
}

async function batchUpdate(d, file, requests, what, sheet) {
    const { sheets } = await d.clients();
    try {
        return await sheets.spreadsheets.batchUpdate({ spreadsheetId: d.idOf(file), requestBody: { requests } });
    } catch (e) {
        throw translate(e, what, file, sheet);
    }
}

/** One typed updateCells request; `fields: 'userEnteredValue'` keeps the cell's format. */
function updateCellRequest(gid, rowNumber, c) {
    return {
        updateCells: {
            start: { sheetId: gid, rowIndex: Number(rowNumber) - 1, columnIndex: Number(c.col) },
            rows: [{ values: [{ userEnteredValue: extendedValue(c.value, c.type) }] }],
            fields: 'userEnteredValue',
        },
    };
}

/**
 * Write the given cells of one row — one updateCells request per cell,
 * typed, `fields: 'userEnteredValue'` so the cell keeps its format.
 * @param {Array<{col:number, value:any, type:string}>} cells
 */
async function updateCells(d, file, sheet, rowNumber, cells, { ifMatch = null } = {}) {
    await d.guard(file, ifMatch);
    const gid = await gidOf(d, file, sheet);
    const requests = (cells || []).map((c) => updateCellRequest(gid, rowNumber, c));
    if (requests.length) await batchUpdate(d, file, requests, 'row', sheet);
    return { marker: (await d.probe(file)).marker };
}

/** The row written in place at `afterRow + 1` (see appendRow). */
async function writeRowAfter(d, file, sheet, cells, afterRow) {
    const tab = sheetName(sheet);
    const gid = await gidOf(d, file, sheet);
    const meta = (await listSheets(d, file)).find((s) => s.id === gid) || null;
    const rowNumber = Number(afterRow) + 1;
    const requests = [];
    const beyondGrid = meta && meta.rowCount != null && rowNumber > meta.rowCount;
    if (beyondGrid) {
        requests.push({ appendDimension: { sheetId: gid, dimension: 'ROWS', length: rowNumber - meta.rowCount } });
    } else if (!(await rowIsBlank(d, file, tab, rowNumber))) {
        requests.push({ insertDimension: { range: { sheetId: gid, dimension: 'ROWS', startIndex: rowNumber - 1, endIndex: rowNumber }, inheritFromBefore: true } });
    }
    for (const c of cells || []) requests.push(updateCellRequest(gid, rowNumber, c));
    if (requests.length) await batchUpdate(d, file, requests, 'row', sheet);
    return rowNumber;
}

/** values.append under RAW, wherever Sheets puts it; the row number it reports. */
async function appendRowAnywhere(d, file, sheet, cells) {
    const tab = sheetName(sheet);
    const { sheets } = await d.clients();
    const width = (cells || []).reduce((m, c) => Math.max(m, Number(c.col) + 1), 0);
    const row = new Array(width).fill(null);
    for (const c of cells || []) row[Number(c.col)] = rawValue(c.value, c.type);
    let res;
    try {
        res = await sheets.spreadsheets.values.append({
            spreadsheetId: d.idOf(file),
            range: `${quoteTab(tab)}!A1`,
            valueInputOption: 'RAW',
            insertDataOption: 'INSERT_ROWS',
            requestBody: { values: [row] },
        });
    } catch (e) {
        throw translate(e, `sheet '${tab}'`, file, tab);
    }
    const rowNumber = rowNumberOfRange(res.data && res.data.updates && res.data.updates.updatedRange);
    if (!rowNumber) {
        throw new SpreadsheetSourceError(503, 'spreadsheet_unavailable', 'Google Sheets did not say where the new row landed.', { ref: refOf(file) });
    }
    return rowNumber;
}

/**
 * Append one row under the engine's last DATA row (`afterRow`), or —
 * when the engine does not know it (a truncated read) — wherever
 * values.append puts it.
 *
 * Not values.append when `afterRow` is known: Sheets takes "the table"
 * to be the contiguous block from the range's corner, so a blank row
 * inside the data ends the table there, INSERT_ROWS lands the new row
 * in that gap and every row under it shifts down — while the engine
 * assumes the row went to the end and keeps `r<n>` for the rows that
 * moved. So the row is written where it belongs, by updateCells at
 * `afterRow + 1` (the grid is grown first when it ends above that: a
 * write past gridProperties.rowCount is a 400). That row is read first
 * and, should it hold anything after all, a row is INSERTED there so
 * nothing is overwritten — the guard makes that near-impossible, and
 * the engine's read of the next pass renumbers what shifted.
 * Date columns then get a DATE / DATE_TIME number format so the serial
 * renders as a date.
 * @returns {Promise<{ rowNumber:number, marker:object }>}
 */
async function appendRow(d, file, sheet, cells, { ifMatch = null, afterRow = null } = {}) {
    await d.guard(file, ifMatch);
    const rowNumber = (afterRow != null && Number.isInteger(Number(afterRow)) && Number(afterRow) >= 0)
        ? await writeRowAfter(d, file, sheet, cells, afterRow)
        : await appendRowAnywhere(d, file, sheet, cells);
    const dateCols = (cells || []).filter((c) => c.type === 'date' || c.type === 'datetime');
    if (dateCols.length) {
        const gid = await gidOf(d, file, sheet);
        await batchUpdate(d, file, dateCols.map((c) => ({
            repeatCell: {
                range: { sheetId: gid, startRowIndex: rowNumber - 1, endRowIndex: rowNumber, startColumnIndex: Number(c.col), endColumnIndex: Number(c.col) + 1 },
                cell: { userEnteredFormat: { numberFormat: c.type === 'datetime' ? { type: 'DATE_TIME', pattern: 'yyyy-mm-dd hh:mm' } : { type: 'DATE', pattern: 'yyyy-mm-dd' } } },
                fields: 'userEnteredFormat.numberFormat',
            },
        })), 'row', sheet);
    }
    return { rowNumber, marker: (await d.probe(file)).marker };
}

async function deleteRow(d, file, sheet, rowNumber, { ifMatch = null } = {}) {
    await d.guard(file, ifMatch);
    const gid = await gidOf(d, file, sheet);
    const n = Number(rowNumber);
    await batchUpdate(d, file, [{
        deleteDimension: { range: { sheetId: gid, dimension: 'ROWS', startIndex: n - 1, endIndex: n } },
    }], 'row', sheet);
    return { marker: (await d.probe(file)).marker };
}

/** The FileApi's `cells` member, bound to one drive context. */
function makeSheetCells(d) {
    return {
        /** Cell-precise access exists for native Sheets only. */
        available: async (file) => (file && (file.format || formatOf(file))) === 'gsheet',
        listSheets: (...a) => listSheets(d, ...a),
        sample: (...a) => sample(d, ...a),
        readSheet: (...a) => readSheet(d, ...a),
        readRow: (...a) => readRow(d, ...a),
        updateCells: (...a) => /** @type {Function} */ (updateCells)(d, ...a),
        appendRow: (...a) => appendRow(d, ...a),
        deleteRow: (...a) => deleteRow(d, ...a),
    };
}

module.exports = { makeSheetCells };
