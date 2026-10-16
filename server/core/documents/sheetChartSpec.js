/**
 * Charts on a spreadsheet, as the chat's document_write adds them.
 *
 * A chart lives in the document's settings (`settings.sheet.charts`, the list
 * the editor's "Add chart" writes) and reads its numbers from the cells: the
 * editor draws it from what `dataRange` computes, with `categoriesRange` as
 * labels, floating at `anchor`. `tab` pins it to the tab whose cells it reads;
 * a chart without one (made before tabs) shows on every tab.
 *
 * Same rules as the spreadsheet assistant's add_chart
 * (core/documents/sheetAssist/sheetAssistant.js).
 */

'use strict';

const crypto = require('crypto');
const { CHART_TYPES, CHART_TYPES_TEXT, COL_PX, ROW_PX, chartProblem, chartFieldsOf, sizeInPx } = require('./sheetChartFields');

/** Charts one spreadsheet may hold. */
const MAX_CHARTS = 40;

/**
 * The charts a call asks for, checked. An item with the `id` of a chart already
 * on this tab UPDATES it (only the fields given change: move, resize, retype);
 * any other item is new. `remove` lists ids to delete.
 * @param {unknown} list  document_write's `charts` (may be empty when only removing)
 * @param {string} tabId
 * @param {any[]} existing  the charts the sheet holds already
 * @param {unknown} [remove]  document_write's `removeCharts`
 * @returns {{ charts: object[], updated: object[], removed: string[] } | { error: string }}
 */
function chartsFrom(list, tabId, existing, remove) {
    const have = Array.isArray(existing) ? existing : [];
    const items = Array.isArray(list) ? list : [];
    // Deduplicated: a repeated id is one removal, or it would count twice against MAX_CHARTS.
    const removed = Array.isArray(remove) ? [...new Set(remove.map(String))] : [];
    if (!items.length && !removed.length) return { error: '`charts` is a list of { type, dataRange, categoriesRange?, anchor, title?, size?: { cols, rows } } (an item with the `id` of a chart updates it); `removeCharts` is a list of ids.' };
    for (const id of removed) {
        if (!have.some((c) => c.id === id && (!c.tab || c.tab === tabId))) return { error: `removeCharts: no chart "${id}" on this tab.` };
    }
    const charts = [];
    const updated = [];
    const seen = new Set();
    for (const [i, c] of items.entries()) {
        const at = `Chart ${i + 1}`;
        if (c?.id) {
            if (seen.has(String(c.id))) return { error: `${at}: chart "${c.id}" is updated twice in this call; give each chart once.` };
            seen.add(String(c.id));
        }
        const old = c?.id ? have.find((x) => x.id === String(c.id) && (!x.tab || x.tab === tabId)) : null;
        if (c?.id && !old) return { error: `${at}: no chart "${c.id}" on this tab to update; leave out id for a new chart, or pass the chart's own tab.` };
        if (old && removed.includes(old.id)) return { error: `${at}: chart "${old.id}" is both updated and removed.` };
        const fields = chartFieldsOf(c || {});
        if (old) {
            const merged = { ...old, ...fields, tab: old.tab || tabId };
            const problem = chartProblem(merged);
            if (problem) return { error: `${at}: ${problem}` };
            updated.push(merged);
            continue;
        }
        const problem = chartProblem(fields);
        if (problem) return { error: `${at}: ${problem}` };
        charts.push({ id: `chart-${crypto.randomBytes(5).toString('hex')}`, ...sizeInPx({}), ...fields, tab: tabId });
    }
    if (have.length - removed.length + charts.length > MAX_CHARTS) return { error: `A spreadsheet holds at most ${MAX_CHARTS} charts; it has ${have.length}.` };
    return { charts, updated, removed };
}

/** How the chat sees a stored chart: enough to lay a new one out around it, or to update it. */
function chartSummary(c) {
    const { width, height } = sizeInPx(c);
    return {
        id: c.id, type: c.type, title: c.title, dataRange: c.dataRange,
        ...(c.categoriesRange ? { categoriesRange: c.categoriesRange } : {}),
        anchor: c.anchor, size: { cols: Math.round(width / COL_PX), rows: Math.round(height / ROW_PX) },
    };
}

/**
 * Store new charts on the document, on top of its NEWEST settings (a tab may
 * have been added in the same call).
 * @param {any} doc
 * @param {object[]} charts  new ones
 * @param {{ documents?: any, actorUserId?: string }} deps
 * @param {{ updated?: any[], removed?: string[] }} [changes]  from chartsFrom
 * @returns {Promise<{ saved: number, updated: number, removed: number } | { error: string }>}
 */
async function addCharts(doc, charts, deps, changes = {}) {
    const documents = deps.documents || require('../../stores/documentStore');
    const actor = deps.actorUserId || doc.userId;
    const latest = (await documents.getDocument(doc.id, actor)) || doc;
    const sheet = latest.settings?.sheet || {};
    try {
        const updated = await documents.updateDocument(doc.id, actor, {
            settings: { ...latest.settings, sheet: { ...sheet, charts: [...(sheet.charts || []).filter((c) => !(changes.removed || []).includes(c.id)).map((c) => (changes.updated || []).find((u) => u.id === c.id) || c), ...charts] } },
            expectedVersionId: latest.versionId,
        });
        if (!updated) return { error: 'The spreadsheet was not found.' };
    } catch (e) {
        if (e && Number(e.status) >= 400 && Number(e.status) < 500) return { error: e.message };
        throw e;
    }
    return { saved: charts.length, updated: (changes.updated || []).length, removed: (changes.removed || []).length };
}

module.exports = { chartsFrom, addCharts, chartSummary, chartProblem, CHART_TYPES, CHART_TYPES_TEXT, MAX_CHARTS };
