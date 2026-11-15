// @typecheck strict
/**
 * nextcloud_read_file — one file's content for the model: rich documents (PDF,
 * DOCX, PPTX, XLSX/CSV) through the shared extraction pipeline, images through
 * the same OCR providers as a scanned PDF (text only: no picture is handed to
 * a model here), text as UTF-8 cut on a character boundary, binary refused.
 * `formFields: true` adds the filled-in AcroForm fields of a PDF. The download
 * is bounded by the tool file cap.
 */

'use strict';

const { MAX_TEXT_BYTES, joinDavPath } = require('./webdav');
const { toolFileMaxBytes, readBytesBounded, fileTooLargeMessage } = require('../../core/http/httpResponseLimits');
const log = require('../../telemetry/log');

/**
 * @typedef {import('./fileOperations').FileOpArgs} FileOpArgs
 * @typedef {import('./webdav').FilesToolCtx} FilesToolCtx
 * @typedef {{ kind: string, text: string, source?: string | null, meta?: { numPages?: number, [k: string]: unknown },
 *   reason?: string }} ExtractedDoc  what this tool reads of an extractAttachment result
 */

/**
 * @param {FileOpArgs} args
 * @param {FilesToolCtx} ctx
 */
async function readNextcloudFile(args, ctx) {
    const { ncFetch, authError, root } = ctx;
    if (!args.path) return { error: 'path is required' };
    const url = joinDavPath(root, args.path);
    const res = await ncFetch(url, {});
    if (res.status === 404) return { error: `File not found: ${args.path}` };
    if (res.status === 401) return { error: authError };
    if (!res.ok) return { error: `Nextcloud read failed (${res.status})` };
    const contentType = res.headers.get('content-type') || '';
    const cap = toolFileMaxBytes();
    const { buffer: buf, truncated: tooBig, declaredBytes } = await readBytesBounded(res, { byteCap: cap });
    if (tooBig || !buf) return { error: fileTooLargeMessage(args.path, declaredBytes, cap) };
    if (isFolderAnswer(args.path, contentType, buf)) {
        return { error: `path "${args.path}" is a folder, not a file. Use nextcloud_list_files to see what is in it.` };
    }
    const filename = args.path.split('/').pop() || args.path;
    const { result, pdf } = await contentResult(args.path, filename, contentType, buf);
    return args.formFields === true ? withFormFields(result, { pdf, path: args.path, contentType, buf }) : result;
}

/**
 * The file's content by kind, and whether it is a PDF (for the form fields).
 * @param {string} path
 * @param {string} filename
 * @param {string} contentType
 * @param {Buffer} buf
 */
async function contentResult(path, filename, contentType, buf) {
    const att = { name: filename, type: contentType };
    // Rich-document extraction — PDF, DOCX, PPTX, XLSX/CSV go through
    // the same pipeline used for chat uploads (pdfjs → Azure DI →
    // Mistral OCR for PDFs; Azure DI → mammoth/pptxExtractor/xlsx for
    // Office docs). An image goes to the OCR providers of a scanned PDF
    // (extractImage without a vision flag answers text or a failure, never
    // the picture). SVG is markup and stays on the text path.
    const { isPdf, isDocx, isSpreadsheet, isPptx, isImage } = require('../../core/documents/attachmentExtractor');
    const pdf = isPdf(att);
    const image = !pdf && isImage(att) && !isSvg(contentType, filename);
    const result = (pdf || isDocx(att) || isSpreadsheet(att) || isPptx(att) || image)
        ? await extractedFileResult(path, filename, contentType, buf, { image })
        : plainTextFileResult(path, contentType, buf);
    return { result, pdf };
}

/**
 * @param {string} contentType
 * @param {string} filename
 */
function isSvg(contentType, filename) {
    return contentType.toLowerCase().startsWith('image/svg') || filename.toLowerCase().endsWith('.svg');
}

/**
 * The read result with the PDF's filled-in form fields beside it
 * (`formFields: []` for a file that is not a PDF or has no form). A PDF whose
 * text could not be extracted but whose form could still answers, with the
 * extraction failure as a `note`: the fields are what the caller asked for.
 * @param {Record<string, unknown>} result  what the read gave without form fields
 * @param {{ pdf: boolean, path: string, contentType: string, buf: Buffer }} file
 */
async function withFormFields(result, { pdf, path, contentType, buf }) {
    if (!pdf) return { ...result, formFields: [] };
    /** @type {import('../../core/documents/pdfFormFields.mts').FormField[]} */
    let formFields;
    try {
        const { readPdfFormFields } = require('../../core/documents/pdfFormFields.mts');
        formFields = await readPdfFormFields(buf);
    } catch (err) {
        log.warn(`[nextcloud_read_file] form fields unreadable: ${/** @type {Error} */ (err).message}`);
        return { ...result, formFields: [], formFieldsError: 'The form fields of this PDF could not be read.' };
    }
    if (typeof result.error === 'string' && formFields.length) {
        return { path, size: buf.length, contentType, truncated: false, content: '', formFields, note: result.error };
    }
    return { ...result, formFields };
}

/**
 * Whether the path names a folder: a trailing slash, or the answer a GET on a
 * collection gives — 200 with Sabre's HTML banner, which would otherwise come
 * back as the "content" of the file.
 * @param {string} path
 * @param {string} contentType
 * @param {Buffer} buf
 */
function isFolderAnswer(path, contentType, buf) {
    const isWebdavBanner = /html/i.test(contentType)
        && /This is the WebDAV interface/i.test(buf.slice(0, 2048).toString('utf-8'));
    return /\/$/.test(path) || isWebdavBanner; // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- a one-character end anchor
}

/**
 * A rich document's extracted text (capped at MAX_TEXT_BYTES), or the error
 * for an image-only document or one whose text could not be extracted.
 * @param {string} path
 * @param {string} filename
 * @param {string} contentType
 * @param {Buffer} buf
 * @param {{ image?: boolean }} [kind]  `image`: the file is a picture, read through OCR
 */
async function extractedFileResult(path, filename, contentType, buf, kind = {}) {
    const { extractAttachment } = require('../../core/documents/attachmentExtractor');
    const result = /** @type {ExtractedDoc} */ (await extractAttachment({
        name: filename,
        type: contentType,
        content: buf.toString('base64'),
    }));
    if (result.kind === 'text') {
        const truncated = result.text.length > MAX_TEXT_BYTES;
        const text = truncated
            ? result.text.slice(0, MAX_TEXT_BYTES) + '\n\n... [truncated — extracted text too large]'
            : result.text;
        return {
            path,
            size: buf.length,
            contentType,
            extractedVia: result.source,
            truncated,
            content: text,
            meta: result.meta,
        };
    }
    if (result.kind === 'images') {
        return {
            error: `${filename} appears to be an image-only document (${result.meta?.numPages || '?'} pages) with no extractable text. Configure Azure Document Intelligence or Mistral OCR to read scanned PDFs from Nextcloud.`,
            size: buf.length,
            contentType,
        };
    }
    if (kind.image) {
        return {
            error: `No text could be read from ${filename}: it is an image, and its text is read by an OCR provider (Azure Document Intelligence or Mistral OCR). Either none is configured, or the image has no readable text.`,
            size: buf.length,
            contentType,
        };
    }
    return {
        error: `Could not extract text from ${filename}: ${result.reason}.`,
        size: buf.length,
        contentType,
    };
}

/**
 * Plain text path — UTF-8 decode with binary-safety probe; a file past
 * MAX_TEXT_BYTES is cut on a character boundary and marked.
 * @param {string} path
 * @param {string} contentType
 * @param {Buffer} buf
 */
function plainTextFileResult(path, contentType, buf) {
    const isText = /^(text\/|application\/(json|xml|x-yaml|x-sh|javascript))/i.test(contentType) || buf.slice(0, 1024).every(b => b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127));
    if (!isText) {
        return { error: `File appears to be binary (${contentType || 'unknown type'}). Reading binary files of this type is not supported.`, size: buf.length, contentType };
    }
    const truncated = buf.length > MAX_TEXT_BYTES;
    // Cut on a character boundary: a continuation byte (10xxxxxx) at the
    // cut means the last character is split, so drop its start too.
    let end = Math.min(buf.length, MAX_TEXT_BYTES);
    while (truncated && end > 0 && (buf[end] & 0xC0) === 0x80) end--;
    const content = buf.slice(0, end).toString('utf-8');
    return {
        path,
        size: buf.length,
        contentType: contentType || 'text/plain',
        truncated,
        content: truncated ? content + '\n\n... [truncated — file too large]' : content,
    };
}

module.exports = { readNextcloudFile };
