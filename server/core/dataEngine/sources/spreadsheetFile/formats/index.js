/**
 * The file formats a spreadsheet mirror can read, and the two it can write.
 *
 *   read   xlsx · xlsm · xls · ods  → sheetjs.js      csv → csv.js
 *   write  xlsx                     → exceljs.js      csv → csv.js
 *   (gsheet is not a file: the Google adapter reads it over the Sheets API)
 *
 * This module is the only door: callers get one `listSheets` / `readSheet` /
 * `editInPlace` and never pick a parser. It also holds the CAPS, because a
 * spreadsheet is the one input a user can hand us that is arbitrarily large:
 *   MAX_FILE_BYTES  20 MB for every format — exceljs materialises the whole
 *                   workbook object graph (several × the file size in RAM),
 *                   and the Nextcloud connector proxies the PUT body;
 *   MAX_COLS        the datatable field cap (100);
 *   MAX_ROWS        the engine read cap (10 000) — the reader parses at most
 *                   headerRow + rows + 1, the extra row being the probe that
 *                   sets `truncated` without materialising the rest;
 *   MAX_CELLS       1 000 000 fields for a csv parse.
 * And a per-process concurrency limiter of PARSE_CONCURRENCY around every
 * parse and edit: a 20 MB workbook takes hundreds of MB and seconds to load,
 * and three describes at once would take a small replica down. exceljs is
 * required lazily inside exceljs.js for the same reason.
 *
 * Every function is async so the limiter can wrap the synchronous SheetJS
 * parse and the asynchronous exceljs load alike.
 */

'use strict';

const { DATA_LIMITS } = require('../../../dataModel/vocabulary');
const { SpreadsheetSourceError } = require('../errors');

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_COLS = DATA_LIMITS.MAX_FIELDS_PER_TABLE;
const MAX_ROWS = 10_000;                 // = mirror/constants ENGINE_READ_CAP; literal so formats stays leaf
const MAX_CELLS = 1_000_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const SAMPLE_ROWS = 500;
const MAX_HEADER_ROW = 50;
const PARSE_CONCURRENCY = 2;

const READ_FORMATS = Object.freeze(['xlsx', 'xlsm', 'xls', 'csv', 'ods']);
const EDIT_FORMATS = Object.freeze(['xlsx', 'csv']);
/** Why a byte format cannot be edited in place — `source.write.reason`. */
const READ_ONLY_REASON = Object.freeze({ xlsm: 'xlsm', xls: 'xls', ods: 'ods' });

// ---------------------------------------------------------------------------
// The limiter: at most PARSE_CONCURRENCY parses/edits in flight per process.
// ---------------------------------------------------------------------------

let inFlight = 0;
const waiting = [];

function withSlot(fn) {
    return new Promise((resolve, reject) => {
        const run = () => {
            inFlight += 1;
            Promise.resolve().then(fn).then(resolve, reject).finally(() => {
                inFlight -= 1;
                const next = waiting.shift();
                if (next) next();
            });
        };
        if (inFlight < PARSE_CONCURRENCY) run();
        else waiting.push(run);
    });
}

/** For tests and the panel: how busy the parser is. */
function limiterState() {
    return { inFlight, waiting: waiting.length, limit: PARSE_CONCURRENCY };
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function assertFormat(format, allowed, what) {
    if (!allowed.includes(format)) {
        const reason = READ_ONLY_REASON[format] || null;
        if (what === 'edit' && READ_FORMATS.includes(format)) {
            throw new SpreadsheetSourceError(409, 'spreadsheet_write_unsupported',
                `A .${format} file cannot be edited from here — save it as .xlsx to write rows back.`, { reason });
        }
        throw new SpreadsheetSourceError(415, 'format_unsupported',
            `Files of type "${format}" cannot be ${what === 'edit' ? 'edited' : 'read'} as a spreadsheet.`);
    }
}

function assertSize(buffer) {
    if (!Buffer.isBuffer(buffer)) throw new TypeError('spreadsheetFile/formats: a Buffer is required');
    if (buffer.length > MAX_FILE_BYTES) {
        throw new SpreadsheetSourceError(413, 'spreadsheet_too_large',
            `The file is ${(buffer.length / (1024 * 1024)).toFixed(1)} MB; a linked spreadsheet may be at most ${MAX_FILE_BYTES / (1024 * 1024)} MB.`);
    }
}

function clampHeaderRow(headerRow) {
    const h = Number(headerRow) || 1;
    if (!Number.isInteger(h) || h < 1 || h > MAX_HEADER_ROW) {
        throw new SpreadsheetSourceError(422, 'spreadsheet_rejected', `The header row must be between 1 and ${MAX_HEADER_ROW}.`);
    }
    return h;
}

// ---------------------------------------------------------------------------
// The door
// ---------------------------------------------------------------------------

/**
 * The worksheets of a file. A csv has exactly one, unnamed.
 * @returns {Promise<Array<{ name:string|null, index:number, hidden:boolean, rows:number, cols:number }>>}
 */
async function listSheets(buffer, format) {
    assertSize(buffer);
    assertFormat(format, READ_FORMATS, 'read');
    return withSlot(async () => {
        if (format === 'csv') {
            const csv = require('./csv');
            const { text } = csv.decode(buffer);
            const { records } = csv.parseRecords(text, csv.sniffDelimiter(text), { maxRecords: MAX_ROWS + 1, maxCells: MAX_CELLS });
            const cols = records.reduce((m, r) => Math.max(m, r.fields.length), 0);
            return [{ name: null, index: 0, hidden: false, rows: records.length, cols }];
        }
        return require('./sheetjs').listSheets(buffer, format, { probeRows: MAX_ROWS + 1 });
    });
}

/**
 * One worksheet as header + rows, the reader's contract:
 * `{ sheet, header, rows, rowNumbers, formulaCols:Set, dateCols:Set, numFmts:Map, lastDataRow, truncated, warnings, csv? }`
 * — cells are string | number | boolean | UTC wall-clock Date | null (cells.js).
 */
async function readSheet(buffer, { format, sheet = null, headerRow = 1, maxRows = MAX_ROWS, maxCols = MAX_COLS } = {}) {
    assertSize(buffer);
    assertFormat(format, READ_FORMATS, 'read');
    const h = clampHeaderRow(headerRow);
    const rows = Math.max(1, Math.min(MAX_ROWS, Number(maxRows) || MAX_ROWS));
    const cols = Math.max(1, Math.min(MAX_COLS, Number(maxCols) || MAX_COLS));
    return withSlot(async () => {
        if (format === 'csv') {
            return require('./csv').readSheet(buffer, { headerRow: h, maxRows: rows, maxCols: cols, maxCells: MAX_CELLS });
        }
        return require('./sheetjs').readSheet(buffer, { format, sheet, headerRow: h, maxRows: rows, maxCols: cols });
    });
}

/**
 * Apply row ops to a file and get the whole file back — xlsx via exceljs,
 * csv via the byte-faithful rewrite; any other format → 409
 * `spreadsheet_write_unsupported` with the reason.
 * Ops: `{ op:'update', row, cells:{[col]:value} } | { op:'append', cells } | { op:'delete', row }`
 * with the write codec's values (cells.writeCell). `columns` maps a 0-based
 * col to its columnMap entry (csv needs `type`/`dateFormat`); `csv` is the
 * stored sniff (a fallback: the csv editor sniffs the bytes it edits);
 * `expectSpan` is the header width the ops were located in (csv refuses a
 * file whose header no longer has that width).
 * @returns {Promise<{ buffer:Buffer, appended:number[], lastDataRow:number, skipped?:Array, csv?:object }>}
 */
async function editInPlace(buffer, { format, sheet = null, headerRow = 1, ops = [], columns = {}, csv = null, expectSpan = null } = {}) {
    assertSize(buffer);
    assertFormat(format, EDIT_FORMATS, 'edit');
    const h = clampHeaderRow(headerRow);
    return withSlot(async () => {
        if (format === 'csv') return require('./csv').editInPlace(buffer, { headerRow: h, ops, columns, csv, expectSpan, maxCols: MAX_COLS });
        return require('./exceljs').editInPlace(buffer, { sheet, headerRow: h, ops });
    });
}

/** Can rows be written back into a file of this format? */
function canEdit(format) {
    return EDIT_FORMATS.includes(format);
}

module.exports = {
    MAX_FILE_BYTES, MAX_COLS, MAX_ROWS, MAX_CELLS, DOWNLOAD_TIMEOUT_MS, SAMPLE_ROWS, MAX_HEADER_ROW, PARSE_CONCURRENCY,
    READ_FORMATS, EDIT_FORMATS, READ_ONLY_REASON,
    listSheets, readSheet, editInPlace, canEdit, withSlot, limiterState,
};
