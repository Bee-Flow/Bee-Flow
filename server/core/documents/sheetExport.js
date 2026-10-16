/**
 * A spreadsheet document as an Excel workbook: one worksheet per tab (same
 * names, same order), the RAW cells, so a typed "=SUM(B1:B3)" arrives as a
 * real formula Excel recalculates. Used by GET /api/studio-documents/:id/
 * sheet.xlsx and by the chat's document_download tool
 * (integrations/sheetDownloadTool.js).
 *
 * Our formulas name another tab as a bare word (`Totals!A1`, the tokenizer
 * only knows letters, digits, "_" and "."), Excel wants anything else quoted
 * (`'My Tab'!A1`). Every reference to a tab of this workbook is therefore
 * written quoted, outside of string literals.
 */

'use strict';

const { sheetTabsOf } = require('../../stores/lib/sheetDocument');
const { buildXlsxWorkbook, sanitizeSheetName } = require('./office/xlsxWorkbook');
const { chartProblem } = require('./sheetChartSpec');

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_COLS = 26;

/** The A1-keyed map as a matrix: columns A-Z, rows up to the highest used row. */
function cellsToMatrix(cells) {
    let lastRow = 0;
    for (const name of Object.keys(cells || {})) {
        const m = /^([A-Z])(\d+)$/.exec(name);
        if (m && cells[name] !== '' && cells[name] != null) lastRow = Math.max(lastRow, Number(m[2]));
    }
    const matrix = [];
    for (let r = 1; r <= lastRow; r++) {
        const row = [];
        for (let c = 0; c < MAX_COLS; c++) row.push(cells[`${String.fromCharCode(65 + c)}${r}`] ?? '');
        while (row.length && row[row.length - 1] === '') row.pop();
        matrix.push(row);
    }
    return matrix;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Quote the sheet names of `names` in a formula: `Totals!A1` becomes
 * `'Totals'!A1`. String literals ("...") are left alone.
 */
function quoteSheetRefs(formula, names) {
    if (!formula.startsWith('=') || !names.length) return formula;
    const byLower = new Map(names.map((n) => [n.toLowerCase(), n]));
    const re = new RegExp(`(?<![A-Za-z0-9_.$'])(${names.map(escapeRe).join('|')})!`, 'gi');
    return formula.split(/("(?:[^"]|"")*")/).map((part, i) => {
        if (i % 2 === 1) return part;
        return part.replace(re, (_m, name) => `'${byLower.get(name.toLowerCase()).replace(/'/g, "''")}'!`);
    }).join('');
}

/** One CSV field: quoted when it has to be, quotes doubled. */
function csvField(text) {
    const s = String(text ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The computed sheet as CSV: rows 1 … the last used row, columns A … the last
 * used column. Values as they show (formulas evaluated, errors as their code).
 *
 * @param {Record<string, string>} cells
 * @param {(cells: Record<string, string>) => Record<string, { display: string }>} evaluate
 */
function sheetCsv(cells, evaluate) {
    const shown = evaluate(cells);
    let lastRow = 0;
    let lastCol = -1;
    for (const name of Object.keys(cells)) {
        const m = /^([A-Z])(\d+)$/.exec(name);
        if (!m) continue;
        lastRow = Math.max(lastRow, Number(m[2]));
        lastCol = Math.max(lastCol, m[1].charCodeAt(0) - 65);
    }
    const lines = [];
    for (let r = 1; r <= lastRow; r++) {
        const fields = [];
        for (let c = 0; c <= lastCol; c++) fields.push(csvField(shown[`${String.fromCharCode(65 + c)}${r}`]?.display ?? ''));
        lines.push(fields.join(','));
    }
    return lines.join('\r\n') + (lines.length ? '\r\n' : '');
}

/** A safe ASCII download name ending in .xlsx. */
function xlsxFileName(raw, fallback = 'spreadsheet') {
    const base = String(raw || '')
        .normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .replace(/\.xlsx$/i, '')
        .replace(/[^A-Za-z0-9._ -]+/g, ' ')
        .replace(/\.{2,}/g, '.')
        .replace(/\s+/g, ' ').trim().replace(/ /g, '-')
        .replace(/^[-.]+/, '').replace(/[-.]+$/, '')
        .slice(0, 80);
    return `${base || fallback}.xlsx`;
}

/** The computed cells of tab `i`, other tabs readable by name (the editor's view of it). */
function computedFor(raws, names, i, deps) {
    const evaluate = deps.evaluate || require('../../shared/expr/sheet.mjs').evaluateSheet;
    return evaluate(raws[i], { workbook: Object.fromEntries(names.map((n, k) => [n, raws[k]])), activeSheet: names[i] });
}

/**
 * @param {{ name?: string, userId: string, settings?: any }} doc  a spreadsheet document
 * The tab's charts (`settings.sheet.charts`, those without a tab on the first
 * tab) go along as native Excel charts, with the computed values as cache.
 *
 * @param {{ cells?: { readSheet(owner: string, table: string): Promise<{ cells: Record<string, string> }> }, evaluate?: Function }} [deps]
 * @returns {Promise<{ buffer: Buffer, contentType: string, filename: string }>}
 */
async function buildSheetWorkbook(doc, deps = {}) {
    const sheetCells = deps.cells || require('./sheetCells');
    const tabs = sheetTabsOf(doc);
    const names = tabs.map((t) => sanitizeSheetName(t.name));
    const charts = (Array.isArray(doc.settings?.sheet?.charts) ? doc.settings.sheet.charts : []).filter((c) => !chartProblem(c));
    const raws = [];
    for (let i = 0; i < tabs.length; i++) raws.push((await sheetCells.readSheet(doc.userId, tabs[i].datatableId)).cells || {});
    const sheets = raws.map((cells, i) => {
        const quoted = {};
        for (const [k, v] of Object.entries(cells)) quoted[k] = typeof v === 'string' ? quoteSheetRefs(v, names) : v;
        const mine = charts.filter((c) => (c.tab ? c.tab === tabs[i].id : i === 0));
        const values = mine.length ? computedFor(raws, names, i, deps) : undefined;
        return { name: names[i], matrix: cellsToMatrix(quoted), charts: mine, values };
    });
    const buffer = await buildXlsxWorkbook(sheets, { formulas: true });
    return { buffer, contentType: XLSX_MIME, filename: xlsxFileName(doc.name) };
}

module.exports = { buildSheetWorkbook, sheetCsv, cellsToMatrix, quoteSheetRefs, xlsxFileName, XLSX_MIME };
