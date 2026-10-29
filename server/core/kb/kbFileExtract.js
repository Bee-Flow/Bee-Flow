const path = require('node:path');
const configStore = require('../../stores/configStore');
const log = require('../../telemetry/log');

const XLSX_MIMES = new Set([
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
]);

/**
 * @param {string} mime
 * @param {string} filename
 */
function isSpreadsheetFile(mime, filename) {
    return XLSX_MIMES.has(mime) || /\.(xlsx|xls)$/i.test(filename || '');
}

/**
 * Sheet names of a workbook, cheaply (`bookSheets` reads the directory only,
 * not the cells). Best-effort: null when the buffer is not a workbook.
 * @param {Buffer<ArrayBufferLike>} buffer
 */
function readSheetNames(buffer) {
    try {
        const XLSX = require('@e965/xlsx');
        const wb = XLSX.read(buffer, { type: 'buffer', bookSheets: true });
        return Array.isArray(wb?.SheetNames) ? wb.SheetNames.slice() : null;
    } catch (_) {
        return null;
    }
}

/**
 * Extract text from a file buffer, plus what we learn about the file on the way.
 *
 * Supports: PDF (pdfjs-dist + Mistral OCR fallback), DOCX, XLSX, CSV, TXT, MD.
 * When Azure Document Intelligence is enabled globally, all file types go through Azure.
 *
 * @param {Buffer}  buffer   — file bytes
 * @param {string}  mime     — MIME type
 * @param {string}  filename — original file name
 * @returns {Promise<{ text: string, meta: { pageCount: number|null, sheetNames: string[]|null, pages?: Array<{pageNumber:number, text:string}> } }>}
 *   `text` is byte-for-byte what extractFileContent() returns; `meta`
 *   feeds documents.page_count / sheet_count and (later) per-chunk page numbers.
 */
async function extractFileContentWithMeta(buffer, mime, filename) {
    const useAzure = !!(await configStore.getConfig('use_azure_doc_processing'));
    const meta = { pageCount: null, sheetNames: null };

    log.info(`[KBHelpers] ─── File: ${log.nameForLog(filename)} (${(buffer.length / 1024).toFixed(1)} KB, ${mime}) ───`);
    log.info(`[KBHelpers] Mode: ${useAzure ? '☁️  AZURE' : '🖥️  LOCAL'}`);

    // ── Azure Document Intelligence path (all file types) ──
    if (useAzure) {
        const azure = require('../documents/azureDocIntelligence');
        if (!(await azure.isAzureDocIntelligenceConfigured())) {
            throw new Error('Azure Document Intelligence is not configured. Set endpoint and key in admin settings.');
        }
        log.info(`[KBHelpers] Extraction: Azure Document Intelligence (Layout → Markdown)`);
        if (isSpreadsheetFile(mime, filename)) meta.sheetNames = readSheetNames(buffer);
        // extractWithAzureWithStats is the { text, pageCount } variant; until
        // it lands the page count is simply unknown (null), never wrong.
        if (typeof azure.extractWithAzureWithStats === 'function') {
            const r = await azure.extractWithAzureWithStats(buffer, filename);
            return {
                text: r?.text || '',
                meta: {
                    ...meta,
                    pageCount: Number.isFinite(r?.pageCount) ? r.pageCount : null,
                    // Azure splits on its own PageBreak markers now, so the KB
                    // ingest can stamp a page on each chunk. Absent when the
                    // document had no breaks at all — one page, or none.
                    ...(Array.isArray(r?.pages) && r.pages.length > 0 ? { pages: r.pages } : {}),
                },
            };
        }
        return { text: await azure.extractWithAzure(buffer, filename), meta };
    }

    // ── Local extraction path ──
    if (mime === 'text/plain' || mime === 'text/markdown') {
        log.info(`[KBHelpers] Extraction: Direct text read (${mime})`);
        return { text: buffer.toString('utf-8'), meta };
    }

    if (mime === 'application/pdf') {
        let content = '';
        /** @type {{ pageNumber: number; text: string; }[]} */
        let pages;

        // Primary: pdfjs-dist for text-based PDFs. The stats variant yields the
        // identical joined text plus per-page text and the page count.
        try {
            const { extractTextFromPDFWithStats } = require('../documents/pdfExtractor');
            const r = await extractTextFromPDFWithStats(buffer, filename);
            content = r?.text || '';
            if (Number.isFinite(r?.numPages) && r.numPages > 0) meta.pageCount = r.numPages;
            if (Array.isArray(r?.pages) && r.pages.length > 0) pages = r.pages;
            if (content && content.trim().length >= 20) {
                log.info(`[KBHelpers] Extraction: pdfjs-dist (text-based PDF, ${meta.pageCount ?? '?'} pages)`);
            }
        } catch (e) {
            log.warn('[KBHelpers] pdfExtractor failed:', /** @type {Error} */ (e).message);
        }

        if (!content || content.trim().length < 10) {
            throw new Error('Could not extract text from PDF. Enable Azure Document Intelligence for scanned documents, or ensure the PDF has a text layer.');
        }
        return { text: content, meta: pages ? { ...meta, pages } : meta };
    }

    // DOCX, PPTX, CSV, XLSX, etc.
    if (
        mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
        mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
        mime === 'text/csv' ||
        mime === 'application/csv' ||
        XLSX_MIMES.has(mime) ||
        filename?.match(/\.(docx|pptx|csv|xlsx|xls)$/i)
    ) {
        const { parseDocument } = require('../documents/documentParser');
        const ext = path.extname(filename).slice(1).toLowerCase();
        log.info(`[KBHelpers] Extraction: documentParser (${ext})`);
        if (isSpreadsheetFile(mime, filename)) meta.sheetNames = readSheetNames(buffer);
        return { text: await parseDocument(buffer, mime, filename), meta };
    }

    // Generic fallback via documentParser
    try {
        const { parseDocument, isSupportedDocument } = require('../documents/documentParser');
        if (isSupportedDocument && isSupportedDocument(mime, filename)) {
            log.info(`[KBHelpers] Extraction: documentParser (generic)`);
            return { text: await parseDocument(buffer, mime, filename), meta };
        }
    } catch (e) {
        log.warn('[KBHelpers] documentParser fallback failed:', /** @type {Error} */ (e).message);
    }

    throw new Error(`Unsupported file type: ${mime}`);
}

/**
 * Text-only wrapper around extractFileContentWithMeta — the signature every
 * existing call site (ingest.js, notebook/webpage sourceIngestion) uses.
 * @returns {Promise<string>} extracted text/markdown content
 * @param {Buffer<ArrayBufferLike>} buffer
 * @param {string} mime
 * @param {string} filename
 */
async function extractFileContent(buffer, mime, filename) {
    const { text } = await extractFileContentWithMeta(buffer, mime, filename);
    return text;
}

module.exports = { extractFileContentWithMeta, extractFileContent };
