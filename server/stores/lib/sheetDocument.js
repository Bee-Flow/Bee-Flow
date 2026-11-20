// @typecheck strict
/**
 * What makes a 'spreadsheet' document different in the document store
 * (stores/documentStore.js): it keeps NOTHING in the body slots — its cells
 * live in a datatable named by `settings.sheet.datatableId`
 * (core/documents/sheetCells.js), which the server sets when it creates the
 * sheet and no save may change — and it is never a template or a section,
 * since nothing in it can be filled in by an automation.
 */

'use strict';

const crypto = require('crypto');

const SHEET_DOC_TYPE = 'spreadsheet';

function newTabId() { return crypto.randomBytes(4).toString('hex'); }

/**
 * Build the sheet settings for a brand-new spreadsheet with one tab.
 * @param {string} datatableId
 */
function singleTabSettings(datatableId, name = 'Sheet1') {
    return { tabs: [{ id: newTabId(), name, datatableId }] };
}

/**
 * How a sheet reads typed numbers (shared/expr/sheetValues.mjs): 'nl' reads
 * 1,5 and 1.234,56, 'en' reads 1,234.56. Set once when the sheet is made, from
 * its creator's language, so every reader computes the same values; a sheet
 * from before the setting existed is 'en'.
 * @param {unknown} locale
 * @returns {'nl'|'en'}
 */
function normaliseSheetLocale(locale) {
    return typeof locale === 'string' && locale.trim().toLowerCase().startsWith('nl') ? 'nl' : 'en';
}

/**
 * The locale a spreadsheet's formulas read typed numbers with.
 * @param {{ settings?: any } | null | undefined} doc
 * @returns {'nl'|'en'}
 */
function sheetLocaleOf(doc) {
    return normaliseSheetLocale(doc?.settings?.sheet?.locale);
}

/**
 * Backward-compatible read of a spreadsheet's tabs. Old documents stored a
 * single `{ datatableId }`; they are treated as one unnamed tab named Sheet1.
 * @param {{ settings?: { sheet?: { tabs?: any[], datatableId?: string } } }} doc
 * @returns {{ id: string, name: string, datatableId: string }[]}
 */
function sheetTabsOf(doc) {
    const sheet = doc?.settings?.sheet;
    if (Array.isArray(sheet?.tabs)) return sheet.tabs;
    if (typeof sheet?.datatableId === 'string' && sheet.datatableId) {
        return [{ id: 'default', name: 'Sheet1', datatableId: sheet.datatableId }];
    }
    return [];
}

/**
 * The settings with a new tab list, everything else on the sheet kept (its
 * charts above all: a writer that rebuilt `sheet` as `{ tabs }` relied on the
 * store's merge to keep them). A chart pinned to a tab that is not in the
 * list goes (a removed tab takes its charts along, and an orphan left by an
 * older delete is cleaned up); a chart without a tab shows on every tab and
 * stays.
 * @param {any} settings
 * @param {any[]} tabs
 */
function settingsWithTabs(settings, tabs) {
    const sheet = settings?.sheet || {};
    const ids = new Set(tabs.map((t) => t?.id));
    const charts = Array.isArray(sheet.charts)
        ? { charts: sheet.charts.filter((/** @type {any} */ c) => !c?.tab || ids.has(c.tab)) }
        : {};
    return { ...settings, sheet: { ...sheet, tabs, ...charts } };
}



/**
 * Create-time rules for a spreadsheet; the caller has established the type.
 * @param {import('../documentStore').DocumentInput} input  the document being validated, mutated in place
 * @param {(message: string) => Error} failure
 */
function applySheetRules(input, failure) {
    if ((input.kind || 'document') !== 'document') throw failure('A spreadsheet is a document, not a template or a section');
    input.bodyHtml = '';
    input.css = '';
}

/**
 * Update-time rules: a spreadsheet stays one, and keeps the tables it was made
 * with — which table holds a tab's cells is the server's, never a save's
 * (pointing a tab elsewhere would open somebody else's table through this
 * document, and deleting that tab would then drop it as the owner).
 *
 * So a save may rename and reorder the tabs it has, nothing more: every tab
 * sent must be an existing tab (by id) and keeps that tab's table, whatever
 * `datatableId` it carried; an unknown or a missing tab is refused. Tabs are
 * added and removed only by server code that made or dropped the tables itself
 * (the tab routes, a copy, an import, the assistant's tab tool), which says so
 * with `tabsChangedByServer` — an argument, never something a request body can
 * carry. Even then an existing tab keeps its own table.
 *
 * @param {{ docType?: unknown, settings?: { sheet?: Record<string, unknown> } | null }} current
 * @param {{ settings?: { sheet?: Record<string, unknown> } | null }} next      the document after the update, mutated in place
 * @param {string} nextType  normaliseType(next.docType)
 * @param {(message: string, status: number, errorClass: string) => Error} failure
 * @param {{ tabsChangedByServer?: boolean }} [options]
 */
function keepSheetOnUpdate(current, next, nextType, failure, options = {}) {
    const wasSheet = current.docType === SHEET_DOC_TYPE;
    if (wasSheet !== (nextType === SHEET_DOC_TYPE)) {
        throw failure('A spreadsheet stays a spreadsheet, and another document cannot become one. Make a new spreadsheet instead.', 422, 'document_type_fixed');
    }
    if (!wasSheet) return;
    const currentSheet = current.settings?.sheet || {};
    const nextSheet = next.settings?.sheet || {};
    const sent = Object.hasOwn(nextSheet, 'tabs') ? nextSheet.tabs : undefined;
    const tabs = sent === undefined ? currentSheet.tabs : pinnedTabs(current, sent, options.tabsChangedByServer === true, failure);
    // The legacy single-table reference is immutable too.
    next.settings = { ...next.settings, sheet: { ...currentSheet, ...nextSheet, datatableId: currentSheet.datatableId, ...(tabs === undefined ? {} : { tabs }) } };
}

/**
 * The tabs a save sent, each existing one on its own table again.
 * @param {{ settings?: { sheet?: Record<string, unknown> } | null }} current
 * @param {unknown} sent
 * @param {boolean} mayAddOrRemove
 * @param {(message: string, status: number, errorClass: string) => Error} failure
 */
function pinnedTabs(current, sent, mayAddOrRemove, failure) {
    const fixed = () => failure('Tabs are added and removed with the tab buttons of the spreadsheet; a save can only rename or reorder them.', 422, 'sheet_tabs_fixed');
    if (!Array.isArray(sent)) throw fixed();
    const existing = new Map(sheetTabsOf(/** @type {Parameters<typeof sheetTabsOf>[0]} */ (/** @type {unknown} */ (current))).map((t) => [t.id, t]));
    const seen = new Set();
    const tabs = sent.map((/** @type {unknown} */ tab) => {
        // Whatever was sent: a tab without a string id (not an object at all, too) is refused below.
        const sentTab = /** @type {Record<string, unknown>} */ (tab && typeof tab === 'object' ? tab : {});
        const id = sentTab.id;
        if (typeof id !== 'string' || seen.has(id)) throw fixed();
        seen.add(id);
        const known = existing.get(id);
        if (known) return { ...sentTab, datatableId: known.datatableId };
        if (!mayAddOrRemove) throw fixed();
        return sentTab;
    });
    if (!mayAddOrRemove && [...existing.keys()].some((id) => !seen.has(id))) throw fixed();
    return tabs;
}

/**
 * The settings a new document is created with, as far as sheets go. A
 * spreadsheet's table comes ONLY from `sheetTableId`, an argument the sheet
 * route passes after making the table (core/documents/sheetCells.js) — never
 * from `settings`, which other callers fill from what a person or a model sent.
 * So a `create_document` with docType 'spreadsheet' from anywhere else is
 * refused instead of becoming a sheet with no cells, or one that points at
 * somebody else's table; and no other type carries a `sheet` key.
 *
 * @param {Record<string, any>} settings
 * @param {string} docType  normalised
 * @param {unknown} sheetTableId
 * @param {(message: string, status: number, errorClass: string) => Error} failure
 * @param {{ tabName?: unknown, locale?: unknown }} [made]  the first tab's name, in the creator's language (the
 *   sheet route; Sheet1 otherwise), and the creator's language for reading typed numbers (left out: 'en')
 */
function sheetSettingsForCreate(settings, docType, sheetTableId, failure, made = {}) {
    const { sheet: _ignored, ...rest } = settings || {};
    if (docType !== SHEET_DOC_TYPE) return rest;
    if (typeof sheetTableId !== 'string' || !sheetTableId) {
        throw failure('A spreadsheet is started from Documents → New document → Spreadsheet.', 422, 'sheet_needs_table');
    }
    const { tabName, locale } = made;
    const name = typeof tabName === 'string' && tabName.trim() ? tabName.trim().slice(0, 100) : undefined;
    const reads = typeof locale === 'string' && locale ? { locale: normaliseSheetLocale(locale) } : {};
    return { ...rest, sheet: { ...singleTabSettings(sheetTableId, name), ...reads } };
}

module.exports = {
    SHEET_DOC_TYPE, applySheetRules, keepSheetOnUpdate, sheetSettingsForCreate,
    newTabId, singleTabSettings, sheetTabsOf, settingsWithTabs, sheetLocaleOf, normaliseSheetLocale,
};
