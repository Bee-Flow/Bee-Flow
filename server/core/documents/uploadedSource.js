// @typecheck
/**
 * A file uploaded as a SOURCE of a notebook or a webpage: the source type its
 * extension names, and a copy in object storage when storage is configured.
 *
 * routes/notebooks.js and routes/webpages/sources.js carried this block word
 * for word (only the key prefix and the storage folder differ). One copy keeps
 * the two from quietly naming the same file two different source types, or
 * sanitising its storage name two different ways.
 *
 * Run: cd server && node --test core/documents/uploadedSource.test.js
 */

'use strict';

const crypto = require('crypto');

/** Extension → the source type the ingestion pipelines know. */
const SOURCE_TYPE_BY_EXTENSION = Object.freeze({
    pdf: 'pdf', docx: 'docx', doc: 'docx', xlsx: 'xlsx', xls: 'xlsx', csv: 'csv', txt: 'text', md: 'text',
});

/**
 * The source type for a file name; 'file' for anything else. An own-property
 * lookup, so an extension like `.constructor` is a plain 'file' too.
 * @param {string} fileName
 * @returns {string}
 */
function sourceTypeOf(fileName) {
    const ext = (String(fileName || '').split('.').pop() || '').toLowerCase();
    return Object.hasOwn(SOURCE_TYPE_BY_EXTENSION, ext) ? SOURCE_TYPE_BY_EXTENSION[/** @type {keyof typeof SOURCE_TYPE_BY_EXTENSION} */ (ext)] : 'file';
}

/**
 * Read multer's in-memory file, and keep a copy in object storage when it is
 * available (`storageKey` is null otherwise). The storage name is
 * `<prefix>_<ms>_<random>_<name>`, the name reduced to [a-zA-Z0-9._-].
 *
 * @param {{ originalname: string, mimetype: string, buffer: Buffer }} file
 * @param {{ userId: string, prefix: string, folder: string, storage?: any, protectBuffer?: ((buffer: Buffer, key: string) => Promise<Buffer>)|null }} opts
 *   `storage` defaults to stores/storageStore (injectable for tests).
 * @returns {Promise<{ fileName: string, mimeType: string, buffer: Buffer, type: string, storageKey: string|null }>}
 */
async function keepUploadedSource(file, { userId, prefix, folder, storage = require('../../stores/storageStore'), protectBuffer = null }) {
    const fileName = file.originalname;
    const mimeType = file.mimetype;
    const buffer = file.buffer;
    let storageKey = null;
    if (storage.isAvailable()) {
        const storageName = `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${fileName.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
        storageKey = storage.buildKey(userId, folder, storageName);
        const stored = protectBuffer ? await protectBuffer(buffer, storageKey) : buffer;
        await storage.uploadFile(storageKey, stored, protectBuffer ? 'application/octet-stream' : mimeType);
    }
    return { fileName, mimeType, buffer, type: sourceTypeOf(fileName), storageKey };
}

module.exports = { keepUploadedSource, sourceTypeOf, SOURCE_TYPE_BY_EXTENSION };
