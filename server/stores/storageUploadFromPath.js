/**
 * Upload a file from disk without holding it whole in memory (issue #286).
 * Lives next to storageStore.js, which wires it with its own primitives so the
 * store keeps a single owner of the S3 client and the local-mode layout.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const log = require('../telemetry/log');

/** Part size; also the threshold below which one PutObject is used. */
const FILE_UPLOAD_PART_BYTES = 16 * 1024 * 1024;

/**
 * @param {{
 *   getMode: () => string | null,
 *   hasS3: () => boolean,
 *   localPathFor: (key: string) => string,
 *   uploadFile: (key: string, buffer: Buffer, contentType: string) => Promise<{ key: string }>,
 *   beginMultipartUpload: (key: string, contentType?: string) => Promise<{ uploadId: string }>,
 *   uploadPartBuffer: (key: string, uploadId: string, partNumber: number, buf: Buffer) => Promise<{ etag: string }>,
 *   completeMultipartUpload: (key: string, uploadId: string, parts: Array<{partNumber:number, etag:string}>) => Promise<any>,
 *   abortMultipartUpload: (key: string, uploadId: string) => Promise<any>,
 * }} deps
 */
function createUploadFileFromPath(deps) {
    /**
     * Same stored result as uploadFile (content type, no encryption layer here
     * either), but a 500 MB recording costs one 16 MB buffer instead of 500 MB.
     * Small files take the single PutObject path; larger ones go up as 16 MB
     * multipart parts, and a failed upload is aborted so no orphan parts are
     * left behind. Callers that retry simply call it again: every attempt reads
     * the file afresh.
     * @param {string} key
     * @param {string} filePath
     * @param {string} contentType
     * @returns {Promise<{ key: string }>}
     */
    return async function uploadFileFromPath(key, filePath, contentType) {
        if (deps.getMode() === 'local') {
            const dest = deps.localPathFor(key);
            await fs.promises.mkdir(path.dirname(dest), { recursive: true });
            await fs.promises.copyFile(filePath, dest);
            if (contentType) {
                try { await fs.promises.writeFile(dest + '.meta', String(contentType), 'utf8'); }
                catch (err) { log.debug('non-fatal, extension fallback covers this', err); }
            }
            log.info(`[StorageStore:local] Uploaded: ${key} (from file)`);
            return { key };
        }
        if (!deps.hasS3()) throw new Error('StorageStore not initialized');

        const fh = await fs.promises.open(filePath, 'r');
        try {
            const { size } = await fh.stat();
            if (size <= FILE_UPLOAD_PART_BYTES) {
                const buf = Buffer.alloc(size);
                if (size > 0) await fh.read(buf, 0, size, 0);
                return await deps.uploadFile(key, buf, contentType);
            }
            const { uploadId } = await deps.beginMultipartUpload(key, contentType);
            try {
                /** @type {Array<{partNumber:number, etag:string}>} */
                const parts = [];
                const buf = Buffer.allocUnsafe(FILE_UPLOAD_PART_BYTES);
                for (let pos = 0, n = 1; pos < size; pos += FILE_UPLOAD_PART_BYTES, n++) {
                    const want = Math.min(FILE_UPLOAD_PART_BYTES, size - pos);
                    const { bytesRead } = await fh.read(buf, 0, want, pos);
                    if (bytesRead !== want) throw new Error('uploadFileFromPath: file changed while uploading');
                    const { etag } = await deps.uploadPartBuffer(key, uploadId, n, buf.subarray(0, want));
                    parts.push({ partNumber: n, etag });
                }
                await deps.completeMultipartUpload(key, uploadId, parts);
            } catch (e) {
                try { await deps.abortMultipartUpload(key, uploadId); } catch (err) { log.debug('best effort', err); }
                throw e;
            }
            log.info(`[StorageStore] Uploaded: ${key} (${(size / 1024).toFixed(1)} KB, multipart)`);
            return { key };
        } finally {
            await fh.close();
        }
    };
}

module.exports = { createUploadFileFromPath, FILE_UPLOAD_PART_BYTES };
