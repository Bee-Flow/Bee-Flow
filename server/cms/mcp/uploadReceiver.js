/**
 * `PUT /mcp/cms/upload/<ticketId>` (secret in the `X-Upload-Ticket` header) — receive a file for a CMS asset.
 *
 * The ticket (uploadTickets.js) is the credential: a coding agent runs
 * `curl -T` with the URL a tool result handed it. Order of work, and why:
 *
 *   1. cheap checks that must NOT burn the ticket (so a typo in the command
 *      can be retried): ticket exists / unexpired / unused, Content-Type equals
 *      the ticket's, Content-Length within the ticket's size;
 *   2. the whole access decision again (accessCheck.js) — the token may have been
 *      revoked or downgraded, the org may have changed its IP allow-list, the user
 *      lost admin rights, in the minutes since the ticket was issued;
 *   3. BURN the ticket (atomic, uploadTickets.burn). Everything after this point
 *      spends it, success or not. That is the point: two PUTs racing for one
 *      ticket cannot both store a file;
 *   4. stream the body to a private temp file with a hard byte cap (never held
 *      whole in memory), validate by type, store through the same storage path
 *      the CMS uploader uses so the file shows up in the asset library;
 *   5. record the outcome on the ticket for cms_upload_status, remove the temp.
 *
 * Every collaborator is injected, so the lifecycle is tested without a server,
 * a database or object storage.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const log = require('../../telemetry/log');
const { CLIP_MIME_WHITELIST, VTT_CONTENT_TYPE } = require('../../core/cms/uploadPolicy');

/** The file extension an asset of this type gets; the client's own extension is not trusted. */
const EXT_BY_TYPE = Object.freeze({
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/apng': '.png',
    'image/svg+xml': '.svg',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'text/vtt': '.vtt',
});

const INVALID_TICKET = 'This upload URL is not valid. It may have expired or been used already; call cms_request_upload for a new one.';

/** Storage key for a new asset: same shape as the CMS uploader's, `cms/<ts>-<rand>-<name>.<ext>`. */
function assetKeyFor(filename, contentType) {
    const ext = EXT_BY_TYPE[String(contentType).toLowerCase()] || '';
    const safeBase = String(filename || 'upload')
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .replace(/\.[^.]+$/, '')
        .slice(0, 80) || 'upload';
    return `cms/${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${safeBase}${ext}`;
}

const assetUrlFor = (key) => `/api/cms/asset/${key.split('/').map(encodeURIComponent).join('/')}`;

class TooLargeError extends Error {}
class AbortedError extends Error {}

/**
 * Pipe a readable into a file, stopping the moment it passes `maxBytes`.
 * Deliberately not stream.pipeline: pipeline destroys the request on failure,
 * and a destroyed request is a closed socket — the client would get a reset
 * instead of the 413 explaining why.
 * @returns {Promise<number>} bytes written
 */
function receiveToFile(readable, filePath, maxBytes) {
    return new Promise((resolve, reject) => {
        const out = fs.createWriteStream(filePath, { flags: 'wx', mode: 0o600 });
        let bytes = 0;
        let settled = false;
        let ended = false;
        const fail = (err) => {
            if (settled) return;
            settled = true;
            readable.unpipe(out);
            readable.pause();
            out.destroy();
            reject(err);
        };
        readable.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > maxBytes) fail(new TooLargeError('too large'));
        });
        readable.on('end', () => { ended = true; });
        readable.on('error', fail);
        readable.on('close', () => { if (!ended) fail(new AbortedError('connection closed before the upload finished')); });
        out.on('error', fail);
        out.on('finish', () => {
            if (settled) return;
            settled = true;
            resolve(bytes);
        });
        readable.pipe(out);
    });
}

/**
 * @param {object} deps
 * @param {ReturnType<import('./uploadTickets').createUploadTickets>} deps.tickets
 * @param {{ isAvailable(): boolean, uploadFile(key: string, body: Buffer, type: string, meta?: object|null): Promise<void> }} deps.storage
 * @param {(filePath: string, size: number, key: string, type: string) => Promise<void>} deps.streamIntoStorage
 * @param {(buf: Buffer) => Buffer|null} deps.sanitizeSvg
 * @param {(buf: Buffer) => boolean} deps.isValidVtt
 * @param {(head: Buffer, ext: string) => boolean} deps.looksLikeClip
 * @param {(bound: object, ip: string) => Promise<{ ok: boolean, reason?: string }>} deps.checkAccess  see accessCheck.js
 * @param {() => string} [deps.tmpRoot]
 */
function createUploadReceiver(deps) {
    const tmpRoot = deps.tmpRoot || (() => os.tmpdir());

    /**
     * @param {{ ticket: string, contentType: string, contentLength: number|null, ip: string,
     *           stream: import('stream').Readable }} req
     * @returns {Promise<{ status: number, body: object, closeConnection?: boolean }>}
     */
    async function handle({ ticket, contentType, contentLength, ip, stream }) {
        // 1. Cheap checks — none of these spends the ticket.
        const seen = await deps.tickets.peek(ticket);
        if (!seen.ok) {
            log.warn(`[CmsMcp] upload refused: ticket ${seen.reason}`);
            return { status: 403, body: { error: INVALID_TICKET }, closeConnection: true };
        }
        const bound = seen.record;
        const sentType = String(contentType || '').split(';')[0].trim().toLowerCase();
        if (sentType !== String(bound.contentType).toLowerCase()) {
            return {
                status: 415,
                body: { error: `This upload URL takes ${bound.contentType}; the request said ${sentType || 'no Content-Type'}. Send -H 'Content-Type: ${bound.contentType}'.` },
                closeConnection: true,
            };
        }
        if (contentLength !== null && contentLength > bound.maxSize) {
            return {
                status: 413,
                body: { error: `The file is larger than the ${bound.maxSize} bytes this upload URL was issued for.` },
                closeConnection: true,
            };
        }
        if (contentLength === 0) {
            return { status: 400, body: { error: 'The upload is empty.' }, closeConnection: true };
        }

        // 2. The full access decision as it stands now (token, account, org
        //    policy, IPs, scope, CMS admin). The reason goes to the log only.
        const access = await deps.checkAccess(bound, ip);
        if (!access.ok) {
            log.warn(`[CmsMcp] upload refused: access ${access.reason} (ticket=${seen.id} ip=${ip})`);
            return { status: 403, body: { error: INVALID_TICKET }, closeConnection: true };
        }
        if (!deps.storage.isAvailable()) {
            return { status: 503, body: { error: 'Asset storage is not available on this server.' }, closeConnection: true };
        }

        // 3. Spend the ticket before a single byte is stored.
        const burned = await deps.tickets.burn(ticket);
        if (!burned.ok) {
            return { status: 403, body: { error: INVALID_TICKET }, closeConnection: true };
        }
        const { id } = burned;
        const type = String(bound.contentType).toLowerCase();

        // 4. Receive, validate, store.
        let dir = null;
        try {
            dir = await fs.promises.mkdtemp(path.join(tmpRoot(), 'beeflow-cms-mcp-'));
            const filePath = path.join(dir, 'upload.bin');
            let size;
            try {
                size = await receiveToFile(stream, filePath, bound.maxSize);
            } catch (err) {
                const tooLarge = err instanceof TooLargeError;
                const message = tooLarge
                    ? `The file is larger than the ${bound.maxSize} bytes this upload URL was issued for. Request a new URL with the real size.`
                    : 'The upload did not finish.';
                await deps.tickets.finish(id, { state: 'failed', error: message });
                return { status: tooLarge ? 413 : 400, body: { error: message }, closeConnection: true };
            }
            if (size === 0) {
                await deps.tickets.finish(id, { state: 'failed', error: 'The upload was empty.' });
                return { status: 400, body: { error: 'The upload is empty.' }, closeConnection: true };
            }

            const key = bound.key || assetKeyFor(bound.filename, type);
            let storedSize = size;
            let storedType = type;

            if (CLIP_MIME_WHITELIST.has(type)) {
                const head = Buffer.alloc(16);
                const fh = await fs.promises.open(filePath, 'r');
                try { await fh.read(head, 0, 16, 0); } finally { await fh.close(); }
                if (!deps.looksLikeClip(head, EXT_BY_TYPE[type])) {
                    const message = 'This file is not a valid MP4 or WebM video.';
                    await deps.tickets.finish(id, { state: 'failed', error: message });
                    return { status: 400, body: { error: message } };
                }
                await deps.streamIntoStorage(filePath, size, key, type);
            } else {
                // Images are capped at 25 MB and captions at 1 MB, so a buffer is
                // fine here; the cap was enforced while receiving.
                let body = await fs.promises.readFile(filePath);
                let metadata = null;
                if (type === 'image/svg+xml') {
                    const clean = deps.sanitizeSvg(body);
                    if (!clean) {
                        const message = 'Invalid or unsafe SVG.';
                        await deps.tickets.finish(id, { state: 'failed', error: message });
                        return { status: 400, body: { error: message } };
                    }
                    body = clean;
                    metadata = { sanitized: '1' };
                } else if (type === VTT_CONTENT_TYPE && !deps.isValidVtt(body)) {
                    const message = 'Invalid captions file (a WebVTT file under 1 MB that starts with WEBVTT).';
                    await deps.tickets.finish(id, { state: 'failed', error: message });
                    return { status: 400, body: { error: message } };
                }
                storedSize = body.length;
                await deps.storage.uploadFile(key, body, storedType, metadata);
            }

            const asset = { key, url: assetUrlFor(key), contentType: storedType, size: storedSize };
            await deps.tickets.finish(id, { state: 'done', asset });
            log.info(`[CmsMcp] upload stored ticket=${id} key=${key} bytes=${storedSize}`);
            return { status: 200, body: asset };
        } catch (err) {
            log.error(`[CmsMcp] upload failed ticket=${id}: ${err.message}`);
            await deps.tickets.finish(id, { state: 'failed', error: 'The file could not be stored.' }).catch(() => {});
            return { status: 500, body: { error: 'The file could not be stored.' }, closeConnection: true };
        } finally {
            // Before the response goes out, so an answered caller can rely on the temp being gone.
            if (dir) await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
        }
    }

    return { handle };
}

module.exports = { createUploadReceiver, assetKeyFor, assetUrlFor, receiveToFile, EXT_BY_TYPE, INVALID_TICKET };
