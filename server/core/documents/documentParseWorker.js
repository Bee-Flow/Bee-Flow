// @typecheck strict
'use strict';
/**
 * The worker side of ./documentParsePool.js: holds the document parsers
 * loaded and answers one parse at a time. A parse that overruns its deadline
 * or its memory ceiling is ended from the outside; nothing here needs to know.
 */

const { parentPort } = require('worker_threads');
const { parseInProcess } = require('./documentParser');

if (!parentPort) throw new Error('documentParseWorker must run as a worker thread');
const port = parentPort;

port.on('message', async (/** @type {{ buffer: Uint8Array, mimeType: string, filename: string, options: object }} */ job) => {
    try {
        const buffer = Buffer.isBuffer(job.buffer) ? job.buffer : Buffer.from(job.buffer.buffer, job.buffer.byteOffset, job.buffer.byteLength);
        const text = await parseInProcess(buffer, job.mimeType, job.filename, job.options);
        port.postMessage({ ok: true, text });
    } catch (err) {
        port.postMessage({ ok: false, error: /** @type {Error} */ (err)?.message || String(err) });
    }
});
