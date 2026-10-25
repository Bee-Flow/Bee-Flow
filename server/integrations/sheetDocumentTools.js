// @typecheck noImplicitAny
/**
 * The chat's document tools (integrations/documentBuilderTools.js) on a
 * SPREADSHEET document. A sheet has no body or stylesheet: its cells live in a
 * datatable (core/documents/sheetCells.js). So `document_read` answers with the
 * cells — what was typed, and for every formula what it computes to — and
 * `document_write` takes `cells` ({ A1: "Rent", B1: "1200", B3: "=SUM(B1:B2)" },
 * "" clears one). `document_edit` (find-and-replace in a text slot) has
 * nothing to work on and says so.
 *
 * Reads and writes run as the document's owner, after the caller's own access
 * was checked through documentStore.getDocument (a project viewer reads only).
 */

'use strict';

const { sheetTabsOf, newTabId, settingsWithTabs } = require('../stores/lib/sheetDocument');

/** Cells per document_write call; the store takes 500 at a time, so a call is written in chunks. */
const MAX_CELLS_PER_CALL = 5000;
const CHUNK = 500;
/** Tabs a spreadsheet may have when the chat adds one (the same ceiling as an imported workbook). */
const MAX_TABS = 20;

const SHEET_HOW = 'To change cells, call document_write({ documentId, cells: { "A1": "Rent", "B1": "1200", "B3": "=SUM(B1:B2)" } }) — '
    + 'columns A–Z, rows from 1; a value or a formula starting with "="; "" clears a cell; pass `tab` (id or name) for another tab than the first, '
    + 'and `charts: [{ type, dataRange: "B2:C10", categoriesRange: "A2:A10", anchor: "E2", title, size: { cols: 6, rows: 14 }, format: "number"|"currency"|"percent" }]` to put CHARTS IN THE SHEET '
    + '(type: bar, hbar, line, area, pie, doughnut, scatter, stacked, or kpi = one value tile with `label`, `compareRange`; every data column is a series; scatter needs categoriesRange as numeric x; '
    + 'ALL ranges must be on the tab you write to: put summary tables on that tab, e.g. a "Dashboard" tab; an item with an existing chart\'s `id` moves/resizes/changes it; `removeCharts: [ids]` deletes; document_read lists the tab\'s charts), '
    + 'and `createTab: true` with a new `tab` name to add that tab (for a summary or pivot table: COUNTIF/SUMIF/AVERAGEIF over another tab, e.g. =COUNTIF(Klanten!$L$2:$L$201,A2)). '
    + 'Formulas: + - * / ^ & (text), comparisons, ranges like A1:B9, and SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, COUNTIF(S), SUMIF(S), AVERAGEIF(S), IF, IFERROR, AND, OR, NOT, ROUND, ABS, VLOOKUP, CONCAT, LEN, LEFT, RIGHT, MID, UPPER, LOWER, TRIM, YEAR, MONTH, DAY, DATE, TODAY. A date typed as 2026-03-01 counts as a date in comparisons.';

/**
 * The tab a call asks for: its id or its name (any case), the first by default.
 * @param {any} doc
 * @param {unknown} wanted
 * @returns {{ tabs: any[], tab: any } | { error: string }}
 */
function pickTab(doc, wanted) {
    const tabs = sheetTabsOf(doc);
    if (!tabs.length) return { error: 'This spreadsheet has no table for its cells.' };
    const key = wanted === undefined || wanted === null ? '' : String(wanted).trim();
    if (!key) return { tabs, tab: tabs[0] };
    const tab = tabs.find((t) => t.id === key) || tabs.find((t) => String(t.name).toLowerCase() === key.toLowerCase());
    if (!tab) return { error: `This spreadsheet has no tab "${key}". Its tabs: ${tabs.map((t) => t.name).join(', ')}. To add it, call document_write again with createTab: true.` };
    return { tabs, tab };
}

/**
 * Evaluation options for a tab whose formulas point at other tabs
 * (`Klanten!A1`): those tabs' typed cells by name (core/documents/sheetWorkbook.js).
 * @param {{ userId: string; }} doc
 * @param {{ tabs: any[], tab: any }} picked
 * @param {Record<string, string>} cells  the read tab's cells
 * @param {any} sheetCells
 */
async function workbookFor(doc, picked, cells, sheetCells) {
    const refTabs = await require('../core/documents/sheetWorkbook').readReferencedTabs(doc, picked.tabs, picked.tab.id, cells, sheetCells);
    if (!Object.keys(refTabs).length) return undefined;
    return { workbook: { ...refTabs, [picked.tab.name]: cells }, activeSheet: picked.tab.name };
}

/**
 * Add a tab named `name` to the spreadsheet: a new cell table, then the
 * document's tab list, as the editor's "+" does (routes/studioDocuments/
 * sheet.js). The table is dropped again when the document refuses the tab.
 * @param {any} doc
 * @param {string} name
 * @param {{ cells: any, documents?: any, actorUserId?: string }} deps
 * @returns {Promise<{ tabs: any[], tab: any } | { error: string }>}
 */
async function addTab(doc, name, deps) {
    const tabs = sheetTabsOf(doc);
    if (tabs.length >= MAX_TABS) return { error: `This spreadsheet already has ${MAX_TABS} tabs, the most it can have.` };
    const clean = name.trim().slice(0, 100);
    if (!clean) return { error: 'Give the new tab a name in `tab`.' };
    const documents = deps.documents || require('../stores/documentStore');
    const table = await deps.cells.createSheetTable({ ownerUserId: doc.userId, name: clean });
    const tab = { id: newTabId(), name: clean, datatableId: table.id };
    const nextTabs = [...tabs, tab];
    let updated = null;
    try {
        updated = await documents.updateDocument(doc.id, deps.actorUserId || doc.userId, {
            settings: settingsWithTabs(doc.settings, nextTabs),
            expectedVersionId: doc.versionId,
        });
    } catch (e) {
        // A refusal the model can act on (no right to change it, a conflict) comes back as text.
        if (!(e && Number(e.status) >= 400 && Number(e.status) < 500)) throw e;
        await deps.cells.dropSheetTable(doc.userId, table.id);
        return { error: /** @type {Error} */ (e).message };
    }
    if (!updated) {
        await deps.cells.dropSheetTable(doc.userId, table.id);
        return { error: 'The new tab could not be added: the spreadsheet was not found.' };
    }
    return { tabs: nextTabs, tab };
}

/**
 * @param {any} doc  the spreadsheet, as getDocument returned it to the caller
 * @param {{ cells?: any, evaluate?: Function }} [deps]
 * @param {{ tab?: unknown, mode?: unknown, range?: unknown }} [args]  the document_read arguments
 */
async function readSheetDocument(doc, deps = {}, args = {}) {
    const sheetCells = deps.cells || require('../core/documents/sheetCells');
    const evaluate = deps.evaluate || require('../shared/expr/sheet.mjs').evaluateSheet;
    if (args?.mode === 'outline') return readOutline(doc, sheetCells, evaluate);
    const picked = pickTab(doc, args?.tab);
    if ('error' in picked) return { error: picked.error };
    const read = await sheetCells.readSheet(doc.userId, picked.tab.datatableId);
    const shown = evaluate(read.cells, await workbookFor(doc, picked, read.cells, sheetCells));
    const part = partOf(read.cells, args?.range);
    if ('error' in part) return { error: part.error };
    const { cells, note } = part;
    /** @type {Record<string, string>} */
    const computed = {};
    for (const [name, raw] of Object.entries(cells)) {
        if (String(raw).startsWith('=')) computed[name] = shown[name]?.display ?? '';
    }
    const readOnly = doc.projectRole === 'viewer';
    return {
        documentId: doc.id, name: doc.name, docType: 'spreadsheet', rows: read.rows,
        tab: { id: picked.tab.id, name: picked.tab.name },
        tabs: picked.tabs.map((t) => ({ id: t.id, name: t.name })),
        cells, computed, charts: chartsOfTab(doc, picked.tab),
        ...(readOnly ? { readOnly: true } : {}),
        message: `Read the spreadsheet "${doc.name}": \`cells\` is what was typed in each cell, \`computed\` what each formula shows. ${note}`
            + (readOnly ? 'You may read it but not change it (the user is a viewer of its project).' : SHEET_HOW),
    };
}

/**
 * The charts on a tab (id, type, title, anchor, size in cells) so new ones can be laid out around them.
 * @param {{ settings?: { sheet?: { charts?: Array<import('../core/documents/sheetChartFields').ChartFields & { id?: string, tab?: string }> } } }} doc
 * @param {{ id: string; name: string; datatableId: string; }} tab
 */
function chartsOfTab(doc, tab) {
    const { chartSummary } = require('../core/documents/sheetChartSpec');
    return (doc.settings?.sheet?.charts || []).filter((c) => !c.tab || c.tab === tab.id).map(chartSummary);
}

/** A tab larger than this many filled cells is read as its first rows unless a `range` is asked for. */
const LARGE_TAB_CELLS = 1500;
const LARGE_TAB_ROWS = 30;

/**
 * The cells a read returns: the `range` asked for, the first rows of a large
 * tab, or every cell.
 * @param {Record<string, string>} all
 * @param {unknown} range
 * @returns {{ cells: Record<string, string>, note: string } | { error: string }}
 */
function partOf(all, range) {
    const { parseRange } = require('../core/documents/sheetAssist/sheetRefs');
    const inRows = (/** @type {{ c0: number, r0: number, c1: number, r1: number }} */ r) => Object.fromEntries(Object.entries(all).filter(([name]) => {
        const m = /^([A-Z])(\d+)$/.exec(name);
        if (!m) return false;
        const col = m[1].charCodeAt(0) - 65, row = Number(m[2]) - 1;
        return col >= r.c0 && col <= r.c1 && row >= r.r0 && row <= r.r1;
    }));
    if (typeof range === 'string' && range.trim()) {
        const r = parseRange(range);
        if (!r) return { error: `"${range}" is not a range of this sheet: write it like "A1:F30" (columns A–Z).` };
        return { cells: inRows(r), note: `Only ${range.trim().toUpperCase()} is included. ` };
    }
    const filled = Object.values(all).filter((v) => v !== '').length;
    if (filled <= LARGE_TAB_CELLS) return { cells: all, note: '' };
    return {
        cells: inRows({ c0: 0, c1: 25, r0: 0, r1: LARGE_TAB_ROWS - 1 }),
        note: `This tab has ${filled} filled cells, so only rows 1–${LARGE_TAB_ROWS} are included: read other rows with \`range\` ("A31:Z80"), `
            + 'or better, let formulas (COUNTIFS, SUMIFS, AVERAGEIFS over the whole column) do the counting instead of reading every row. ',
    };
}

/**
 * Every tab's outline: headers, column types, how full, min/max and the
 * values of category columns (core/documents/sheetOutline.js) — no rows.
 * @param {any} doc
 * @param {any} sheetCells
 * @param {Function} evaluate
 */
async function readOutline(doc, sheetCells, evaluate) {
    const { tabOutline } = require('../core/documents/sheetOutline');
    const tabs = sheetTabsOf(doc);
    if (!tabs.length) return { error: 'This spreadsheet has no table for its cells.' };
    const outline = [];
    for (const tab of tabs) {
        const { cells } = await sheetCells.readSheet(doc.userId, tab.datatableId);
        const shown = evaluate(cells, await workbookFor(doc, { tabs, tab }, cells, sheetCells));
        outline.push({ ...tabOutline(tab.name, cells, shown), charts: chartsOfTab(doc, tab) });
    }
    return {
        documentId: doc.id, name: doc.name, docType: 'spreadsheet', outline,
        message: `The outline of "${doc.name}": per tab its used range and per column the header (row 1), type, how many rows are filled, `
            + 'min/max, and for category columns their values with counts. No rows are included: build summaries, pivots and dashboards '
            + 'with formulas over whole columns (e.g. =COUNTIFS(Tab!$L$2:$L$201,"ZZP")), and read rows only when you need to see values '
            + '(document_read with `tab` and `range`). ' + SHEET_HOW,
    };
}

/**
 * @param {any} doc
 * @param {any} args  the document_write arguments
 * @param {{ cells?: any, documents?: any, actorUserId?: string }} [deps]
 */
async function writeSheetDocument(doc, args, deps = {}) {
    const sheetCells = deps.cells || require('../core/documents/sheetCells');
    const hasCells = !!args && !!args.cells && typeof args.cells === 'object' && !Array.isArray(args.cells);
    if (!hasCells && !Array.isArray(args?.charts) && !Array.isArray(args?.removeCharts)) {
        return { error: `This document is a spreadsheet: it has no bodyHtml or css. ${SHEET_HOW}` };
    }
    /** @type {Record<string, string>} */
    const cells = {};
    for (const [name, value] of Object.entries(hasCells ? args.cells : {})) cells[name] = value === null || value === undefined ? '' : String(value);
    const names = Object.keys(cells);
    if (names.length > MAX_CELLS_PER_CALL) {
        return { error: `At most ${MAX_CELLS_PER_CALL} cells per call; this one has ${names.length}. Split it over several calls.` };
    }
    let picked = pickTab(doc, args.tab);
    let created = false;
    if ('error' in picked && args.createTab === true && typeof args.tab === 'string') {
        picked = await addTab(doc, args.tab, { ...deps, cells: sheetCells });
        created = !('error' in picked);
    }
    if ('error' in picked) return { error: picked.error };
    const spec = require('../core/documents/sheetChartSpec');
    const wantsCharts = Array.isArray(args.charts) || Array.isArray(args.removeCharts);
    const newCharts = wantsCharts ? spec.chartsFrom(args.charts, picked.tab.id, doc.settings?.sheet?.charts || [], args.removeCharts) : null;
    if (newCharts && 'error' in newCharts) return { error: newCharts.error };
    // Without strictNullChecks the check above does not narrow `newCharts` afterwards; the return guarantees no error shape is left.
    const planned = /** @type {Exclude<typeof newCharts, { error: string }>} */ (newCharts);
    try {
        let saved = 0;
        for (let i = 0; i < names.length; i += CHUNK) {
            const part = Object.fromEntries(names.slice(i, i + CHUNK).map((k) => [k, cells[k]]));
            const done = await sheetCells.writeCells(doc.userId, picked.tab.datatableId, part);
            saved += Object.keys(done.cells).length;
        }
        const addResult = planned ? await spec.addCharts(doc, planned.charts, deps, planned) : null;
        if (addResult && 'error' in addResult) return { error: `Saved ${saved} cell(s), but the charts were not added: ${addResult.error}` };
        // Same: the return above leaves only the success shape (or null).
        const charted = /** @type {Exclude<typeof addResult, { error: string }>} */ (addResult);
        return {
            documentId: doc.id, saved, tab: { id: picked.tab.id, name: picked.tab.name },
            ...(created ? { createdTab: true, tabs: picked.tabs.map((t) => ({ id: t.id, name: t.name })) } : {}),
            ...(charted ? { charts: charted.saved, chartIds: planned.charts.map((c) => c.id), chartsUpdated: charted.updated, chartsRemoved: charted.removed } : {}),
            message: `Saved ${saved} cell(s)${charted ? ` and ${charted.saved} chart(s) (${charted.updated} updated, ${charted.removed} removed)` : ''} in ${created ? 'the new ' : ''}tab "${picked.tab.name}" of "${doc.name}".`
                + (charted ? ' The charts show in the sheet next to the user; they follow the cells when values change.' : ''),
        };
    } catch (e) {
        if (e && Number(e.status) >= 400 && Number(e.status) < 500) return { error: /** @type {Error} */ (e).message };
        throw e;
    }
}

const SHEET_EDIT_REFUSAL = { error: `document_edit changes text in a page or a designed document; this one is a spreadsheet. ${SHEET_HOW}` };

module.exports = { MAX_CELLS_PER_CALL, MAX_TABS, readSheetDocument, writeSheetDocument, SHEET_EDIT_REFUSAL };
