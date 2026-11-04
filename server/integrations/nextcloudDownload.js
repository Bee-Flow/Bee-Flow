// @typecheck strict
/**
 * The capped download of a Nextcloud file to disk (nextcloudClient.downloadBinary):
 * a declared Content-Length over the cap is refused before a byte is read, and
 * a body that grows past it is cut off with no partial file left behind.
 */

const { bestEffort } = require('../utils/bestEffort');

/** `err.code` of a download refused or cut off for passing its `maxBytes`. */
const DOWNLOAD_TOO_LARGE = 'download_too_large';

/**
 * @param {number} maxBytes
 * @returns {Error & { code: string, maxBytes: number }}
 */
function downloadTooLarge(maxBytes) {
    return Object.assign(new Error(`The file is larger than the ${Math.round(maxBytes / (1024 * 1024))} MB download limit.`),
        { code: DOWNLOAD_TOO_LARGE, maxBytes });
}

/**
 * A declared Content-Length over the cap is refused before a byte is read.
 * @param {Response} res
 * @param {number} maxBytes
 */
async function refuseDeclaredOversize(res, maxBytes) {
    const declared = Number(res.headers?.get?.('content-length'));
    if (!Number.isFinite(declared) || declared <= maxBytes) return;
    try { await res.body?.cancel(); } catch (err) { bestEffort('integrations/nextcloudDownload:refuseDeclaredOversize', err); }
    throw downloadTooLarge(maxBytes);
}

/**
 * Pipe a response body to `destPath`, cut off once it passes `maxBytes`
 * (0 = no cap); a cut-off leaves no partial file behind.
 * @param {Response} res
 * @param {string} destPath
 * @param {number} maxBytes
 */
async function writeBodyToFile(res, destPath, maxBytes) {
    const fs = require('fs');
    const { Readable, Transform } = require('stream');
    const { pipeline } = require('stream/promises');

    if (!res.body) throw new Error('Nextcloud download failed (empty body)');
    // Node's fetch returns a Web ReadableStream — convert to a Node stream
    // so .pipe() works and we don't keep the entire body in memory.
    const nodeStream = typeof Readable.fromWeb === 'function'
        ? Readable.fromWeb(/** @type {import('stream/web').ReadableStream} */ (res.body))
        : res.body;
    const out = fs.createWriteStream(destPath);
    if (!maxBytes) {
        await pipeline(nodeStream, out);
        return;
    }
    let seen = 0;
    const cap = new Transform({
        transform(chunk, _enc, done) {
            seen += chunk.length;
            if (seen > maxBytes) done(downloadTooLarge(maxBytes));
            else done(null, chunk);
        },
    });
    try {
        await pipeline(nodeStream, cap, out);
    } catch (err) {
        if (/** @type {{ code?: string }} */ (err).code === DOWNLOAD_TOO_LARGE) {
            try { fs.unlinkSync(destPath); } catch (unlinkErr) {
                if (/** @type {NodeJS.ErrnoException} */ (unlinkErr).code !== 'ENOENT') bestEffort('integrations/nextcloudDownload:writeBodyToFile', unlinkErr);
            }
        }
        throw err;
    }
}

module.exports = { DOWNLOAD_TOO_LARGE, downloadTooLarge, refuseDeclaredOversize, writeBodyToFile };
