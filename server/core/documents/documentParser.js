// @typecheck
/**
 * Document Parser — Central module for extracting text from uploaded documents.
 * 
 * Supports: PDF (via Mistral OCR / pdf-parse), DOCX (mammoth), PPTX (pptxExtractor —
 * slide text + speaker notes, one section per slide), CSV/XLSX/ODS (xlsx).
 * All binary formats are converted to readable text/markdown for LLM consumption.
 */

const mammoth = require('mammoth');
const XLSX = require('@e965/xlsx');
const log = require('../../telemetry/log');
const { bestEffort } = require('../../utils/bestEffort');

/**
 * Parse a document buffer into plain text based on its MIME type.
 * 
 * @param {Buffer} buffer - Raw file content
 * @param {string} mimeType - File MIME type
 * @param {string} filename - Original filename (for logging / headers)
 * @param {{ returnHtml?: boolean }} [options] - Parsing options
 * @returns {Promise<string>} Extracted text content
 */
async function parseDocument(buffer, mimeType, filename, options = {}) {
    const type = (mimeType || '').toLowerCase();

    // ── DOCX ──
    if (
        type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
        filename?.toLowerCase().endsWith('.docx')
    ) {
        return parseDocx(buffer, filename, options);
    }

    // ── PPTX ──
    if (
        type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
        filename?.toLowerCase().endsWith('.pptx')
    ) {
        return parsePptx(buffer, filename);
    }

    // ── XLSX / XLS / ODS ──
    if (
        type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
        type === 'application/vnd.ms-excel' ||
        type === 'application/vnd.oasis.opendocument.spreadsheet' ||
        filename?.toLowerCase().endsWith('.xlsx') ||
        filename?.toLowerCase().endsWith('.xls') ||
        filename?.toLowerCase().endsWith('.ods')
    ) {
        return parseSpreadsheet(buffer, filename);
    }

    // ── CSV ──
    if (
        type === 'text/csv' ||
        type === 'application/csv' ||
        filename?.toLowerCase().endsWith('.csv')
    ) {
        return parseSpreadsheet(buffer, filename);
    }

    // ── PDF ── (fallback parser using pdf-parse; Mistral OCR handled upstream)
    if (type === 'application/pdf' || filename?.toLowerCase().endsWith('.pdf')) {
        return parsePdf(buffer, filename);
    }

    // ── Text-based (txt, md, json, code, etc.) ──
    return buffer.toString('utf-8');
}

// ── DOCX Parser ─────────────────────────────────────────────────
/**
 * @param {Buffer<ArrayBufferLike>} buffer
 * @param {string} filename
 */
async function parseDocx(buffer, filename, options = {}) {
    try {
        const result = options.returnHtml 
            ? await mammoth.convertToHtml({ buffer }) 
            : await mammoth.extractRawText({ buffer });
        const text = result.value || '';
        if (!text.trim()) {
            log.info(`[DocumentParser] DOCX file "${log.nameForLog(filename)}" is empty or contains only images`);
            return `[Document: ${filename} — no extractable text content]`;
        }
        log.info(`[DocumentParser] Extracted ${text.length} chars from DOCX: ${log.nameForLog(filename)}`);
        return text;
    } catch (err) {
        log.error(`[DocumentParser] Failed to parse DOCX "${log.nameForLog(filename)}":`, /** @type {Error} */ (err).message);
        return `[Document: ${filename} — failed to parse DOCX: ${/** @type {Error} */ (err).message}]`;
    }
}

// ── PPTX Parser ─────────────────────────────────────────────────
/**
 * @param {Buffer<ArrayBufferLike>} buffer
 * @param {string} filename
 */
async function parsePptx(buffer, filename) {
    try {
        const { extractPptxText } = require('./pptxExtractor');
        const { text, slideCount, notesCount } = await extractPptxText(buffer);
        if (!text.trim()) {
            log.info(`[DocumentParser] PPTX file "${log.nameForLog(filename)}" has no extractable text`);
            return `[Presentation: ${filename} — no extractable text content]`;
        }
        log.info(`[DocumentParser] Extracted ${text.length} chars from PPTX: ${log.nameForLog(filename)} (${slideCount} slides, ${notesCount} with notes)`);
        return text;
    } catch (err) {
        log.error(`[DocumentParser] Failed to parse PPTX "${log.nameForLog(filename)}":`, /** @type {Error} */ (err).message);
        return `[Presentation: ${filename} — failed to parse PPTX: ${/** @type {Error} */ (err).message}]`;
    }
}

// ── Spreadsheet Parser (XLSX / XLS / CSV) ───────────────────────
/**
 * SheetJS reads a CSV buffer as codepage 1252, so "é" arrives as "Ã©". Delimited
 * text that is valid UTF-8 is read as a string instead (BOM stripped); one
 * that is not valid UTF-8 keeps the old behaviour (legacy Windows exports).
 * @param {Buffer<ArrayBufferLike>} buffer
 */
function readWorkbook(buffer) {
    // XLSX/ODS are zip ("PK"), legacy XLS is a compound file (D0 CF 11 E0):
    // anything else is delimited text.
    // Also dBASE (.dbf: 0x03, 0x83, 0x8B), which SheetJS reads from a buffer.
    const binary = (buffer[0] === 0x50 && buffer[1] === 0x4b) || (buffer[0] === 0xd0 && buffer[1] === 0xcf)
        || buffer[0] === 0x03 || buffer[0] === 0x83 || buffer[0] === 0x8b;
    if (!binary) {
        try {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '');
            return XLSX.read(text, { type: 'string' });
        } catch (e) {
            bestEffort('core/documents/documentParser:readWorkbook', e); // [DocumentParser] CSV is not valid UTF-8, reading it as a legacy encoding:
        }
    }
    return XLSX.read(buffer, { type: 'buffer' });
}

/**
 * @param {Buffer<ArrayBufferLike>} buffer
 * @param {string} filename
 */
function parseSpreadsheet(buffer, filename) {
    try {
        const workbook = readWorkbook(buffer);
        const sheets = workbook.SheetNames;

        if (sheets.length === 0) {
            return `[Spreadsheet: ${filename} — no sheets found]`;
        }

        /** @type {string[]} */
        const parts = [];

        for (const sheetName of sheets) {
            const sheet = workbook.Sheets[sheetName];
            const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

            if (jsonData.length === 0) {
                parts.push(`### Sheet: ${sheetName}\n(empty)`);
                continue;
            }

            // Convert to Markdown table
            const headers = jsonData[0].map(h => String(h || '').trim() || '—');
            const divider = headers.map(() => '---');
            const rows = jsonData.slice(1);

            let table = `| ${headers.join(' | ')} |\n| ${divider.join(' | ')} |\n`;

            for (let i = 0; i < rows.length; i++) {
                const cells = rows[i].map(c => String(c ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' '));
                while (cells.length < headers.length) cells.push('');
                table += `| ${cells.join(' | ')} |\n`;
            }

            const LARGE_SHEET_WARN = 5000;
            if (rows.length > LARGE_SHEET_WARN) {
                log.warn(`[DocumentParser] Large sheet "${sheetName}" in "${log.nameForLog(filename)}": ${rows.length} rows — token usage will be high`);
            }

            if (sheets.length > 1) {
                parts.push(`### Sheet: ${sheetName}\n${table}`);
            } else {
                parts.push(table);
            }
        }

        const result = parts.join('\n\n');
        log.info(`[DocumentParser] Parsed spreadsheet "${log.nameForLog(filename)}": ${sheets.length} sheet(s), ${result.length} chars`);
        return result;
    } catch (err) {
        log.error(`[DocumentParser] Failed to parse spreadsheet "${log.nameForLog(filename)}":`, /** @type {Error} */ (err).message);
        return `[Spreadsheet: ${filename} — failed to parse: ${/** @type {Error} */ (err).message}]`;
    }
}

// ── PDF Fallback Parser (when Mistral OCR is unavailable) ───────
/**
 * @param {Buffer<ArrayBufferLike>} buffer
 * @param {string} filename
 */
async function parsePdf(buffer, filename) {
    try {
        const { PDFParse } = require('pdf-parse');
        // pdf-parse 2: the data goes to the constructor, getText() returns
        // { pages, text, total }, and destroy() releases the pdf.js document.
        // The page texts are joined here rather than taken from `text`, which
        // carries "-- 1 of 1 --" separators even for a page with no words.
        const parser = new PDFParse({ data: new Uint8Array(buffer), verbosity: 0 });
        /** @type {string} */
        let text;
        try {
            const { pages } = await parser.getText();
            text = pages.map((p) => p.text).filter((t) => t && t.trim()).join('\n\n');
        } finally {
            await parser.destroy();
        }
        if (!text || !text.trim()) {
            return `[PDF: ${filename} — no extractable text (may be image-based)]`;
        }
        log.info(`[DocumentParser] Extracted ${text.length} chars from PDF: ${log.nameForLog(filename)}`);
        return text;
    } catch (err) {
        log.error(`[DocumentParser] Failed to parse PDF "${log.nameForLog(filename)}":`, /** @type {Error} */ (err).message);
        return `[PDF: ${filename} — failed to parse: ${/** @type {Error} */ (err).message}]`;
    }
}

/**
 * Check if a MIME type / filename represents a document we can parse.
 * Useful for UI hints and validation.
 */
function isSupportedDocument(mimeType, filename) {
    const type = (mimeType || '').toLowerCase();
    const name = (filename || '').toLowerCase();

    return (
        type === 'application/pdf' ||
        type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
        type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
        type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
        type === 'application/vnd.ms-excel' ||
        type === 'application/vnd.oasis.opendocument.spreadsheet' ||
        type === 'text/csv' ||
        type === 'application/csv' ||
        type.startsWith('text/') ||
        name.endsWith('.pdf') ||
        name.endsWith('.docx') ||
        name.endsWith('.pptx') ||
        name.endsWith('.xlsx') ||
        name.endsWith('.xls') ||
        name.endsWith('.ods') ||
        name.endsWith('.csv')
    );
}

module.exports = {
    parseDocument,
    isSupportedDocument
};
