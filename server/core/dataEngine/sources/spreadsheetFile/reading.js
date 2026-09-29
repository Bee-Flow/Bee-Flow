/**
 * READING one worksheet through a FileApi — the same way for the wizard's
 * describe and for the refresh pass, so the columns the linker saw are the
 * columns the first pass writes.
 *
 * Two roads to the same reader contract (`formats/index.js readSheet`:
 * `{ header, rows, rowNumbers, formulaCols, dateCols, numFmts, lastDataRow,
 * truncated, warnings, csv? }`):
 *   • CELLS — a storage with a cell API (a native Google Sheet; an Excel
 *     workbook in OneDrive for Business through the Graph workbook API)
 *     answers a matrix of typed values, dates as serial numbers, plus a
 *     sample that tells which columns carry a date format or a formula.
 *     `fromMatrix` turns that into the contract: header at `headerRow`,
 *     blank rows dropped and never numbered, columns up to the last
 *     non-empty header cell.
 *   • BYTES — everything else is a download (through cache.js, once per
 *     marker) and a parse by formats/.
 * Which road is chosen is the caller's: a native Sheet has no bytes; an
 * Excel file in OneDrive goes by cells only when the link recorded that the
 * workbook API answered for it (`source.write.mode === 'graph_workbook'`) —
 * asking Graph again on every pass would be a call per minute per mirror.
 *
 * Also here, because describe and link both need it: the WRITE-MODE rule
 * (what mechanism can carry a row back into this file, and why not), the
 * canonical content hash the pass compares, and the two spellings of a file
 * id on the wire (a OneDrive item outside the own drive carries its drive).
 */

'use strict';

const crypto = require('crypto');
const { SpreadsheetSourceError } = require('./errors');
const { headerText } = require('./columns');
const { isBlank } = require('./cells');
const { isBlankRow } = require('./identity');
const formats = require('./formats');
const cache = require('./cache');
const { PROVIDERS } = require('./index');

/** OneDrive: an item outside the own drive travels as `<driveId>|<itemId>`. Neither id can contain `|`. */
const DRIVE_SEP = '|';

// ─── Wire ids ───────────────────────────────────────────────────────────

/**
 * The FileRef a wire `{ provider, fileId, driveId?, path? }` names. On
 * Nextcloud the id IS the path; on OneDrive a composite id carries the
 * drive; Google's is the file id.
 */
function fileRefOf(provider, { fileId = null, driveId = null, path = null, name = null } = {}) {
    if (!PROVIDERS.includes(provider)) {
        throw new SpreadsheetSourceError(422, 'spreadsheet_rejected', `Unknown storage: ${String(provider).slice(0, 40)}.`);
    }
    if (provider === 'nextcloud_files') {
        const p = String(path || fileId || '').trim();
        if (!p || !p.startsWith('/')) throw new SpreadsheetSourceError(422, 'spreadsheet_rejected', 'A Nextcloud file is named by its path.');
        return { provider, fileId: null, driveId: null, path: p, name: name || p.split('/').pop() };
    }
    let id = String(fileId || '').trim();
    let drive = driveId ? String(driveId) : null;
    if (provider === 'onedrive' && !drive && id.includes(DRIVE_SEP)) {
        const at = id.indexOf(DRIVE_SEP);
        drive = id.slice(0, at);
        id = id.slice(at + 1);
    }
    if (!id) throw new SpreadsheetSourceError(422, 'spreadsheet_rejected', 'A file id is required.');
    return { provider, fileId: id, driveId: drive, path: path || null, name: name || null };
}

/** The id a client uses for a FileRef: the path on Nextcloud, `drive|item` for a foreign OneDrive item. */
function wireIdOf(ref) {
    if (!ref) return null;
    if (ref.provider === 'nextcloud_files') return ref.path || null;
    if (ref.provider === 'onedrive' && ref.driveId && ref.owned === false) return `${ref.driveId}${DRIVE_SEP}${ref.fileId}`;
    return ref.fileId || null;
}

/** The key two mirrors of one file share, whatever the storage: provider + file identity. */
function fileKeyOf(provider, file) {
    if (!file) return `${provider}|`;
    if (provider === 'nextcloud_files') return `${provider}|${file.path || file.id || file.fileId || ''}`;
    return `${provider}|${file.id || file.fileId || ''}`;
}

// ─── Reading ────────────────────────────────────────────────────────────

/**
 * A cells-API matrix (rows 1..n of the sheet, typed values) → the reader
 * contract. Rows above `headerRow` are ignored; the header runs to its
 * last non-empty cell; blank data rows are dropped; `maxRows` data rows are
 * kept and one more sets `truncated`.
 */
function fromMatrix(matrix, { headerRow = 1, maxRows, maxCols, dateCols = new Set(), formulaCols = new Set(), sheet = null } = {}) {
    const h = Math.max(1, Number(headerRow) || 1);
    const grid = Array.isArray(matrix) ? matrix : [];
    const headerCells = Array.isArray(grid[h - 1]) ? grid[h - 1] : [];
    let lastHeader = -1;
    headerCells.forEach((v, c) => { if (headerText(v) !== '') lastHeader = c; });
    if (lastHeader < 0) {
        throw new SpreadsheetSourceError(422, 'header_missing',
            `${sheet ? `Worksheet "${sheet}"` : 'The sheet'} has no header row there — pick the row that holds the column names.`, { ref: { sheet } });
    }
    const warnings = [];
    let span = lastHeader + 1;
    if (span > maxCols) {
        warnings.push(`Only the first ${maxCols} of ${span} columns are read.`);
        span = maxCols;
    }
    const header = [];
    for (let c = 0; c < span; c += 1) header.push(headerCells[c] === undefined || headerCells[c] === '' ? null : headerCells[c]);
    const rows = [];
    const rowNumbers = [];
    let lastDataRow = h;
    let beyond = false;
    for (let i = h; i < grid.length; i += 1) {
        const src = Array.isArray(grid[i]) ? grid[i] : [];
        const cells = new Array(span).fill(null);
        for (let c = 0; c < span && c < src.length; c += 1) cells[c] = isBlank(src[c]) ? null : src[c];
        if (!beyond && src.length > span && src.slice(span).some(v => !isBlank(v))) beyond = true;
        if (isBlankRow(cells)) continue;
        rows.push(cells);
        rowNumbers.push(i + 1);
        lastDataRow = i + 1;
    }
    if (beyond) warnings.push(`Cells to the right of the last header column (${span}) are ignored.`);
    let truncated = rows.length > maxRows;
    if (truncated) {
        rows.length = maxRows;
        rowNumbers.length = maxRows;
        lastDataRow = rowNumbers[rowNumbers.length - 1];
    }
    const dates = new Set([...dateCols].filter(c => c < span));
    const formulas = new Set([...formulaCols].filter(c => c < span));
    return { sheet, header, rows, rowNumbers, formulaCols: formulas, dateCols: dates, numFmts: new Map(), lastDataRow, truncated, warnings };
}

/** The tab list of a file: `[{ id, name, index, rows, cols, hidden }]` (a csv has one unnamed tab). */
async function listSheetsOf(api, probe, { viaCells }) {
    if (viaCells) {
        const tabs = await api.cells.listSheets(probe.file);
        return tabs.map((s, i) => ({
            id: s.id ?? null, name: s.name || '', index: Number.isInteger(s.index) ? s.index : i,
            rows: s.rowCount ?? null, cols: s.colCount ?? null, hidden: !!s.hidden,
        }));
    }
    const buffer = await bytesOf(api, probe);
    const key = cache.keyOf(probe.file.provider, fileIdOf(probe.file), probe.marker);
    const tabs = await cache.parsed(key, 'sheets', () => formats.listSheets(buffer, probe.format), { size: 2048 });
    return tabs.map(s => ({ id: null, name: s.name, index: s.index, rows: s.rows, cols: s.cols, hidden: !!s.hidden }));
}

function fileIdOf(file) {
    return file.provider === 'nextcloud_files' ? (file.path || '') : (file.fileId || file.id || '');
}

/** The file's bytes at the probed version — cached, one download in flight. */
async function bytesOf(api, probe) {
    if (probe.size != null && probe.size > formats.MAX_FILE_BYTES) {
        throw new SpreadsheetSourceError(413, 'spreadsheet_too_large',
            `"${probe.name}" is ${(probe.size / (1024 * 1024)).toFixed(1)} MB; a linked spreadsheet may be at most ${formats.MAX_FILE_BYTES / (1024 * 1024)} MB.`,
            { ref: { provider: probe.file.provider, fileId: probe.file.fileId, path: probe.file.path } });
    }
    const key = cache.keyOf(probe.file.provider, fileIdOf(probe.file), probe.marker);
    return cache.bytes(key, async () => (await api.download(probe.file, { maxBytes: formats.MAX_FILE_BYTES })).buffer);
}

/**
 * One worksheet, by cells or by bytes.
 * @param {object} api        a FileApi
 * @param {object} probe      api.probe()'s answer (marker, format, file, size, name)
 * @param {object} opts
 * @param {string|null} opts.sheet     tab name (null = the first)
 * @param {number} opts.headerRow
 * @param {number} opts.rowCap         data rows to keep; one more is read to learn `truncated`
 * @param {number} [opts.maxCols]
 * @param {boolean} opts.viaCells
 * @returns {Promise<object>} the reader contract
 */
async function readSheetOf(api, probe, { sheet = null, headerRow = 1, rowCap, maxCols = formats.MAX_COLS, viaCells }) {
    const cap = Math.max(1, Math.min(formats.MAX_ROWS, Number(rowCap) || formats.MAX_ROWS));
    const key = cache.keyOf(probe.file.provider, fileIdOf(probe.file), probe.marker);
    const subKey = `read|${viaCells ? 'cells' : 'bytes'}|${sheet === null ? '' : sheet}|${headerRow}|${cap}`;
    if (viaCells) {
        return cache.parsed(key, subKey, async () => {
            const tab = sheet === null ? (await firstTab(api, probe)) : sheet;
            const [full, sample] = await Promise.all([
                api.cells.readSheet(probe.file, tab, { headerRow, maxRows: cap + 1, maxCols }),
                api.cells.sample(probe.file, tab, { headerRow, rows: formats.SAMPLE_ROWS }),
            ]);
            const dateCols = new Set();
            for (const [col, kind] of (sample.numberFormat || new Map())) {
                if (kind === 'DATE' || kind === 'DATE_TIME') dateCols.add(Number(col));
            }
            const read = fromMatrix(full.rows, { headerRow, maxRows: cap, maxCols, dateCols, formulaCols: sample.formulaCols || new Set(), sheet: tab });
            if (full.errorCells) read.warnings.push(`${full.errorCells} cells hold a formula error and are read as empty.`);
            return read;
        });
    }
    const buffer = await bytesOf(api, probe);
    return cache.parsed(key, subKey, () => formats.readSheet(buffer, { format: probe.format, sheet, headerRow, maxRows: cap + 1, maxCols }));
}

async function firstTab(api, probe) {
    const tabs = await api.cells.listSheets(probe.file);
    const first = tabs.find(t => !t.hidden) || tabs[0];
    if (!first) throw new SpreadsheetSourceError(404, 'sheet_missing', 'The spreadsheet has no worksheets.');
    return first.name;
}

/** Does this file read (and write) by cells on this api? Asks the storage once per api instance where it must. */
async function cellsAvailable(api, probe) {
    if (!api.cells || typeof api.cells.available !== 'function') return false;
    if (probe.format === 'gsheet') return true;
    if (probe.format !== 'xlsx' && probe.format !== 'xlsm') return false;
    return !!(await api.cells.available(probe.file));
}

// ─── Content hash ───────────────────────────────────────────────────────

/**
 * A digest of header + rows the pass compares with the previous one: a
 * marker that moved without the sheet's content moving (a rename, a share,
 * another tab edited) must not rewrite the copy. Dates are ISO through
 * JSON's own Date handling; the hash is fed row by row.
 *
 * In ROW identity mode the sheet row numbers are part of it: a blank row
 * inserted or deleted above data moves every `r<n>` without moving a single
 * cell, and a pass that called that "unchanged" would leave the copy's ids
 * pointing at the wrong sheet rows (the next update-by-id would then drop
 * a live row). In key mode the copy stores no row number, so a shift is
 * genuinely nothing — pass `null` there.
 */
function contentHashOf(header, rows, rowNumbers = null) {
    const h = crypto.createHash('sha256');
    h.update(JSON.stringify(header || []));
    const list = rows || [];
    for (let i = 0; i < list.length; i += 1) {
        h.update('\n');
        if (rowNumbers) { h.update(String(rowNumbers[i])); h.update(':'); }
        h.update(JSON.stringify(list[i]));
    }
    return `sha256:${h.digest('hex')}`;
}

// ─── Write mode ─────────────────────────────────────────────────────────

/** What a row written from Bee Flow loses in the file, per mechanism. */
const CAVEATS = Object.freeze({
    sheets_api: [],
    graph_workbook: [],
    exceljs_put: ['charts', 'pivots', 'vba', 'slicers'],
    csv_put: ['rewrite'],
    none: [],
});

/**
 * How (and whether) rows can be written back into this file.
 * @param {object} facts   { provider, format, owned, writable, workbook, sharedOptIn }
 * @returns {{ mode:string, reason:string|null, caveats:string[], sharedOptIn:boolean }}
 */
function writeModeFor({ provider, format, owned = false, writable = true, workbook = false, sharedOptIn = false } = {}) {
    const optIn = sharedOptIn === true;
    const none = (reason) => ({ mode: 'none', reason, caveats: [], sharedOptIn: optIn });
    if (formats.READ_ONLY_REASON[format]) return none(formats.READ_ONLY_REASON[format]);
    if (format !== 'gsheet' && format !== 'xlsx' && format !== 'csv') return none('format');
    if (writable === false) return none('no_permission');
    if (!owned && !optIn) return none('not_owned');
    let mode;
    if (format === 'gsheet') mode = 'sheets_api';
    else if (format === 'csv') mode = 'csv_put';
    else mode = provider === 'onedrive' && workbook ? 'graph_workbook' : 'exceljs_put';
    return { mode, reason: null, caveats: [...CAVEATS[mode]], sharedOptIn: optIn };
}

module.exports = {
    DRIVE_SEP, CAVEATS,
    fileRefOf, wireIdOf, fileKeyOf, fileIdOf,
    fromMatrix, listSheetsOf, readSheetOf, bytesOf, cellsAvailable,
    contentHashOf, writeModeFor,
};
