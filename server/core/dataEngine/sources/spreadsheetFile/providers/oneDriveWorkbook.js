// @typecheck
/**
 * Cell-precise access through the Excel workbook API (…/workbook/…), for
 * ./oneDrive.js. It answers for xlsx/xlsm on OneDrive for Business; consumer
 * accounts are routinely refused, so `detectWorkbook` is asked per file and
 * the engine falls back to exceljs + PUT. Writes run inside one persisted
 * session and close it in `finally`; they have no If-Match, so the guard is
 * emulated (probe cTag before, refuse when moved, re-probe after). A
 * formula-shaped text is typed Text in a PATCH of its own before the value.
 *
 * Every function takes the context `g` that makeApi builds:
 *   { cred, workbookKnown, graph(), call(), json(), itemPath(), refOf(), probe() }
 */

'use strict';

const { SpreadsheetSourceError, fromHttp } = require('../errors');
const { formatOf } = require('./index');
const {
    provider, DATE_FORMAT_RE, TIME_FORMAT_RE,
    colLetter, parseAddress, markerEquals, graphError, workbookValue, needsTextFormat, workbookFormat,
} = require('./oneDriveFormat');
const { bestEffort, fallback } = require('../../../../../utils/bestEffort');

/**
 * @param {{ persistChanges: boolean; }} body
 */
const jsonBody = (body) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const wbPath = async (g, file) => `${await g.itemPath(file)}/workbook`;
const wsPath = (wb, sheet) => `${wb}/worksheets/${encodeURIComponent(typeof sheet === 'string' ? sheet : (sheet.id || sheet.name))}`;
const sheetLabel = (sheet) => `sheet '${typeof sheet === 'string' ? sheet : sheet.name}'`;

/**
 * Does the workbook API answer for this file? Asked once per file per api
 * instance. ApiNotSupported / AccessDenied (consumer OneDrive) and any
 * other 4xx mean "no"; a dead credential still surfaces as an error.
 */
async function detectWorkbook(g, file) {
    const format = file && (file.format || formatOf(file));
    if (format !== 'xlsx' && format !== 'xlsm') return false;
    const key = file.fileId || file.id;
    if (g.workbookKnown.has(key)) return g.workbookKnown.get(key);
    let res;
    try {
        res = await g.graph().graphRequest(`${await wbPath(g, file)}/worksheets?$select=id,name,position,visibility`, g.cred, {});
    } catch (e) {
        if (e && /** @type {Error} */ (e).message === 'NOT_CONNECTED') throw fromHttp(provider, 401, '', 'file', { ref: g.refOf(file) });
        throw e;
    }
    let answer = false;
    if (res.ok) answer = true;
    else if (res.status >= 500 || res.status === 429) {
        const { message } = await graphError(res);
        throw fromHttp(provider, res.status, message, 'file', { ref: g.refOf(file) });
    } else {
        await res.text().catch(() => '');   // ApiNotSupported, AccessDenied, 404 on the workbook facet
        answer = false;
    }
    g.workbookKnown.set(key, answer);
    return answer;
}

/** Run `fn(session)` inside one persisted workbook session; always closed. */
async function withSession(g, file, fn) {
    const wb = await wbPath(g, file);
    const opened = await g.json(`${wb}/createSession`, { method: 'POST', ...jsonBody({ persistChanges: true }) }, { what: 'workbook', file });
    const headers = { 'workbook-session-id': opened.id };
    try {
        return await fn({ wb, headers });
    } finally {
        await g.call(`${wb}/closeSession`, { method: 'POST', headers }, { what: 'workbook', file, okStatuses: [200, 204] }).catch((e) => bestEffort('core/dataEngine/sources/spreadsheetFile/providers/oneDriveWorkbook:withSession', e));
    }
}

async function listSheets(g, file) {
    const wb = await wbPath(g, file);
    const data = await g.json(`${wb}/worksheets?$select=id,name,position,visibility`, {}, { what: 'workbook', file });
    const out = [];
    for (const ws of (data.value || []).slice(0, 50)) {
        let rowCount = null;
        let colCount = null;
        try {
            const used = await g.json(`${wsPath(wb, ws)}/usedRange(valuesOnly=true)?$select=address,rowCount,columnCount`, {}, { what: 'sheet', file });
            const a = parseAddress(used.address);
            rowCount = a ? a.last.row : (used.rowCount != null ? used.rowCount : null);
            colCount = a ? a.last.col + 1 : (used.columnCount != null ? used.columnCount : null);
        } catch (err) { fallback('core/dataEngine/sources/spreadsheetFile/providers/oneDriveWorkbook:listSheets', err); /* an empty sheet answers 404 for usedRange */ }
        out.push({ id: ws.id, name: ws.name, index: ws.position || 0, rowCount, colCount, hidden: ws.visibility !== undefined && ws.visibility !== 'Visible' });
    }
    return out;
}

/** The date kind a number format renders, or null. */
function dateKindOf(nf) {
    if (typeof nf !== 'string' || nf === 'General') return null;
    const bare = nf.replace(/\[[^\]]*\]|"[^"]*"/g, '');
    if (!DATE_FORMAT_RE.test(bare)) return null;
    return TIME_FORMAT_RE.test(bare) ? 'DATE_TIME' : 'DATE';
}

async function sample(g, file, sheet, { headerRow = 1, rows = 500, maxCols = 100 } = {}) {
    const wb = await wbPath(g, file);
    const address = `A1:${colLetter(maxCols - 1)}${headerRow + rows}`;
    const data = await g.json(`${wsPath(wb, sheet)}/range(address='${address}')?$select=values,numberFormat,formulas`, {}, { what: sheetLabel(sheet), file });
    const values = data.values || [];
    const formats = data.numberFormat || [];
    const formulas = data.formulas || [];
    const tally = new Map();
    const formulaCols = new Set();
    values.forEach((row, ri) => {
        if (ri < headerRow) return;
        (row || []).forEach((v, ci) => {
            if (v === '' || v === null || v === undefined) return;
            const fx = formulas[ri] && formulas[ri][ci];
            if (typeof fx === 'string' && fx.startsWith('=')) formulaCols.add(ci);
            const kind = dateKindOf(formats[ri] && formats[ri][ci]);
            if (kind) {
                const t = tally.get(ci) || {};
                t[kind] = (t[kind] || 0) + 1;
                tally.set(ci, t);
            }
        });
    });
    const numberFormat = new Map();
    for (const [col, t] of tally) numberFormat.set(col, Object.entries(t).sort((a, b) => b[1] - a[1])[0][0]);
    // Trailing all-empty rows of a fixed-size range are noise.
    let last = values.length;
    while (last > 0 && (values[last - 1] || []).every((v) => v === '' || v === null)) last -= 1;
    return { rows: values.slice(0, last).map((r) => (r || []).map((v) => (v === '' ? null : v))), numberFormat, formulaCols };
}

/** Rows 1..(headerRow + maxRows), read from the used range so an empty sheet costs nothing. */
async function readSheet(g, file, sheet, { headerRow = 1, maxRows = 10000, maxCols = 100 } = {}) {
    const wb = await wbPath(g, file);
    const ws = wsPath(wb, sheet);
    const what = sheetLabel(sheet);
    let used;
    try {
        used = await g.json(`${ws}/usedRange(valuesOnly=true)?$select=address,rowCount,columnCount`, {}, { what, file });
    } catch (e) {
        if (e && e.status === 404 && e.code === 'spreadsheet_not_found') return { rows: [], errorCells: 0 };
        throw e;
    }
    const a = parseAddress(used.address);
    const lastRow = Math.min(a ? a.last.row : (used.rowCount || 0), headerRow + maxRows);
    const lastCol = Math.min(a ? a.last.col : (used.columnCount || 1) - 1, maxCols - 1);
    if (!lastRow) return { rows: [], errorCells: 0 };
    const data = await g.json(`${ws}/range(address='A1:${colLetter(lastCol)}${lastRow}')?$select=values`, {}, { what, file });
    let errorCells = 0;
    const rows = (data.values || []).map((r) => (r || []).map((v) => {
        if (v === '' || v === null || v === undefined) return null;
        if (typeof v === 'string' && /^#(N\/A|REF!|VALUE!|DIV\/0!|NAME\?|NUM!|NULL!)$/.test(v)) { errorCells += 1; return null; }
        return v;
    }));
    return { rows, errorCells };
}

async function readRow(g, file, sheet, rowNumber, { maxCols = 100 } = {}) {
    const wb = await wbPath(g, file);
    const n = Number(rowNumber);
    const data = await g.json(`${wsPath(wb, sheet)}/range(address='A${n}:${colLetter(maxCols - 1)}${n}')?$select=values`, {}, { what: 'row', file });
    return ((data.values || [])[0] || []).map((v) => (v === '' ? null : v));
}

/** The emulated guard for workbook writes (no If-Match there). */
async function guard(g, file, ifMatch) {
    const p = await g.probe(file);
    if (ifMatch && !markerEquals(p.marker, ifMatch)) {
        throw new SpreadsheetSourceError(409, 'spreadsheet_conflict',
            'The file changed in OneDrive since this table was last refreshed — it is being refreshed now; try again in a moment.', { ref: g.refOf(file) });
    }
    return p;
}

/** A PATCH of one range inside the open session. */
function patcher(g, file, url, headers) {
    return (body) => g.json(url, {
        method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }, { what: 'row', file });
}

/**
 * Write the given cells of one row — one PATCH per cell (a whole-row
 * PATCH would overwrite the columns the mirror does not map). A
 * formula-shaped text is typed Text in a PATCH of its own first.
 */
async function updateCells(g, file, sheet, rowNumber, cells, { ifMatch = null } = {}) {
    await guard(g, file, ifMatch);
    const n = Number(rowNumber);
    await withSession(g, file, async ({ wb, headers }) => {
        for (const c of cells || []) {
            const patch = patcher(g, file, `${wsPath(wb, sheet)}/range(address='${colLetter(c.col)}${n}')`, headers);
            const v = workbookValue(c.value, c.type);
            if (needsTextFormat(v, c.type)) await patch({ numberFormat: [['@']] });
            await patch({ values: [[v]] });
        }
    });
    return { marker: (await g.probe(file)).marker };
}

/** The last used row of a sheet (0 for an empty one), inside the open session. */
async function lastUsedRow(g, file, ws, headers) {
    try {
        const used = await g.json(`${ws}/usedRange(valuesOnly=true)?$select=address,rowCount`, { headers }, { what: 'sheet', file });
        const a = parseAddress(used.address);
        return a ? a.last.row : (used.rowCount || 0);
    } catch (e) {
        if (e && e.code === 'spreadsheet_not_found') return 0;
        throw e;
    }
}

/**
 * Append below the last used row (or below `afterRow` when the engine
 * knows the last DATA row better than usedRange does). Date columns get
 * a number format so the serial renders as a date, formula-shaped texts
 * get Text — sent as a PATCH of their own BEFORE the values.
 * @returns {Promise<{ rowNumber:number, marker:object }>}
 */
async function appendRow(g, file, sheet, cells, { ifMatch = null, afterRow = null } = {}) {
    await guard(g, file, ifMatch);
    const width = (cells || []).reduce((m, c) => Math.max(m, Number(c.col) + 1), 0);
    const rowNumber = await withSession(g, file, async ({ wb, headers }) => {
        const ws = wsPath(wb, sheet);
        const last = afterRow != null ? Number(afterRow) : await lastUsedRow(g, file, ws, headers);
        const n = last + 1;
        const values = new Array(width).fill('');
        const numberFormat = new Array(width).fill(null);
        for (const c of cells || []) {
            values[Number(c.col)] = workbookValue(c.value, c.type);
            numberFormat[Number(c.col)] = workbookFormat(c.type, values[Number(c.col)]);
        }
        const patch = patcher(g, file, `${ws}/range(address='A${n}:${colLetter(Math.max(width, 1) - 1)}${n}')`, headers);
        if (numberFormat.some(Boolean)) await patch({ numberFormat: [numberFormat] });
        await patch({ values: [values] });
        return n;
    });
    return { rowNumber, marker: (await g.probe(file)).marker };
}

async function deleteRow(g, file, sheet, rowNumber, { ifMatch = null } = {}) {
    await guard(g, file, ifMatch);
    const n = Number(rowNumber);
    await withSession(g, file, async ({ wb, headers }) => {
        const ws = wsPath(wb, sheet);
        const opts = { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ shift: 'Up' }) };
        try {
            await g.json(`${ws}/range(address='${n}:${n}')/delete`, opts, { what: 'row', file });
        } catch (e) {
            // Some tenants refuse a whole-row address; the widest explicit one means the same.
            if (e && e.status === 422) await g.json(`${ws}/range(address='A${n}:XFD${n}')/delete`, opts, { what: 'row', file });
            else throw e;
        }
    });
    return { marker: (await g.probe(file)).marker };
}

/**
 * The FileApi's `cells` member, bound to one api context.
 * @param {GraphCtx} g
 */
function makeWorkbookCells(g) {
    const detect = (file) => detectWorkbook(g, file);
    return {
        available: detect,
        detectWorkbook: detect,
        listSheets: (...a) => listSheets(g, ...a),
        sample: (...a) => sample(g, ...a),
        readSheet: (...a) => readSheet(g, ...a),
        readRow: (...a) => readRow(g, ...a),
        updateCells: (...a) => updateCells(g, ...a),
        appendRow: (...a) => appendRow(g, ...a),
        deleteRow: (...a) => deleteRow(g, ...a),
    };
}

module.exports = { makeWorkbookCells };

/** @typedef {import('./oneDrive').GraphCtx} GraphCtx */

/** @typedef {import('./index').FileRef} FileRef */

/** @typedef {import('./oneDriveFormat').GraphMarker} GraphMarker */

/** @typedef {string | { id?: string, name?: string }} SheetRef a sheet name, or a worksheet as listSheets returns it */

/** @typedef {{ col: number|string, value: unknown, type: string }} CellWrite */

/** @typedef {{ wb: string, headers: Record<string, string> }} WorkbookSession */

/**
 * @template {unknown[]} A
 * @typedef {A extends [unknown, ...infer R] ? R : never} DropCtx the parameters after `g`
 */
