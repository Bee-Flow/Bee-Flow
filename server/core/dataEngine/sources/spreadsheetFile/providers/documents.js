// @typecheck strict
/**
 * The "documents" listing mode of the three storages.
 *
 * The spreadsheet mirror lists folders plus spreadsheets. A knowledge-base
 * folder source lists folders plus every file the text extractor can read
 * (core/kb/kbFileExtract.js: PDF, Word, PowerPoint, Excel, CSV, plain text,
 * Markdown) and, on Google Drive, the native Docs, Slides and Sheets, which
 * have no bytes of their own and are EXPORTED to docx, pptx and xlsx on
 * download. The mode is chosen per api instance (`forLinker(cred, { accept:
 * 'documents' })`); without it every provider behaves as before.
 *
 * Pure: names, MIME types and the export table. No client, no I/O.
 */

'use strict';

const ACCEPT_DOCUMENTS = 'documents';
/** Documents mode lists a whole folder to enumerate it, so it asks for bigger pages than the browser does. */
const DOCUMENTS_PAGE_SIZE = 200;

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Extension → the MIME type the extractor is handed. */
const EXT_MIME = Object.freeze({
    pdf: 'application/pdf',
    docx: DOCX,
    pptx: PPTX,
    xlsx: XLSX,
    xls: 'application/vnd.ms-excel',
    csv: 'text/csv',
    txt: 'text/plain',
    md: 'text/markdown',
});

/** Extension spellings that mean one of the keys above. */
const EXT_ALIASES = Object.freeze({ markdown: 'md', text: 'txt' });

/** MIME type → extension, for a file whose name has no usable extension. */
const MIME_EXT = Object.freeze({
    'application/pdf': 'pdf',
    [DOCX]: 'docx',
    [PPTX]: 'pptx',
    [XLSX]: 'xlsx',
    'application/vnd.ms-excel': 'xls',
    'text/csv': 'csv',
    'application/csv': 'csv',
    'text/plain': 'txt',
    'text/markdown': 'md',
    'text/x-markdown': 'md',
});

/**
 * Google's native formats and what they are exported to. `format` is the
 * FileRef format of such a file; the export has the bytes of `mime`.
 * @type {Readonly<Record<string, { format: string, ext: string, mime: string }>>}
 */
const GOOGLE_EXPORTS = Object.freeze({
    'application/vnd.google-apps.document': { format: 'gdoc', ext: 'docx', mime: DOCX },
    'application/vnd.google-apps.presentation': { format: 'gslides', ext: 'pptx', mime: PPTX },
    'application/vnd.google-apps.spreadsheet': { format: 'gsheet', ext: 'xlsx', mime: XLSX },
});

/**
 * The MIME types a Drive listing asks for in documents mode. A storage often
 * types an uploaded `.md` or `.docx` as application/octet-stream, so that is
 * in the list; the extension decides afterwards.
 */
const QUERY_MIMES = Object.freeze([
    ...new Set([...Object.values(EXT_MIME), ...Object.keys(MIME_EXT), ...Object.keys(GOOGLE_EXPORTS), 'application/octet-stream']),
]);

/**
 * @param {string | null | undefined} name
 * @returns {string | null} the lower-case extension without the dot
 */
function extensionOf(name) {
    const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : null;
}

/**
 * The format of a file in documents mode: an extension key of EXT_MIME, a
 * Google native format (gdoc, gslides, gsheet), or null for anything the
 * extractor cannot read. The extension wins over the MIME type, for the same
 * reason as in providers/index.js formatOf.
 * @param {{ name?: string | null, mimeType?: string | null }} [file]
 * @returns {string | null}
 */
function documentFormatOf({ name, mimeType } = {}) {
    const native = mimeType ? GOOGLE_EXPORTS[mimeType] : undefined;
    if (native) return native.format;
    const raw = extensionOf(name);
    const ext = raw && Object.prototype.hasOwnProperty.call(EXT_ALIASES, raw)
        ? /** @type {Record<string, string>} */ (EXT_ALIASES)[raw] : raw;
    if (ext && Object.prototype.hasOwnProperty.call(EXT_MIME, ext)) return ext;
    const byMime = mimeType ? /** @type {Record<string, string>} */ (MIME_EXT)[String(mimeType).toLowerCase().split(';')[0]] : undefined;
    return byMime || null;
}

/**
 * @param {string | null | undefined} name
 * @returns {boolean} is this a file name the folder source reads?
 */
function isDocumentName(name) {
    return documentFormatOf({ name }) !== null;
}

/**
 * The export a Google native file is downloaded as, or null for anything else.
 * @param {string | null | undefined} mimeType
 */
function exportFor(mimeType) {
    return (mimeType && GOOGLE_EXPORTS[mimeType]) || null;
}

/**
 * The MIME type the extractor is handed for a file of this format.
 * @param {string | null | undefined} format  a documentFormatOf answer
 * @returns {string}
 */
function mimeForFormat(format) {
    if (format && Object.prototype.hasOwnProperty.call(EXT_MIME, format)) return /** @type {Record<string, string>} */ (EXT_MIME)[format];
    const native = Object.values(GOOGLE_EXPORTS).find((e) => e.format === format);
    return native ? native.mime : 'application/octet-stream';
}

/** @param {unknown} accept */
function isDocumentsMode(accept) {
    return accept === ACCEPT_DOCUMENTS;
}

module.exports = {
    ACCEPT_DOCUMENTS, DOCUMENTS_PAGE_SIZE, EXT_MIME, GOOGLE_EXPORTS, QUERY_MIMES,
    documentFormatOf, isDocumentName, exportFor, mimeForFormat, isDocumentsMode,
};
