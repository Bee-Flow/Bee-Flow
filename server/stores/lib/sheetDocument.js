// @typecheck
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

/** Build the sheet settings for a brand-new spreadsheet with one tab. */
function singleTabSettings(datatableId, name = 'Sheet1') {
    return { tabs: [{ id: newTabId(), name, datatableId }] };
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
 * Create-time rules for a spreadsheet; the caller has established the type.
 * @param {any} input  the document being validated, mutated in place
 * @param {(message: string) => Error} failure
 */
function applySheetRules(input, failure) {
    if ((input.kind || 'document') !== 'document') throw failure('A spreadsheet is a document, not a template or a section');
    input.bodyHtml = '';
    input.css = '';
}

/**
 * Update-time rules: a spreadsheet stays one, and keeps the table it was made
 * with — which table holds the cells is the server's, never a save's
 * (pointing it elsewhere would open somebody else's table through this
 * document).
 *
 * @param {any} current
 * @param {any} next      the document after the update, mutated in place
 * @param {string} nextType  normaliseType(next.docType)
 * @param {(message: string, status: number, errorClass: string) => Error} failure
 */
function keepSheetOnUpdate(current, next, nextType, failure) {
    const wasSheet = current.docType === SHEET_DOC_TYPE;
    if (wasSheet !== (nextType === SHEET_DOC_TYPE)) {
        throw failure('A spreadsheet stays a spreadsheet, and another document cannot become one. Make a new spreadsheet instead.', 422, 'document_type_fixed');
    }
    if (wasSheet) {
        const currentSheet = current.settings?.sheet || {};
        const nextSheet = next.settings?.sheet || {};
        // The table reference is immutable; tabs and metadata like charts may change.
        next.settings = { ...next.settings, sheet: { ...currentSheet, ...nextSheet, datatableId: currentSheet.datatableId } };
    }
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
 */
function sheetSettingsForCreate(settings, docType, sheetTableId, failure) {
    const { sheet: _ignored, ...rest } = settings || {};
    if (docType !== SHEET_DOC_TYPE) return rest;
    if (typeof sheetTableId !== 'string' || !sheetTableId) {
        throw failure('A spreadsheet is started from Documents → New document → Spreadsheet.', 422, 'sheet_needs_table');
    }
    return { ...rest, sheet: singleTabSettings(sheetTableId) };
}

module.exports = {
    SHEET_DOC_TYPE, applySheetRules, keepSheetOnUpdate, sheetSettingsForCreate,
    newTabId, singleTabSettings, sheetTabsOf,
};
