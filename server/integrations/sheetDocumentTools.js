// @typecheck
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

const SHEET_HOW = 'To change cells, call document_write({ documentId, cells: { "A1": "Rent", "B1": "1200", "B3": "=SUM(B1:B2)" } }) — '
    + 'columns A–Z, rows from 1; a value or a formula starting with "="; "" clears a cell. '
    + 'Formulas: + - * / ^ & (text), comparisons, ranges like A1:B9, and SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, IF, AND, OR, NOT, ROUND, ABS, CONCAT, LEN, UPPER, LOWER, TRIM.';

/**
 * @param {any} doc  the spreadsheet, as getDocument returned it to the caller
 * @param {{ cells?: any, evaluate?: Function }} [deps]
 */
async function readSheetDocument(doc, deps = {}) {
    const sheetCells = deps.cells || require('../core/documents/sheetCells');
    const evaluate = deps.evaluate || require('../shared/expr/sheet.mjs').evaluateSheet;
    const { cells, rows } = await sheetCells.readSheet(doc.userId, doc.settings?.sheet?.datatableId);
    const shown = evaluate(cells);
    /** @type {Record<string, string>} */
    const computed = {};
    for (const [name, raw] of Object.entries(cells)) {
        if (String(raw).startsWith('=')) computed[name] = shown[name]?.display ?? '';
    }
    const readOnly = doc.projectRole === 'viewer';
    return {
        documentId: doc.id, name: doc.name, docType: 'spreadsheet', rows,
        cells, computed,
        ...(readOnly ? { readOnly: true } : {}),
        message: `Read the spreadsheet "${doc.name}": \`cells\` is what was typed in each cell, \`computed\` what each formula shows. `
            + (readOnly ? 'You may read it but not change it (the user is a viewer of its project).' : SHEET_HOW),
    };
}

/**
 * @param {any} doc
 * @param {any} args  the document_write arguments
 * @param {{ cells?: any }} [deps]
 */
async function writeSheetDocument(doc, args, deps = {}) {
    const sheetCells = deps.cells || require('../core/documents/sheetCells');
    if (!args || !args.cells || typeof args.cells !== 'object' || Array.isArray(args.cells)) {
        return { error: `This document is a spreadsheet: it has no bodyHtml or css. ${SHEET_HOW}` };
    }
    /** @type {Record<string, string>} */
    const cells = {};
    for (const [name, value] of Object.entries(args.cells)) cells[name] = value === null || value === undefined ? '' : String(value);
    try {
        const saved = await sheetCells.writeCells(doc.userId, doc.settings?.sheet?.datatableId, cells);
        return { documentId: doc.id, saved: Object.keys(saved.cells).length, message: `Saved ${Object.keys(saved.cells).length} cell(s) in "${doc.name}".` };
    } catch (e) {
        if (e && Number(e.status) >= 400 && Number(e.status) < 500) return { error: e.message };
        throw e;
    }
}

const SHEET_EDIT_REFUSAL = { error: `document_edit changes text in a page or a designed document; this one is a spreadsheet. ${SHEET_HOW}` };

module.exports = { readSheetDocument, writeSheetDocument, SHEET_EDIT_REFUSAL };
