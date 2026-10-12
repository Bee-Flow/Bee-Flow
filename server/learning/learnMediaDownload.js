'use strict';
/**
 * HTTP download helpers for the Learning Center video pack (learnMediaInstall.js):
 * https only (plain http only on loopback, for tests), every redirect hop held to
 * the same rule, size caps, hashing while writing.
 */

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

const isLoopback = (url) => ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);

/**
 * GET a URL, following redirects by hand so that every hop is held to the same
 * rule: https, or http on loopback. GitHub release assets redirect to
 * objects.githubusercontent.com, so redirects must work.
 */
async function openUrl(source, { fetchImpl = globalThis.fetch, what = 'download', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    let url = new URL(source);
    const signal = AbortSignal.timeout(timeoutMs);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url))) throw new Error(`${what} must be an https URL`);
        const res = await fetchImpl(url, { redirect: 'manual', signal });
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
            if (res.body) await res.body.cancel().catch(() => {});
            url = new URL(res.headers.get('location'), url);
            continue;
        }
        if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
        return res;
    }
    throw new Error('download failed: too many redirects');
}

/**
 * Stream a response body to `file`, hashing while writing. Refuses a body that
 * declares or turns out larger than `maxBytes`. Returns { sha256, bytes }.
 */
async function streamToFile(res, file, maxBytes, tooLarge = 'download too large') {
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > maxBytes) throw new Error(`${tooLarge} (${declared} bytes)`);
    const hash = createHash('sha256');
    let bytes = 0;
    const meter = new Transform({
        transform(chunk, _enc, cb) {
            bytes += chunk.length;
            if (bytes > maxBytes) return cb(new Error(tooLarge));
            hash.update(chunk);
            return cb(null, chunk);
        },
    });
    await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(file));
    return { sha256: hash.digest('hex'), bytes };
}

module.exports = { openUrl, streamToFile };
