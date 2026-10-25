// @typecheck strict
/**
 * document_download: the chat hands the user a download button for a
 * SPREADSHEET document. The file is built here from the stored cells, so the
 * model never retypes the data (which also keeps personal data out of it), and
 * kept under the caller's own storage prefix like the create_* Office tools
 * (integrations/officeFileDelivery.js). The result's `file` makes the chat
 * show a download card (routes/ai/directChat/toolResultEvents.js).
 *
 * The scope check ("did the person point the AI at this document") and the
 * lookup are done by documentBuilderTools.executeDocumentTool; a read-only
 * viewer may download, as they may read.
 */

'use strict';

const crypto = require('crypto');
const { sheetTabsOf } = require('../stores/lib/sheetDocument');

const DOCUMENT_DOWNLOAD_TOOL = {
    type: 'function',
    function: {
        name: 'document_download',
        description: 'Give the user a DOWNLOAD LINK (and a download button in the chat) for a SPREADSHEET document: the whole workbook as .xlsx (every tab, formulas kept) or one tab as .csv. The file is built from the stored cells, so never retype the data and never rebuild the sheet with create_spreadsheet. For spreadsheets only. Reply with the link from the result.',
        parameters: {
            type: 'object',
            properties: {
                documentId: { type: 'string', description: 'The spreadsheet document to download.' },
                format: { type: 'string', enum: ['xlsx', 'csv'], description: 'xlsx (default): all tabs. csv: one tab, the computed values.' },
                tab: { type: 'string', description: 'csv only: the tab, by id or name (any case). Default: the first tab.' },
            },
            required: ['documentId'],
        },
    },
};

const CSV_MIME = 'text/csv; charset=utf-8';

/**
 * The tab a csv download asks for (id or name, any case), the first by default.
 * @param {{ id: string; name: string; datatableId: string; }[]} tabs
 * @param {string | undefined} wanted
 */
function csvTab(tabs, wanted) {
    const key = typeof wanted === 'string' ? wanted.trim() : '';
    if (!key) return tabs[0];
    return tabs.find((t) => t.id === key) || tabs.find((t) => String(t.name).toLowerCase() === key.toLowerCase()) || null;
}

/**
 * @param {any} doc   the document, already looked up and scope-checked
 * @param {{ format?: string, tab?: string }} args
 * @param {{ userId: string }} ctx
 * @param {{ cells?: any, storage?: any, evaluate?: (cells: Record<string, string>) => Record<string, { display: string }> }} [deps]
 */
async function downloadSheetDocument(doc, args, ctx, deps = {}) {
    if (doc.docType !== 'spreadsheet') {
        return { error: 'document_download is for spreadsheets. A designed document (page, invoice, deck) is downloaded from its own editor.' };
    }
    const format = args.format === 'csv' ? 'csv' : 'xlsx';
    const tabs = sheetTabsOf(doc);
    if (!tabs.length) return { error: 'This spreadsheet has no table for its cells.' };
    const exporter = require('../core/documents/sheetExport');
    const sheetCells = deps.cells || require('../core/documents/sheetCells');

    /** @type {{ buffer: Buffer; contentType: string; filename: string; } | { buffer: Buffer<ArrayBuffer>; contentType: string; filename: string; }} */
    let file;
    if (format === 'csv') {
        const tab = csvTab(tabs, args.tab);
        if (!tab) return { error: `This spreadsheet has no tab "${args.tab}". Its tabs: ${tabs.map((t) => t.name).join(', ')}.` };
        const { cells } = await sheetCells.readSheet(doc.userId, tab.datatableId);
        const evaluate = deps.evaluate || require('../shared/expr/sheet.mjs').evaluateSheet;
        file = {
            buffer: Buffer.from('﻿' + exporter.sheetCsv(cells, evaluate), 'utf8'),
            contentType: CSV_MIME,
            filename: exporter.xlsxFileName(doc.name).replace(/\.xlsx$/, '.csv'),
        };
    } else {
        file = await exporter.buildSheetWorkbook(doc, { cells: sheetCells });
    }

    const storage = deps.storage || require('../stores/storageStore');
    if (typeof storage.isAvailable === 'function' && !storage.isAvailable()) {
        return { error: 'File storage is not available on this server, so the download cannot be prepared. Ask an administrator to configure storage.' };
    }
    const stamp = `${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const key = storage.buildKey(ctx.userId, 'documents', `${stamp}_${file.filename}`);
    await storage.uploadFile(key, file.buffer, file.contentType);
    const downloadUrl = storage.buildProxyUrl(key);
    return {
        success: true,
        downloadUrl,
        filename: file.filename,
        size: file.buffer.length,
        file: {
            kind: 'spreadsheet', name: file.filename, mimeType: file.contentType, size: file.buffer.length,
            url: downloadUrl, documentId: doc.id, source: 'document_download',
        },
        message: `Reply with the download link [${file.filename}](${downloadUrl}).`,
    };
}

module.exports = { DOCUMENT_DOWNLOAD_TOOL, downloadSheetDocument };
