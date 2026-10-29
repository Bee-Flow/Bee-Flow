// @typecheck strict
'use strict';
/**
 * A fingerprint of a generated file, small enough to compare two of them
 * (run compare, automation/testing/runCompare.js):
 *
 *   summarizeFile({ file, readBytes }, caps) → FileSummary
 *   FileSummary = { name, mime, size, sha256, parts?, tooLarge?, unreadable? }
 *   parts: slide  { kind: 'slide', index, title, textChars, textHash }
 *          sheet  { kind: 'sheet', index, name, rows, cols }
 *
 * A file is UNTRUSTED input, whoever made it:
 *  - the bytes are read through a byte cap (AUTOMATION_RUN_COMPARE_FILE_MAX_BYTES,
 *    20 MB, 0 = unlimited). Past it the summary is metadata only and says
 *    `tooLarge`;
 *  - a deck is opened part by part through pptxExtractor's slide reader. The
 *    size an archive DECLARES is not trusted: every part is inflated through a
 *    stream that counts the bytes it really produces and stops at the part cap
 *    or at what is left of a total budget over all parts (a zip bomb is
 *    refused after at most that many bytes, never inflated whole);
 *  - spreadsheets go through the spreadsheet formats' own door (20 MB cap and
 *    its parse limiter);
 *  - macros are never run: only text and counts are read;
 *  - a file that cannot be parsed gives metadata only, plus `unreadable`. This
 *    function never throws, so one odd file cannot sink a whole compare.
 *
 * `readBytes(maxBytes)` is the caller's: it returns a Buffer or throws an error
 * with `tooLarge: true` (see readCapped). Only files of the two journeys being
 * compared are ever handed in, so no other run's file names appear here.
 */

const crypto = require('node:crypto');
const JSZip = require('jszip');
const { envCap } = require('../mcpRunReadCaps');

const SHEET_FORMATS = Object.freeze(['xlsx', 'xlsm', 'xls', 'ods', 'csv']);
const MAX_SLIDES = 500;
const MAX_ZIP_ENTRIES = 5000;
const MAX_PART_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_PART_BYTES = 64 * 1024 * 1024;

const fileMaxBytes = () => envCap('AUTOMATION_RUN_COMPARE_FILE_MAX_BYTES', 20 * 1024 * 1024);

/**
 * Read a stream into a Buffer, refusing to hold more than `maxBytes` (0 = no
 * limit). The refusal is an error with `tooLarge: true`.
 * @param {AsyncIterable<Buffer>} stream
 * @param {number} maxBytes
 */
async function readCapped(stream, maxBytes) {
    /** @type {Buffer<ArrayBufferLike>[]} */
    const chunks = [];
    let total = 0;
    for await (const chunk of stream) {
        total += chunk.length;
        if (maxBytes > 0 && total > maxBytes) {
            /** @type {AsyncIterable<Buffer> & { destroy?: () => void }} */ (stream).destroy?.();
            throw Object.assign(new Error('file is over the compare size cap'), { tooLarge: true });
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

/**
 * @param {Buffer<ArrayBufferLike>} buffer
 */
const sha256Of = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

/**
 * @param {string} name
 */
const extensionOf = (name) => {
    const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
};

/**
 * 'pptx', a spreadsheet format, or null.
 * @param {string} name
 * @param {string} mime
 */
function formatOf(name, mime) {
    const ext = extensionOf(name);
    const base = String(mime || '').split(';')[0].trim().toLowerCase();
    if (ext === 'pptx' || base === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return 'pptx';
    if (SHEET_FORMATS.includes(ext)) return ext;
    if (base === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'xlsx';
    if (base === 'text/csv') return 'csv';
    if (base === 'application/vnd.ms-excel') return 'xls';
    if (base === 'application/vnd.oasis.opendocument.spreadsheet') return 'ods';
    return null;
}

/**
 * Inflate one archive part into a string, stopping as soon as it has produced
 * more than `limit` bytes. Counts what the inflater really outputs.
 * @param {import('jszip').JSZipObject} entry  a JSZip file entry
 * @param {number} limit
 * @returns {Promise<string>}
 */
function readPartCapped(entry, limit) {
    return new Promise((resolve, reject) => {
        /** @type {Buffer[]} */
        const chunks = [];
        let total = 0;
        let settled = false;
        const stream = entry.nodeStream('nodebuffer');
        stream.on('data', (/** @type {Buffer} */ chunk) => {
            if (settled) return;
            total += chunk.length;
            if (total > limit) {
                settled = true;
                // Stop reading rather than destroy: the inflater then pauses once its
                // buffer is full (destroy would leave it inflating into a closed stream).
                stream.removeAllListeners('data');
                stream.pause();
                reject(new Error(`${entry.name} is too large to read`));
                return;
            }
            chunks.push(chunk);
        });
        stream.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
        stream.on('error', (/** @type {Error} */ e) => { if (!settled) { settled = true; reject(e); } });
    });
}

/**
 * The slides of a deck: title, text length and a short hash of the text.
 * @param {Buffer<ArrayBufferLike>} buffer
 */
async function slideParts(buffer) {
    const { readSlidePart } = require('../../core/documents/pptxExtractor');
    const zip = await JSZip.loadAsync(buffer);
    const names = Object.keys(zip.files);
    if (names.length > MAX_ZIP_ENTRIES) throw new Error('too many parts in the archive');
    const slideNames = names
        .flatMap((n) => { const m = /^ppt\/slides\/slide(\d+)\.xml$/.exec(n); return m ? [{ n, order: Number(m[1]) }] : []; })
        .sort((a, b) => a.order - b.order)
        .map((x) => x.n)
        .slice(0, MAX_SLIDES);
    /** @type {{ kind: string; index: number; title: string; textChars: number; textHash: string; }[]} */
    const parts = [];
    let budget = MAX_TOTAL_PART_BYTES;
    for (const [i, name] of slideNames.entries()) {
        const entry = /** @type {import('jszip').JSZipObject | null} */ (zip.file(name));
        const xml = entry ? await readPartCapped(entry, Math.min(MAX_PART_BYTES, budget)) : '';
        budget -= Buffer.byteLength(xml, 'utf8');
        const { title, paragraphs } = readSlidePart(xml);
        const text = [title, ...paragraphs].filter(Boolean).join('\n');
        parts.push({
            kind: 'slide', index: i, title, textChars: text.length,
            textHash: crypto.createHash('sha256').update(text).digest('hex').slice(0, 12),
        });
    }
    return parts;
}

/**
 * The worksheets of a spreadsheet file: name, rows, columns.
 * @param {Buffer<ArrayBufferLike>} buffer
 * @param {string} format
 */
async function sheetParts(buffer, format) {
    const formats = require('../../core/dataEngine/sources/spreadsheetFile/formats');
    const sheets = await formats.listSheets(buffer, format);
    return sheets.map((s, i) => ({ kind: 'sheet', index: i, name: s.name ?? null, rows: s.rows, cols: s.cols }));
}

/**
 * @param {{ file: { name?: string, filename?: string, mime?: string, mimeType?: string, size?: number },
 *           readBytes: (maxBytes: number) => Promise<Buffer> }} input
 * @param {{ fileMaxBytes?: number }} [caps]
 * @returns {Promise<{ name: string, mime: string, size: number, sha256: string|null, parts?: any[], tooLarge?: true, unreadable?: true }>}
 */
async function summarizeFile({ file, readBytes }, caps = {}) {
    const max = caps.fileMaxBytes ?? fileMaxBytes();
    const name = String(file?.filename ?? file?.name ?? '');
    const mime = String(file?.mimeType ?? file?.mime ?? 'application/octet-stream');
    const meta = { name, mime, size: Number(file?.size) || 0, sha256: /** @type {string|null} */ (null) };
    if (max > 0 && meta.size > max) return { ...meta, tooLarge: true };

    /** @type {Buffer<ArrayBufferLike>} */
    let buffer;
    try {
        buffer = await readBytes(max);
    } catch (e) {
        return /** @type {{ tooLarge?: boolean }} */ (e)?.tooLarge ? { ...meta, tooLarge: true } : { ...meta, unreadable: true };
    }
    if (!Buffer.isBuffer(buffer)) return { ...meta, unreadable: true };
    meta.size = buffer.length;
    meta.sha256 = sha256Of(buffer);

    const format = formatOf(name, mime);
    if (!format) return meta;
    try {
        const parts = format === 'pptx' ? await slideParts(buffer) : await sheetParts(buffer, format);
        return { ...meta, parts };
    } catch {
        return { ...meta, unreadable: true };
    }
}

module.exports = { summarizeFile, readCapped, formatOf };
