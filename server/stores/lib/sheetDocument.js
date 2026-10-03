// @typecheck
/**
 * What makes a 'spreadsheet' document different in the document store
 * (stores/documentStore.js): it keeps NOTHING in the body slots — its cells
 * live in a datatable named by `settings.sheet.datatableId`
 * (core/documents/sheetCells.js), which the server sets when it creates the
 * sheet and no save may change — and it is never a template or a section,
 * since nothing in it can be filled in by a routine.
 */

'use strict';

const SHEET_DOC_TYPE = 'spreadsheet';

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
    if (wasSheet) next.settings = { ...next.settings, sheet: current.settings?.sheet };
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
    return { ...rest, sheet: { datatableId: sheetTableId } };
}

module.exports = { SHEET_DOC_TYPE, applySheetRules, keepSheetOnUpdate, sheetSettingsForCreate };
