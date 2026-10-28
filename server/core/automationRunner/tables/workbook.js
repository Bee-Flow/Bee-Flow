// @typecheck noImplicitAny
/**
 * The workbook reader: an uploaded spreadsheet (xlsx, xlsm, xls, ods) or CSV
 * into one table per sheet, with the caps of core/automationRunner/tables/limits.js.
 *
 * It sits on the spreadsheet mirror's parsers (SheetJS through
 * core/dataEngine/sources/spreadsheetFile/formats, the CSV reader) but NOT on
 * the mirror's door (formats/index readSheet/listSheets), which clamps at
 * 10 000 rows, 100 columns and 20 MB. The file is untrusted, so in order:
 *
 *   1. size against maxFileBytes;
 *   2. the format from the BYTES (zip, CFB, text), checked against what the
 *      step said;
 *   3. for a zip package, the guard in workbookZipGuard.js, before SheetJS
 *      sees the bytes (entry count, declared sizes, ratio, DOCTYPE/ENTITY);
 *   4. the parse, inside the mirror's parse limiter (withSlot);
 *   5. one table per selected sheet (workbookSheet.js), loud on every cap.
 *
 * Nothing here touches storage or the run: bytes in, tables in memory out.
 */

'use strict';

const { sourceError, assertSafePackage } = require('./workbookZipGuard');
const { readGridSheet, readProvenanceSheet, readCsvTable } = require('./workbookSheet');

const FORMATS = ['xlsx', 'xlsm', 'xls', 'ods', 'csv'];
const ZIP_FAMILY = new Set(['xlsx', 'xlsm']);
const PROVENANCE_NAME_RE = /^(provenance|metadata|about|info|readme|read me)$/i;
const MIB = 1024 * 1024;
const NUL_SNIFF_BYTES = 8192;

const lazy = {
    formats: () => require('../../dataEngine/sources/spreadsheetFile/formats'),
    sheetjs: () => require('../../dataEngine/sources/spreadsheetFile/formats/sheetjs'),
    csv: () => require('../../dataEngine/sources/spreadsheetFile/formats/csv'),
    xlsx: () => require('@e965/xlsx'),
    limits: () => require('./limits'),
};

/** @typedef {ReturnType<typeof import('./limits').tableLimits>} TableLimits */
/** @typedef {{ name: string, index: number, hidden: boolean }} SheetInfo */
/**
 * The reader options after readWorkbookTables settled the header row and the limits.
 * @typedef {{
 *   filename?: string, format?: string, sheets?: 'all'|'first'|string[], headerRow: number,
 *   delimiter?: string, provenanceSheet?: string, skipHiddenSheets?: boolean, limits: TableLimits,
 * }} WorkbookReadOpts
 */

/** @param {string} message */
function unsupported(message) {
    return sourceError('table_source_unsupported', message);
}

/**
 * The file name without its folders and extension, safe as a table name.
 * @param {string | null | undefined} filename
 * @param {string} [fallback]
 */
function baseName(filename, fallback = 'Sheet1') {
    const last = String(filename || '').split(/[\\/]/).pop() || '';
    const cleaned = last.replace(/\.[^.]*$/, '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
    return cleaned || fallback;
}

const hasUtf16Bom = /** @param {Buffer} b */ (b) => b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff));

/**
 * What the bytes are, and the zip guard for a package. An explicit `requested`
 * format that contradicts the bytes is refused; xlsx and xlsm are one family.
 * @param {Buffer} buffer
 * @param {string | undefined} requested
 * @param {TableLimits} limits
 * @returns {Promise<string>} the format to parse as
 */
async function detectFormat(buffer, requested, limits) {
    if (!buffer.length) throw unsupported('The file is empty.');
    const sheetjs = lazy.sheetjs();
    let detected;
    if (sheetjs.isZipPackage(buffer)) {
        detected = (await assertSafePackage(buffer, limits)).kind;
    } else if (sheetjs.isCfbPackage(buffer)) {
        detected = 'xls';
    } else if (!hasUtf16Bom(buffer) && buffer.subarray(0, NUL_SNIFF_BYTES).includes(0)) {
        throw unsupported('The file is binary but not a spreadsheet, so it cannot be read as a table.');
    } else {
        detected = 'csv';
    }
    const asked = FORMATS.includes(requested) ? requested : 'auto';
    if (asked === 'auto' || asked === detected) return detected;
    if (ZIP_FAMILY.has(asked) && ZIP_FAMILY.has(detected)) return detected;
    throw unsupported(`The step is set to read a .${asked} file, but the file is a ${detected === 'csv' ? 'text (CSV)' : `.${detected}`} file. `
        + 'Set the format to "auto" or to the real type.');
}

/**
 * SheetJS options: values as stored, dates as serials we convert ourselves, no formulas, a row cap.
 * @param {number} headerRow
 * @param {TableLimits} limits
 */
function parseOptions(headerRow, limits) {
    const options = { cellNF: true, cellDates: false, raw: true, cellFormula: false, cellHTML: false, cellText: false };
    if (limits.maxRows > 0) /** @type {typeof options & { sheetRows?: number }} */ (options).sheetRows = headerRow + limits.maxRows + 1;
    return options;
}

/**
 * @param {Buffer} buffer
 * @param {string} format
 * @param {number} headerRow
 * @param {TableLimits} limits
 */
async function parseWorkbook(buffer, format, headerRow, limits) {
    try {
        return await lazy.sheetjs().readWorkbook(buffer, format, parseOptions(headerRow, limits));
    } catch {
        throw unsupported(`The .${format} file could not be read as a workbook (is it damaged, or saved under the wrong extension?).`);
    }
}

/**
 * The sheets of a parsed workbook with their hidden flag.
 * @param {import('@e965/xlsx').WorkBook} wb
 * @returns {SheetInfo[]}
 */
function sheetInfos(wb) {
    const flags = wb.Workbook && Array.isArray(wb.Workbook.Sheets) ? wb.Workbook.Sheets : [];
    return (wb.SheetNames || []).map((name, index) => ({
        name, index, hidden: Number((flags[index] || {}).Hidden || 0) > 0,
    }));
}

/**
 * The index of the provenance sheet, or -1. An explicit name that is missing is a warning.
 * @param {SheetInfo[]} infos
 * @param {string | undefined} provenanceSheet
 * @param {string[]} warnings
 */
function findProvenance(infos, provenanceSheet, warnings) {
    if (provenanceSheet === 'none') return -1;
    if (!provenanceSheet || provenanceSheet === 'auto') return infos.findIndex(s => PROVENANCE_NAME_RE.test(s.name.trim()));
    const idx = infos.findIndex(s => s.name === provenanceSheet);
    if (idx < 0) warnings.push(`The provenance sheet "${provenanceSheet}" was not found in this workbook.`);
    return idx;
}

/**
 * The indexes the `sheets` setting names. A name that is not there is an error.
 * @param {SheetInfo[]} infos
 * @param {unknown[]} wanted
 */
function namedSheets(infos, wanted) {
    const picked = new Set();
    const missing = [];
    for (const raw of wanted) {
        const name = String(raw);
        const hit = infos.find(s => s.name === name) || infos.find(s => s.name.trim().toLowerCase() === name.trim().toLowerCase());
        if (hit) picked.add(hit.index); else missing.push(name);
    }
    if (missing.length) {
        const have = infos.slice(0, 20).map(s => `"${s.name}"`).join(', ');
        throw sourceError('table_sheet_missing',
            `The workbook has no sheet called ${missing.map(m => `"${m}"`).join(', ')}. Its sheets are: ${have || 'none'}.`);
    }
    return picked;
}

/**
 * Which sheets are candidates, and why the others are not. A sheet the step
 * names explicitly is read even when it is hidden.
 * @param {SheetInfo[]} infos
 * @param {{ sheets?: 'all'|'first'|string[], skipHiddenSheets: boolean, provenanceIndex: number }} opts
 * @returns {{ skipped: Map<number,string>, candidates: number[] }}
 */
function selectCandidates(infos, { sheets, skipHiddenSheets, provenanceIndex }) {
    const named = Array.isArray(sheets) ? namedSheets(infos, sheets) : null;
    const skipped = new Map();
    const candidates = [];
    for (const s of infos) {
        if (s.index === provenanceIndex) skipped.set(s.index, 'provenance');
        else if (named && !named.has(s.index)) skipped.set(s.index, 'not_selected');
        else if (!named && skipHiddenSheets && s.hidden) skipped.set(s.index, 'hidden');
        else candidates.push(s.index);
    }
    return { skipped, candidates };
}

/**
 * @param {Buffer} buffer
 * @param {string} format
 * @param {WorkbookReadOpts} o
 */
async function readBinaryWorkbook(buffer, format, o) {
    const { limits, headerRow } = o;
    const wb = await parseWorkbook(buffer, format, headerRow, limits);
    const XLSX = lazy.xlsx();
    const { cellValue } = lazy.sheetjs();
    /** @type {string[]} */
    const warnings = [];
    const infos = sheetInfos(wb);
    const provenanceIndex = findProvenance(infos, o.provenanceSheet, warnings);
    const { skipped, candidates } = selectCandidates(infos, {
        sheets: o.sheets, skipHiddenSheets: o.skipHiddenSheets !== false, provenanceIndex,
    });
    const first = o.sheets === 'first';
    const tables = new Map();
    let overLimit = false;
    for (const index of candidates) {
        if (first && tables.size >= 1) { skipped.set(index, 'not_selected'); continue; }
        if (limits.maxSheets > 0 && tables.size >= limits.maxSheets) { skipped.set(index, 'limit'); overLimit = true; continue; }
        const { name } = infos[index];
        const table = await readGridSheet(wb.Sheets[name], { XLSX, cellValue, name, headerRow, limits });
        if (table) tables.set(index, table); else skipped.set(index, 'empty');
    }
    if (overLimit) {
        warnings.push(`Only the first ${limits.maxSheets} sheets were read. An administrator can raise the limit with AUTOMATION_TABLE_MAX_SHEETS (0 = unlimited).`);
    }
    const provenance = provenanceIndex >= 0
        ? readProvenanceSheet(wb.Sheets[infos[provenanceIndex].name], { XLSX, cellValue }) : null;
    const sheets = infos.map((s) => {
        const t = tables.get(s.index);
        return {
            name: s.name, index: s.index, hidden: s.hidden,
            columns: t ? t.columns : [], rows: t ? t.rows : [],
            ...(t ? {} : { skipped: skipped.get(s.index) || 'empty' }),
        };
    });
    return { format, sheets, provenance, warnings };
}

/**
 * @param {Buffer} buffer
 * @param {WorkbookReadOpts} o
 */
async function readCsvWorkbook(buffer, o) {
    const name = baseName(o.filename);
    const table = await readCsvTable(buffer, {
        csv: lazy.csv(), name, headerRow: o.headerRow, delimiter: o.delimiter, limits: o.limits,
    });
    const sheet = { name, index: 0, hidden: false, columns: table ? table.columns : [], rows: table ? table.rows : [] };
    return { format: 'csv', sheets: [table ? sheet : { ...sheet, skipped: 'empty' }], provenance: /** @type {Record<string, string> | null} */ (null), warnings: /** @type {string[]} */ ([]) };
}

/**
 * Read an uploaded workbook or CSV into one table per sheet.
 *
 * @param {Buffer} buffer
 * @param {{
 *   filename?: string, format?: string, sheets?: 'all'|'first'|string[], headerRow?: number,
 *   delimiter?: string, provenanceSheet?: string, skipHiddenSheets?: boolean, limits?: any,
 * }} [options]
 * @returns {Promise<{
 *   format: string,
 *   sheets: Array<{ name: string, index: number, hidden: boolean, columns: any[], rows: any[], skipped?: string }>,
 *   provenance: Record<string, string> | null,
 *   warnings: string[],
 * }>}
 */
async function readWorkbookTables(buffer, options = {}) {
    if (!Buffer.isBuffer(buffer)) throw unsupported('A file is required.');
    const { tableLimits, exceeds } = lazy.limits();
    const limits = options.limits || tableLimits();
    if (exceeds(buffer.length, limits.maxFileBytes)) {
        throw sourceError('table_source_too_large',
            `The file is ${(buffer.length / MIB).toFixed(1)} MB; the most this server reads is ${Math.round(limits.maxFileBytes / MIB)} MB. `
            + 'An administrator can raise the limit with AUTOMATION_TABLE_MAX_FILE_BYTES (0 = unlimited).');
    }
    const headerRow = typeof options.headerRow === 'number' && Number.isInteger(options.headerRow) && options.headerRow >= 1 ? Math.min(options.headerRow, 50) : 1;
    const o = { ...options, headerRow, limits };
    return lazy.formats().withSlot(async () => {
        const format = await detectFormat(buffer, options.format, limits);
        return format === 'csv' ? readCsvWorkbook(buffer, o) : readBinaryWorkbook(buffer, format, o);
    });
}

module.exports = { readWorkbookTables, detectFormat, baseName };
