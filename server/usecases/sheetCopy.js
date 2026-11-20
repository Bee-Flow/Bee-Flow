// @typecheck strict
/**
 * Copying a spreadsheet document (POST /:id/duplicate, routes/studioDocuments/sheet.js
 * duplicateSheet): every tab into a new table of the copier's own, the cells
 * and charts carried over, and the tables given back when the copy cannot
 * finish. Composes the datatable cells (core/documents/sheetCells) and the
 * document store, both handed in by the route.
 */

'use strict';

const crypto = require('crypto');
const { sheetTabsOf, newTabId, settingsWithTabs } = require('../stores/lib/sheetDocument');
const { bestEffort } = require('../utils/bestEffort');

/**
 * What the routes that make or drop a tab's table pass to updateDocument: the
 * only saves that may add or remove a tab (stores/lib/sheetDocument.keepSheetOnUpdate).
 * Never built from a request.
 */
const TABS_BY_SERVER = Object.freeze({ tabsChangedByServer: true });

/**
 * Every tab of `doc` copied into a new table of `userId`'s own.
 * @param {typeof import('../core/documents/sheetCells')} cellsApi
 * @param {import('../stores/documentStore').DocumentView} doc
 * @param {string} userId
 * @param {string[]} made  collects every table made, also when a later tab fails, so the caller can give them back
 * @param {(tabName: string) => string} tableName  the name of a copied tab's table ("Budget — copy", in the copier's language)
 * @returns {Promise<{ newTabs: { id: string, name: string, datatableId: string }[], tabIds: Map<string, string> }>}  tabIds: old tab id → the copy's
 */
async function copyTabs(cellsApi, doc, userId, made, tableName) {
    /** @type {{ id: string; name: string; datatableId: string; }[]} */
    const newTabs = [];
    const tabIds = new Map();
    for (const t of sheetTabsOf(/** @type {Parameters<typeof sheetTabsOf>[0]} */ (/** @type {unknown} */ (doc)))) {
        const table = await cellsApi.createSheetTable({ ownerUserId: userId, name: tableName(t.name) });
        made.push(table.id);
        await cellsApi.copyCells(doc.userId, t.datatableId, table.id, userId);
        const id = newTabId();
        tabIds.set(t.id, id);
        newTabs.push({ id, name: t.name, datatableId: table.id });
    }
    return { newTabs, tabIds };
}

/**
 * A copy of `doc` owned by `userId`: every tab in a new table of theirs, the
 * cells and charts carried over. A copy that cannot finish (the tab cap
 * half-way, a read error, a refused save) gives back the tables no document
 * points at, so the failure does not count against the owner.
 * @param {typeof import('../core/documents/sheetCells')} cellsApi
 * @param {typeof import('../stores/documentStore')} documentsApi
 * @param {import('../stores/documentStore').DocumentView} doc
 * @param {{ userId: string, name: string, ctx: { userId: string }, tableName: (tabName: string) => string }} copy
 *   who copies, the copy's name, the actor for its save, and how a copied tab's table is named
 */
async function copySheet(cellsApi, documentsApi, doc, { userId, name, ctx, tableName }) {
    /** @type {string[]} */
    const made = [];
    try {
        const { newTabs, tabIds } = await copyTabs(cellsApi, doc, userId, made, tableName);
        const charts = copiedCharts(/** @type {{ charts?: unknown } | undefined} */ (doc.settings?.sheet)?.charts, tabIds);
        const copy = await documentsApi.createDocument({
            userId, name, docType: 'spreadsheet', kind: 'document', visibility: 'private', folderId: null,
            sheetTableId: newTabs[0].datatableId,
        });
        // The copy owns its first tab's table from here on.
        made.splice(made.indexOf(newTabs[0].datatableId), 1);
        let updated = null;
        if (newTabs.length > 1 || charts.length) {
            const settings = settingsWithTabs(copy.settings, newTabs);
            updated = await documentsApi.updateDocument(copy.id, ctx, {
                settings: { ...settings, sheet: { ...settings.sheet, ...(charts.length ? { charts } : {}) } },
                expectedVersionId: copy.versionId,
            }, TABS_BY_SERVER);
        }
        made.length = 0;
        // The copy as stored now: its tabs, its charts and the version after that save.
        return updated || copy;
    } catch (e) {
        for (const id of made) {
            await cellsApi.dropSheetTable(userId, id).catch((/** @type {unknown} */ err) => bestEffort('routes/studioDocuments/sheet:duplicateSheet', err));
        }
        throw e;
    }
}

/**
 * The charts of a sheet for its copy, which looks like the original: new
 * ids, pinned to the copied tabs (a chart pinned to no tab stays on every
 * tab); a chart pinned to a tab that no longer exists is left behind.
 * @param {unknown} charts
 * @param {Map<string, string>} tabIds
 */
function copiedCharts(charts, tabIds) {
    if (!Array.isArray(charts)) return [];
    return charts
        .filter((c) => c && typeof c === 'object' && (!c.tab || tabIds.has(c.tab)))
        .map((c) => ({ ...c, id: `chart-${crypto.randomBytes(5).toString('hex')}`, ...(c.tab ? { tab: tabIds.get(c.tab) } : {}) }));
}

module.exports = { TABS_BY_SERVER, copySheet };
