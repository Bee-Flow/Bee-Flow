/**
 * READING xlsx / xlsm / xls / ods with SheetJS (@e965/xlsx) — the one parser
 * that reads all four, used for reads only (the community build drops styles
 * on write, so xlsx edits go through exceljs.js and the others are read-only).
 *
 * The options are the whole point of this file, each one verified against
 * the library in-process:
 *   cellDates:false  a date cell comes back as its SERIAL (`t:'n'`) with its
 *                    number format in `z`; SheetJS's own Date conversion is
 *                    skewed by the process timezone, ours (cells.serialToDate)
 *                    is not — a sheet's "15-01-2026" is 15 January wherever
 *                    the server runs;
 *   cellNF:true      keeps `z`, so `XLSX.SSF.is_date(z)` can tell a date
 *                    serial from an amount;
 *   raw:true         text stays text — '0123' is an article code, not 123;
 *   cellFormula:true `f` marks a formula cell, which flags its COLUMN as
 *                    derived (read-only) for the whole mirror;
 *   sheets:[name]    only the sheet asked for is materialised;
 *   sheetRows:n      the parse stops after the cap + one probe row, so a
 *                    100 000-row export never becomes 100 000 JS objects.
 * A .xlsx/.ods that is not a ZIP is refused before SheetJS sees it: the
 * library parses arbitrary bytes as delimited text and would hand back a
 * one-column "Sheet1" of somebody's notes. (Guard and the ODS styles.xml
 * retry mirror integrations/nextcloudFiles/officeDocuments.js.)
 */

'use strict';

const XLSX = require('@e965/xlsx');
const { SpreadsheetSourceError } = require('../errors');
const { serialToDate } = require('../cells');
const { headerText } = require('../columns');

const ZIP_FORMATS = new Set(['xlsx', 'xlsm', 'ods']);
// Rows parsed BEYOND the cap: a blank spacer row right at the cap must not
// hide the data under it, so the probe is a short run, not one row.
const PROBE_ROWS = 50;

// Both .xlsx and .ods are ZIP packages: local-file-header signature.
function isZipPackage(buf) {
    return Buffer.isBuffer(buf) && buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

// A .xls is a CFB (OLE2) container.
function isCfbPackage(buf) {
    const sig = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
    return Buffer.isBuffer(buf) && buf.length >= 8 && sig.every((b, i) => buf[i] === b);
}

// Empty ODF stylesheet, see readWorkbook for why it exists.
const EMPTY_ODS_STYLES =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" office:version="1.2"/>';

function assertPackage(buffer, format) {
    if (ZIP_FORMATS.has(format) && !isZipPackage(buffer)) {
        throw new SpreadsheetSourceError(415, 'format_unsupported',
            `This file is not a valid .${format} (it is not a ZIP package) — was it saved under the wrong extension?`);
    }
    if (format === 'xls' && !isCfbPackage(buffer)) {
        throw new SpreadsheetSourceError(415, 'format_unsupported',
            'This file is not a real .xls workbook (some exports save a web page or text under that name) — save it as .xlsx.');
    }
}

/** XLSX.read with the ODS styles.xml retry. */
async function readWorkbook(buffer, format, options) {
    assertPackage(buffer, format);
    try {
        return XLSX.read(buffer, { type: 'buffer', ...options });
    } catch (e) {
        // officegen.buildOds writes the SMALLEST valid ODF package: mimetype,
        // manifest and content.xml. Older SheetJS ODS parsers insisted on a
        // styles.xml as well, so a file this product created would have been
        // unreadable. Patch an empty stylesheet in and retry — only for that
        // specific failure.
        if (format !== 'ods' || !/styles\.xml/.test(String(e && e.message))) throw parseFailure(format, e);
        const JSZip = require('jszip');
        const zip = await JSZip.loadAsync(buffer);
        zip.file('styles.xml', EMPTY_ODS_STYLES);
        try {
            return XLSX.read(await zip.generateAsync({ type: 'nodebuffer' }), { type: 'buffer', ...options });
        } catch (e2) {
            throw parseFailure(format, e2);
        }
    }
}

function parseFailure(format, e) {
    return new SpreadsheetSourceError(422, 'spreadsheet_rejected',
        `The .${format} file could not be read: ${String(e && e.message || e).slice(0, 120)}`);
}

function rangeOf(ws, { full = false } = {}) {
    const ref = ws && ((full && ws['!fullref']) || ws['!ref']);
    if (!ref) return null;
    try { return XLSX.utils.decode_range(ref); } catch { return null; }
}

/**
 * The workbook's tabs, in file order.
 * @returns {Array<{ name, index, hidden, rows, cols }>}  rows/cols = the used range (≤ the probe cap)
 */
async function listSheets(buffer, format, { probeRows = 10_001 } = {}) {
    const wb = await readWorkbook(buffer, format, {
        sheetRows: probeRows, cellNF: false, cellText: false, cellHTML: false, cellFormula: false, cellStyles: false,
    });
    const hiddenFlags = (wb.Workbook && Array.isArray(wb.Workbook.Sheets)) ? wb.Workbook.Sheets : [];
    return wb.SheetNames.map((name, index) => {
        const r = rangeOf(wb.Sheets[name], { full: true });
        const meta = hiddenFlags[index] || {};
        return {
            name, index,
            hidden: Number(meta.Hidden || 0) > 0,
            rows: r ? r.e.r + 1 : 0,
            cols: r ? r.e.c + 1 : 0,
        };
    });
}

/** Resolve the sheet the source names (name, else index, else the first). */
function pickSheet(wb, sheet) {
    const names = wb.SheetNames || [];
    if (!names.length) {
        throw new SpreadsheetSourceError(404, 'sheet_missing', 'The workbook has no worksheets.');
    }
    if (sheet === undefined || sheet === null || sheet === '') return names[0];
    if (typeof sheet === 'number') {
        if (!names[sheet]) throw new SpreadsheetSourceError(404, 'sheet_missing', `The workbook has no worksheet #${sheet + 1}.`);
        return names[sheet];
    }
    const wanted = String(sheet);
    if (names.includes(wanted)) return wanted;
    throw new SpreadsheetSourceError(404, 'sheet_missing',
        `The workbook has no worksheet called "${wanted}" any more (it has: ${names.slice(0, 10).join(', ')}).`, { ref: { sheet: wanted } });
}

/** One SheetJS cell → the reader's value (string | number | boolean | Date | null). */
function cellValue(cell) {
    if (!cell) return null;
    switch (cell.t) {
        case 'n':
            if (cell.z && XLSX.SSF.is_date(cell.z)) return serialToDate(cell.v);
            return typeof cell.v === 'number' && Number.isFinite(cell.v) ? cell.v : null;
        case 'b':
            return !!cell.v;
        case 'd':
            return cell.v instanceof Date ? cell.v : null;
        case 'e':
            return null;                       // #DIV/0!, #N/A … — nothing to keep
        case 'z':
            return null;
        case 's':
        case 'str':
        default:
            return cell.v === undefined || cell.v === null ? null : String(cell.v);
    }
}

function isDateCell(cell) {
    return !!cell && cell.t === 'n' && !!cell.z && XLSX.SSF.is_date(cell.z);
}

/**
 * Read one worksheet as header + data rows.
 *
 * Rows above `headerRow` are ignored; the columns are the header cells up to
 * the last non-empty one (cells to the right are ignored, with a warning);
 * fully blank data rows are dropped and never numbered. `rows[i]` belongs to
 * sheet row `rowNumbers[i]` (1-based). `truncated` says the sheet has more
 * rows than `maxRows`; `lastDataRow` is the highest sheet row with a value
 * inside the header's span among the rows read.
 *
 * @returns {Promise<{ sheet, header, rows, rowNumbers, formulaCols:Set, dateCols:Set, numFmts:Map, lastDataRow, truncated, warnings }>}
 */
async function readSheet(buffer, { format, sheet, headerRow = 1, maxRows, maxCols }) {
    const h = Math.max(1, Number(headerRow) || 1);
    const wb = await readWorkbook(buffer, format, {
        cellNF: true, cellDates: false, cellFormula: true, raw: true, cellText: false, cellHTML: false,
        sheets: [sheet === undefined || sheet === null || sheet === '' ? 0 : sheet], sheetRows: h + maxRows + PROBE_ROWS,
    });
    const name = pickSheet(wb, sheet);
    const ws = wb.Sheets[name];
    const warnings = [];
    const range = ws ? rangeOf(ws) : null;
    if (!ws || !range || h - 1 > range.e.r) headerMissing(name);

    // The header: cells up to the last non-empty one, capped.
    const headerCells = [];
    let lastHeader = -1;
    for (let c = 0; c <= range.e.c; c += 1) {
        const v = cellValue(ws[XLSX.utils.encode_cell({ r: h - 1, c })]);
        headerCells[c] = v;
        if (headerText(v) !== '') lastHeader = c;
    }
    if (lastHeader < 0) headerMissing(name);
    let span = lastHeader + 1;
    if (span > maxCols) {
        warnings.push(`Only the first ${maxCols} of ${span} columns are read.`);
        span = maxCols;
    }
    const header = [];
    for (let c = 0; c < span; c += 1) header.push(headerCells[c] === undefined ? null : headerCells[c]);

    // The data rows, blank ones dropped. The loop runs PROBE_ROWS past the
    // cap, so `truncated` can be known without materialising the rest of
    // the sheet; the file's own dimension (xlsx) covers a sheet that goes on
    // beyond the probe.
    const rows = [];
    const rowNumbers = [];
    const formulaCols = new Set();
    const dateCols = new Set();
    const fmtTally = new Map();       // col → Map<z, count>
    let lastDataRow = h;
    let beyond = false;
    const lastRow = Math.min(range.e.r, h + maxRows + PROBE_ROWS - 1);
    for (let r = h; r <= lastRow; r += 1) {
        const cells = new Array(span).fill(null);
        let blank = true;
        for (let c = 0; c < span; c += 1) {
            const cell = ws[XLSX.utils.encode_cell({ r, c })];
            if (!cell) continue;
            // Before the value is looked at: a formula whose cached result
            // is an error (#N/A, #REF!) reads as empty, but the column is
            // derived all the same — a write into it would be dropped by
            // the editor, so it must be flagged read-only here.
            if (cell.f) formulaCols.add(c);
            const v = cellValue(cell);
            if (v === null) continue;
            cells[c] = v;
            blank = false;
            if (isDateCell(cell)) dateCols.add(c);
            if (cell.z && cell.z !== 'General') {
                let t = fmtTally.get(c);
                if (!t) { t = new Map(); fmtTally.set(c, t); }
                t.set(cell.z, (t.get(cell.z) || 0) + 1);
            }
        }
        if (!beyond) {
            for (let c = span; c <= range.e.c; c += 1) {
                if (cellValue(ws[XLSX.utils.encode_cell({ r, c })]) !== null) { beyond = true; break; }
            }
        }
        if (blank) continue;
        rows.push(cells);
        rowNumbers.push(r + 1);
        lastDataRow = r + 1;
    }
    if (beyond) warnings.push(`Cells to the right of the last header column (${span}) are ignored.`);
    const full = rangeOf(ws, { full: true });
    let truncated = rows.length > maxRows || (rows.length >= maxRows && !!full && full.e.r > lastRow);
    if (rows.length > maxRows) {
        rows.length = maxRows;
        rowNumbers.length = maxRows;
        lastDataRow = rowNumbers[rowNumbers.length - 1];
    }
    const numFmts = new Map();
    for (const [c, t] of fmtTally) numFmts.set(c, [...t.entries()].sort((a, b) => b[1] - a[1])[0][0]);
    return { sheet: name, header, rows, rowNumbers, formulaCols, dateCols, numFmts, lastDataRow, truncated, warnings };
}

function headerMissing(name) {
    throw new SpreadsheetSourceError(422, 'header_missing',
        `Worksheet "${name}" has no header row there — pick the row that holds the column names.`, { ref: { sheet: name } });
}

module.exports = { listSheets, readSheet, readWorkbook, isZipPackage, isCfbPackage, cellValue };
