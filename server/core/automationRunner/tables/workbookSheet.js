// @typecheck strict
/**
 * One sheet (or one CSV) into a table: header row, columns, rows. The parsers
 * (SheetJS, the CSV reader) have already run; this reads what they produced
 * with OUR caps, not the 10 000 row / 100 column clamp of the spreadsheet
 * mirror's door.
 *
 * Every cap that is hit is loud: a sheet that is too long or too wide throws
 * with errorClass 'table_too_large' / 'table_too_many_columns' and a sentence
 * naming the cap and the environment variable. Nothing is truncated silently.
 * Messages name sheets and caps, never a cell value.
 */

'use strict';

const { sourceError } = require('./workbookZipGuard');
const C = require('./workbookColumns');
const { columnLetter } = require('../../dataEngine/sources/spreadsheetFile/columns');

const YIELD_EVERY = 4096;
const PROVENANCE_PAIRS = 200;
const PROVENANCE_KEY_CHARS = 100;
const PROVENANCE_VALUE_CHARS = 500;
const PROVENANCE_SCAN_ROWS = 5000;

const tick = () => new Promise(resolve => setImmediate(resolve));

/**
 * @param {string} where
 * @param {number} cap
 */
function tooManyRows(where, cap) {
    return sourceError('table_too_large',
        `${where} has more than ${cap.toLocaleString('en-US')} rows, which is more than this server reads into one table. `
        + 'An administrator can raise the limit with AUTOMATION_TABLE_MAX_ROWS (0 = unlimited).');
}

/**
 * @param {string} where
 * @param {number} cap
 */
function tooManyColumns(where, cap) {
    return sourceError('table_too_many_columns',
        `${where} has more than ${cap.toLocaleString('en-US')} columns, which is more than this server reads into one table. `
        + 'An administrator can raise the limit with AUTOMATION_TABLE_MAX_COLUMNS (0 = unlimited).');
}

/** The last column that holds a cell of the sheet (a scan of the cells, not of the grid).
 * @param {import('@e965/xlsx').WorkSheet} ws
 * @param {typeof import('@e965/xlsx')} XLSX
 */
function usedWidth(ws, XLSX) {
    let max = -1;
    for (const key in ws) {
        if (key.charCodeAt(0) === 33) continue;                 // '!ref', '!merges', …
        const { c } = XLSX.utils.decode_cell(key);
        if (c > max) max = c;
    }
    return max + 1;
}

/**
 * The kept columns of a sheet and its rows as objects, built from arrays of values.
 * @param {unknown[]} headerCells
 * @param {number} width
 * @param {unknown[]} valueRows  arrays of values; each is replaced in place by its row object
 * @param {ArrayLike<number>} masks
 */
function finishTable(headerCells, width, valueRows, masks) {
    const { keys, labels } = C.headerKeys(headerCells, width);
    /** @type {number[]} */
    const keep = [];
    for (let c = 0; c < width; c += 1) if (C.hasHeaderText(headerCells[c]) || masks[c] !== 0) keep.push(c);
    if (!keep.length) return null;
    const columns = C.buildColumns(keep.map(c => keys[c]), keep.map(c => labels[c]), keep.map(c => masks[c]));
    const rows = valueRows;
    for (let i = 0; i < rows.length; i += 1) {
        const vals = /** @type {unknown[]} */ (rows[i]);
        /** @type {Record<string, unknown>} */
        const obj = {};
        for (let j = 0; j < keep.length; j += 1) {
            const v = vals[keep[j]];
            obj[columns[j].key] = v === undefined ? null : v;
        }
        rows[i] = obj;
    }
    return { columns, rows };
}

/**
 * A SheetJS worksheet as a table, or null when it has no header and no data.
 *
 * @param {import('@e965/xlsx').WorkSheet} ws  a SheetJS worksheet
 * @param {{ XLSX: any, cellValue: (cell: any) => any, name: string, headerRow: number, limits: any }} o
 * @returns {Promise<{ columns: any[], rows: any[] } | null>}
 */
async function readGridSheet(ws, { XLSX, cellValue, name, headerRow, limits }) {
    const ref = ws && ws['!ref'];
    if (!ref) return null;
    const range = XLSX.utils.decode_range(ref);
    const where = `Sheet "${name}"`;
    // SheetJS keeps the whole extent in !fullref when sheetRows cut the parse short.
    const cutShort = !!ws['!fullref'] && XLSX.utils.decode_range(ws['!fullref']).e.r > range.e.r;
    if (cutShort && limits.maxRows > 0) throw tooManyRows(where, limits.maxRows);

    let width = range.e.c + 1;
    if (limits.maxColumns > 0 && width > limits.maxColumns) {
        // A formatted-but-empty extent is not a wide sheet: count the cells that exist.
        width = usedWidth(ws, XLSX);
        if (width > limits.maxColumns) throw tooManyColumns(where, limits.maxColumns);
    }
    const letters = Array.from({ length: width }, (_, c) => columnLetter(c));
    /**
     * @param {number} r
     * @param {number} c
     */
    const at = (r, c) => ws[`${letters[c]}${r + 1}`];

    const hr = headerRow - 1;
    const headerCells = [];
    for (let c = 0; c < width; c += 1) headerCells[c] = hr <= range.e.r ? cellValue(at(hr, c)) : null;

    const masks = new Uint8Array(width);
    const valueRows = [];
    for (let r = headerRow; r <= range.e.r; r += 1) {
        const vals = new Array(width).fill(null);
        let any = false;
        for (let c = 0; c < width; c += 1) {
            const cell = at(r, c);
            if (!cell) continue;
            const { value, kind } = C.scalarOf(cellValue(cell));
            if (!kind) continue;
            vals[c] = value;
            masks[c] |= kind;
            any = true;
        }
        if (!any) continue;
        valueRows.push(vals);
        if (limits.maxRows > 0 && valueRows.length > limits.maxRows) throw tooManyRows(where, limits.maxRows);
        if (r % YIELD_EVERY === 0) await tick();
    }
    return finishTable(headerCells, width, valueRows, masks);
}

/**
 * The key/value pairs of a provenance sheet: its first two columns, all rows.
 * At most 200 pairs, keys cut to 100 characters, values to 500.
 *
 * @param {import('@e965/xlsx').WorkSheet} ws
 * @param {{ XLSX: any, cellValue: (cell: any) => any }} o
 * @returns {Record<string, string> | null}
 */
function readProvenanceSheet(ws, { XLSX, cellValue }) {
    const ref = ws && ws['!ref'];
    if (!ref) return null;
    const range = XLSX.utils.decode_range(ref);
    const out = /** @type {Record<string, string>} */ (Object.create(null));
    let count = 0;
    const last = Math.min(range.e.r, PROVENANCE_SCAN_ROWS - 1);
    for (let r = 0; r <= last && count < PROVENANCE_PAIRS; r += 1) {
        const key = C.headerLabel(cellValue(ws[`A${r + 1}`])).slice(0, PROVENANCE_KEY_CHARS);
        if (!key || Object.prototype.hasOwnProperty.call(out, key)) continue;
        const { value } = C.scalarOf(cellValue(ws[`B${r + 1}`]));
        out[key] = value === null ? '' : String(value).slice(0, PROVENANCE_VALUE_CHARS);
        count += 1;
    }
    return count ? { ...out } : null;
}

/**
 * The widest filled field of the data records, and of the header, as a column count.
 * @param {Array<{ fields: string[] }>} records
 * @param {number} headerIndex
 */
function csvWidth(records, headerIndex) {
    let width = 0;
    for (let i = headerIndex; i < records.length; i += 1) {
        const f = records[i].fields;
        for (let c = f.length - 1; c >= width; c -= 1) {
            if (f[c].trim() !== '') { width = c + 1; break; }
        }
    }
    return width;
}

/**
 * A CSV as a table, or null when it has no header and no data.
 *
 * @param {Buffer} buffer
 * @param {{ csv: typeof import('../../dataEngine/sources/spreadsheetFile/formats/csv'), name: string, headerRow: number, delimiter: string, limits: any }} o
 * @returns {Promise<{ columns: any[], rows: any[] } | null>}
 */
async function readCsvTable(buffer, { csv, name, headerRow, delimiter, limits }) {
    const { text } = csv.decode(buffer);
    const delim = delimiter && delimiter !== 'auto' ? delimiter : csv.sniffDelimiter(text);
    const maxRecords = limits.maxRows > 0 ? headerRow + limits.maxRows + 1 : Infinity;
    const maxCells = limits.maxRows > 0 && limits.maxColumns > 0 ? maxRecords * limits.maxColumns : Infinity;
    const { records, truncated } = csv.parseRecords(text, delim, { maxRecords, maxCells });
    const where = `The file "${name}"`;
    if (truncated && limits.maxRows > 0) {
        throw sourceError('table_too_large',
            `${where} has more rows or cells than this server reads into one table (${limits.maxRows.toLocaleString('en-US')} rows). `
            + 'An administrator can raise the limits with AUTOMATION_TABLE_MAX_ROWS and AUTOMATION_TABLE_MAX_COLUMNS (0 = unlimited).');
    }
    const header = records[headerRow - 1];
    const dataRecords = records.slice(headerRow);
    if (!header && !dataRecords.length) return null;
    const headerFields = header ? header.fields.map(f => csv.unprefixField(f)) : [];
    let lastHeader = -1;
    headerFields.forEach((f, c) => { if (C.hasHeaderText(f)) lastHeader = c; });
    const width = Math.max(lastHeader + 1, csvWidth(dataRecords, 0));
    if (limits.maxColumns > 0 && width > limits.maxColumns) throw tooManyColumns(where, limits.maxColumns);
    if (!width) return null;

    const valueRows = [];
    for (let i = 0; i < dataRecords.length; i += 1) {
        const fields = dataRecords[i].fields;
        const vals = new Array(width).fill(null);
        let any = false;
        for (let c = 0; c < width && c < fields.length; c += 1) {
            const f = fields[c];
            if (f.trim() === '') continue;
            vals[c] = csv.unprefixField(f);
            any = true;
        }
        if (any) valueRows.push(vals);
    }
    if (limits.maxRows > 0 && valueRows.length > limits.maxRows) throw tooManyRows(where, limits.maxRows);
    const decimal = csv.sniffDecimal(dataRecords.slice(0, C.SNIFF_RECORDS));
    const masks = C.convertCsvColumns(/** @type {Array<Array<string|null>>} */ (valueRows), width, decimal);
    return finishTable(headerFields, width, valueRows, masks);
}

module.exports = { readGridSheet, readProvenanceSheet, readCsvTable, tooManyRows, tooManyColumns };
