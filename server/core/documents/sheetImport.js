// @typecheck
/**
 * An uploaded workbook (.xlsx / .xlsm / .xls / .ods / .csv) → a Bee Flow
 * SPREADSHEET document (stores/documentStore.js, docType 'spreadsheet'), one
 * tab per worksheet. The chat uses it so a file the user drops in is not just
 * text for the model: it opens next to the chat and the model edits its cells.
 *
 * Parsing reuses the spreadsheet-file readers (dataEngine/sources/
 * spreadsheetFile/formats): their size cap, their ZIP/CFB package checks, the
 * SheetJS options that keep text as text and dates as serials, and the
 * parse-concurrency limiter. What is stored is what a person would have
 * TYPED (core/documents/sheetCells.js): a formula as `=…` text (SheetJS
 * `cell.f`), a date as an ISO date, a number as its plain string, a boolean as
 * TRUE/FALSE; a cell that holds an error value stays empty.
 *
 * A sheet is A–Z by 2000 rows (sheetCells LIMITS); what a workbook has beyond
 * that is cut and REPORTED, never silently dropped. Formulas are kept even
 * when the sheet engine cannot compute them (functions outside
 * SHEET_FUNCTIONS); those functions are listed so the caller can say so.
 *
 * All-or-nothing: every table made is dropped again when anything fails.
 * A FACTORY (`makeSheetImport(deps)`) so the tests run it on fakes.
 */

'use strict';

const { HttpError } = require('../http/errors');
const log = require('../../telemetry/log');
const { newTabId, settingsWithTabs } = require('../../stores/lib/sheetDocument');

/** Tabs per workbook; more worksheets are skipped and reported. */
const MAX_TABS = 20;
/** Cells (not empty ones) per workbook, so a huge file cannot fill the owner's quota in one go. */
const MAX_TOTAL_CELLS = 100_000;
const CHUNK = 500;
const MAX_TAB_NAME = 100;

const FORMATS = Object.freeze(['xlsx', 'xlsm', 'xls', 'ods', 'csv']);
const MIME_FORMATS = Object.freeze({
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-excel.sheet.macroenabled.12': 'xlsm',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.oasis.opendocument.spreadsheet': 'ods',
    'text/csv': 'csv',
    'application/csv': 'csv',
});
const FUNCTION_CALL_RE = /([A-Za-z][A-Za-z0-9_.]*)\s*\(/g;

/**
 * @param {string} fileName
 * @param {string} [mimeType]
 * @returns {string|null}
 */
function formatOf(fileName, mimeType) {
    const ext = /\.([a-z0-9]+)$/i.exec(String(fileName || ''))?.[1]?.toLowerCase();
    if (ext && FORMATS.includes(ext)) return ext;
    const mime = String(mimeType || '').toLowerCase().split(';')[0].trim();
    return /** @type {Record<string, string>} */ (MIME_FORMATS)[mime] || null;
}

/** The file name without its extension, as the document's name. */
function documentNameOf(fileName) {
    const base = String(fileName || '').replace(/^.*[\\/]/, '').replace(/\.[a-z0-9]+$/i, '').trim();
    return (base || 'Imported spreadsheet').slice(0, 200);
}

/** 0 → 'A' (columns A–Z only). */
const colName = (/** @type {number} */ c) => String.fromCharCode(65 + c);

/**
 * Function names a formula calls, upper-cased, text in quotes ignored.
 * @param {string} formula
 * @returns {string[]}
 */
function functionsIn(formula) {
    const bare = String(formula).replace(/"(?:[^"]|"")*"/g, '""');
    return [...bare.matchAll(FUNCTION_CALL_RE)].map((m) => m[1].toUpperCase());
}

/**
 * @typedef {{ name: string, grid: string[][], droppedRows: number, droppedCols: number }} ParsedSheet
 */

/**
 * One SheetJS cell → what a person would have typed.
 * @param {any} cell
 * @param {any} XLSX
 * @param {{ serialToIso: (n: number) => string|null }} cellsLib
 */
function typedText(cell, XLSX, cellsLib) {
    if (!cell) return '';
    if (cell.f) return `=${String(cell.f).replace(/^=/, '')}`;
    switch (cell.t) {
        case 'n':
            if (cell.z && XLSX.SSF.is_date(cell.z)) return cellsLib.serialToIso(cell.v) || '';
            return typeof cell.v === 'number' && Number.isFinite(cell.v) ? String(cell.v) : '';
        case 'b': return cell.v ? 'TRUE' : 'FALSE';
        case 'd': return cell.v instanceof Date && !Number.isNaN(cell.v.getTime()) ? cell.v.toISOString().slice(0, 10) : '';
        case 'e': case 'z': return '';
        default: return cell.v === undefined || cell.v === null ? '' : String(cell.v);
    }
}

/**
 * @param {Buffer} buffer
 * @param {string} format
 * @param {number} maxRows
 * @param {number} maxCols
 * @returns {Promise<ParsedSheet[]>}
 */
async function parseWorkbook(buffer, format, maxRows, maxCols) {
    const formats = require('../dataEngine/sources/spreadsheetFile/formats');
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new HttpError(422, 'spreadsheet_rejected', 'The file is empty.');
    if (buffer.length > formats.MAX_FILE_BYTES) {
        throw new HttpError(413, 'spreadsheet_too_large', `The file is larger than ${formats.MAX_FILE_BYTES / (1024 * 1024)} MB.`);
    }
    return formats.withSlot(async () => {
        if (format === 'csv') {
            const csv = require('../dataEngine/sources/spreadsheetFile/formats/csv');
            const { text } = csv.decode(buffer);
            const { records, truncated } = csv.parseRecords(text, csv.sniffDelimiter(text), { maxCells: 1_000_000 });
            const width = records.reduce((m, r) => Math.max(m, r.fields.length), 0);
            const grid = records.slice(0, maxRows).map((r) => r.fields.slice(0, maxCols));
            // A truncated parse stopped early: the rest is unknown, so it is
            // reported as at least one more row.
            const droppedRows = Math.max(0, records.length - maxRows) + (truncated ? 1 : 0);
            return [{ name: 'Sheet1', grid, droppedRows, droppedCols: Math.max(0, width - maxCols) }];
        }
        const XLSX = require('@e965/xlsx');
        const cellsLib = require('../dataEngine/sources/spreadsheetFile/cells');
        const wb = await require('../dataEngine/sources/spreadsheetFile/formats/sheetjs').readWorkbook(buffer, format, {
            cellNF: true, cellDates: false, cellFormula: true, raw: true, cellText: false, cellHTML: false, sheetStubs: true, sheetRows: maxRows + 1,
        });
        return wb.SheetNames.map((/** @type {string} */ name) => {
            const ws = wb.Sheets[name];
            const ref = ws && ws['!ref'];
            if (!ref) return { name, grid: [], droppedRows: 0, droppedCols: 0 };
            const range = XLSX.utils.decode_range(ref);
            const full = ws['!fullref'] ? XLSX.utils.decode_range(ws['!fullref']) : range;
            const rows = Math.min(range.e.r + 1, maxRows);
            const cols = Math.min(range.e.c + 1, maxCols);
            const grid = [];
            for (let r = 0; r < rows; r += 1) {
                const line = [];
                for (let c = 0; c < cols; c += 1) line.push(typedText(ws[XLSX.utils.encode_cell({ r, c })], XLSX, cellsLib));
                grid.push(line);
            }
            return {
                name, grid,
                droppedRows: Math.max(0, full.e.r + 1 - rows),
                droppedCols: Math.max(0, full.e.c + 1 - cols),
            };
        });
    });
}

/**
 * @param {{ cells?: any, documents?: any }} [deps]
 */
function makeSheetImport(deps = {}) {
    const cells = () => deps.cells || require('./sheetCells');
    const documents = () => deps.documents || require('../../stores/documentStore');

    /**
     * @param {{ userId: string, buffer: Buffer, fileName: string, mimeType?: string }} input
     * @returns {Promise<{
     *   documentId: string, name: string,
     *   tabs: { name: string, rows: number, cols: number }[],
     *   truncated: { tab: string, droppedRows: number, droppedCols: number }[],
     *   unsupportedFunctions: string[], skippedSheets: string[],
     * }>}
     */
    async function importWorkbook({ userId, buffer, fileName, mimeType }) {
        const format = formatOf(fileName, mimeType);
        if (!format) throw new HttpError(415, 'format_unsupported', 'Only .xlsx, .xls, .ods and .csv files can be opened as a spreadsheet.');
        const { LIMITS } = require('./sheetCells');
        const sheets = await parseWorkbook(buffer, format, LIMITS.MAX_SHEET_ROWS, LIMITS.COLUMNS);
        if (!sheets.length) throw new HttpError(422, 'spreadsheet_rejected', 'The workbook has no worksheets.');

        const { SHEET_FUNCTIONS } = require('../../shared/expr/sheet.mjs');
        const supported = new Set(SHEET_FUNCTIONS);
        const kept = sheets.slice(0, MAX_TABS);
        const skippedSheets = sheets.slice(MAX_TABS).map((s) => s.name);
        const name = documentNameOf(fileName);
        /** @type {string[]} */
        const tableIds = [];
        /** @type {{ id: string, name: string, datatableId: string }[]} */
        const tabs = [];
        /** @type {{ name: string, rows: number, cols: number }[]} */
        const summary = [];
        /** @type {{ tab: string, droppedRows: number, droppedCols: number }[]} */
        const truncated = [];
        const unsupported = new Set();
        let budget = MAX_TOTAL_CELLS;
        let created = false;
        try {
            for (const [i, sheet] of kept.entries()) {
                const tabName = (String(sheet.name || '').trim() || `Sheet${i + 1}`).slice(0, MAX_TAB_NAME);
                /** @type {Record<string, string>} */
                const toWrite = {};
                let rows = 0;
                let cols = 0;
                let droppedRows = sheet.droppedRows;
                for (const [r, line] of sheet.grid.entries()) {
                    /** @type {[string, string][]} */
                    const row = [];
                    line.forEach((text, c) => {
                        if (text === '') return;
                        row.push([`${colName(c)}${r + 1}`, text.length > LIMITS.MAX_CELL_CHARS ? text.slice(0, LIMITS.MAX_CELL_CHARS) : text]);
                    });
                    if (row.length > budget) { droppedRows += sheet.grid.length - r; break; }
                    budget -= row.length;
                    for (const [ref, text] of row) {
                        toWrite[ref] = text;
                        rows = r + 1;
                        cols = Math.max(cols, ref.charCodeAt(0) - 64);
                        if (text.startsWith('=')) for (const fn of functionsIn(text)) if (!supported.has(fn)) unsupported.add(fn);
                    }
                }
                const table = await cells().createSheetTable({ ownerUserId: userId, name: tabName });
                tableIds.push(table.id);
                const refs = Object.keys(toWrite);
                for (let at = 0; at < refs.length; at += CHUNK) {
                    await cells().writeCells(userId, table.id, Object.fromEntries(refs.slice(at, at + CHUNK).map((k) => [k, toWrite[k]])));
                }
                tabs.push({ id: newTabId(), name: tabName, datatableId: table.id });
                summary.push({ name: tabName, rows, cols });
                if (droppedRows || sheet.droppedCols) truncated.push({ tab: tabName, droppedRows, droppedCols: sheet.droppedCols });
            }
            const doc = await documents().createDocument({
                userId, name, docType: 'spreadsheet', kind: 'document', visibility: 'private', folderId: null,
                sheetTableId: tabs[0].datatableId,
            });
            created = true;
            let finalSummary = summary;
            const skipped = [...skippedSheets];
            if (tabs.length > 1 || tabs[0].name !== 'Sheet1') {
                // The document starts with the first table as one tab; the
                // rest (and the real tab names) go in with a settings save.
                try {
                    await documents().updateDocument(doc.id, { userId }, {
                        settings: settingsWithTabs(doc.settings || {}, tabs),
                        ...(doc.versionId ? { expectedVersionId: doc.versionId } : {}),
                    });
                } catch (e) {
                    // The document exists and owns the first table: keep it
                    // with that one tab and give the others back.
                    const err = /** @type {any} */ (e);
                    log.warn(`[sheetImport] tabs could not be saved, kept the first one: ${err?.message}`);
                    for (const id of tableIds.slice(1)) await cells().dropSheetTable(userId, id).catch(() => undefined);
                    tableIds.length = 1;
                    skipped.push(...summary.slice(1).map((t) => t.name));
                    finalSummary = summary.slice(0, 1);
                }
            }
            return {
                documentId: doc.id, name, tabs: finalSummary, truncated,
                unsupportedFunctions: [...unsupported].sort(), skippedSheets: skipped,
            };
        } catch (e) {
            if (created) throw e;
            for (const id of tableIds) await cells().dropSheetTable(userId, id).catch(() => undefined);
            throw e;
        }
    }

    return { importWorkbook };
}

module.exports = makeSheetImport();
module.exports.makeSheetImport = makeSheetImport;
module.exports.formatOf = formatOf;
module.exports.functionsIn = functionsIn;
module.exports.LIMITS = Object.freeze({ MAX_TABS, MAX_TOTAL_CELLS });
