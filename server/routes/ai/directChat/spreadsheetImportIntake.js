// @typecheck noImplicitAny
/**
 * Direct Chat — a spreadsheet the user attaches becomes a Bee Flow
 * spreadsheet document that opens in the side panel (core/documents/
 * sheetImport.js), when the person has spreadsheets at all. The attachment's
 * text extraction in attachmentIntake.js stays as it was: the model still
 * sees the content this turn; the document is what it edits afterwards.
 *
 * Never fails the turn: any problem is logged and the caller carries on with
 * the old, text-only behaviour.
 */

'use strict';

const log = require('../../../telemetry/log');

const NOTHING = Object.freeze({ base: Object.freeze({}), note: '' });

/**
 * What the model is told about the import, one line plus the caveats.
 * @param {Awaited<ReturnType<typeof import('../../../core/documents/sheetImport').importWorkbook>>} result
 */
function importNote(result) {
    const lines = [`[Spreadsheet "${result.name}" imported as document ${result.documentId} and opened in the side panel: `
        + 'see what it holds with document_read({ documentId, mode: "outline" }) (columns and types, no rows), read rows with document_read({ documentId, tab, range }), '
        + 'change cells or add charts with document_write({ documentId, tab, cells, charts }). '
        + `Tabs: ${result.tabs.map((t) => t.name).join(', ')}.]`];
    for (const t of result.truncated) {
        /** @type {string[]} */
        const parts = [];
        if (t.droppedRows) parts.push(`${t.droppedRows} row(s) past row 2000`);
        if (t.droppedCols) parts.push(`${t.droppedCols} column(s) past column Z`);
        lines.push(`[Tab "${t.tab}" was cut: ${parts.join(' and ')} did not fit in the sheet.]`);
    }
    if (result.skippedSheets.length) lines.push(`[Not imported (too many sheets or cells): ${result.skippedSheets.join(', ')}.]`);
    if (result.unsupportedFunctions.length) {
        lines.push(`[Formulas using ${result.unsupportedFunctions.join(', ')} were kept as typed but the sheet cannot compute them.]`);
    }
    return lines.join('\n');
}

/**
 * An attachment that is a spreadsheet file (by type or by name).
 * @param {{ type?: string, name?: string }} att
 */
function isSpreadsheetUpload(att) {
    const type = att.type || '';
    const name = String(att.name || '').toLowerCase();
    return type.includes('spreadsheetml') || type.includes('ms-excel') || type.includes('opendocument.spreadsheet')
        || type === 'text/csv' || type === 'application/csv' || /\.(xlsx|xls|ods|csv)$/.test(name);
}

/**
 * @param {object} p
 * @param {any} p.req
 * @param {(event: string, data: any) => void} p.send
 * @param {string} p.userId
 * @param {Buffer} p.buffer
 * @param {{ name: string, type?: string }} p.att
 * @param {{ markCreated(id: unknown): void } | undefined} p.documentScope
 * @param {{ sheetsAllowedFor?: Function, importWorkbook?: Function }} [p.deps]
 * @returns {Promise<{ base: { documentId?: string }, note: string }>}  empty when nothing was imported
 */
async function importUploadedSpreadsheet({ req, send, userId, buffer, att, documentScope, deps = {} }) {
    try {
        const allowed = deps.sheetsAllowedFor || require('../../studioDocuments/sheetGate').sheetsAllowedFor;
        if (!(await allowed(req))) return NOTHING;
        const importWorkbook = deps.importWorkbook || require('../../../core/documents/sheetImport').importWorkbook;
        const result = await importWorkbook({ userId, buffer, fileName: att.name, mimeType: att.type });
        documentScope?.markCreated(result.documentId);
        // filename: the upload's own name, so the client can put the Open button on its chip right away
        send('document_open', { documentId: result.documentId, name: result.name, docType: 'spreadsheet', filename: att.name });
        log.info(`[DirectChat] Imported spreadsheet ${att.name} as document ${result.documentId} (${result.tabs.length} tab(s))`);
        return { base: { documentId: result.documentId }, note: `\n${importNote(result)}` };
    } catch (e) {
        log.warn(`[DirectChat] Spreadsheet import failed for ${att.name}, using the text only: ${/** @type {Error} */ (e).message}`);
        return NOTHING;
    }
}

module.exports = { importUploadedSpreadsheet, importNote, isSpreadsheetUpload };
