// @typecheck strict
/**
 * nextcloud_upload_file — write bytes to a path: from an opaque source handle
 * (a Gmail attachment, or a file a document/presentation step kept for this
 * run) or from inline content (text, or base64 checked first). A missing
 * parent folder chain is created once and the PUT retried.
 */

'use strict';

const { joinDavPath, ensureParentFolders } = require('./webdav');

/**
 * @typedef {import('./fileOperations').FileOpArgs} FileOpArgs
 * @typedef {import('./webdav').FilesToolCtx} FilesToolCtx
 * @typedef {Buffer<ArrayBuffer> | Buffer<ArrayBufferLike> | string} UploadBody
 */

/**
 * @param {FileOpArgs} args
 * @param {FilesToolCtx} ctx
 */
async function uploadNextcloudFile(args, ctx) {
    if (!args.path) return { error: 'path is required' };
    const hasHandle = args.sourceHandle && typeof args.sourceHandle === 'object';
    const hasContent = typeof args.content === 'string';
    if (hasHandle && hasContent) return { error: 'Pass either sourceHandle or content, not both.' };
    if (!hasHandle && !hasContent) {
        return { error: 'Either sourceHandle (preferred for binary) or content (for inline text) is required.' };
    }

    // A folder path is only fine for a generated file, which takes its own name.
    if (/\/$/.test(String(args.path)) && !(hasHandle && args.sourceHandle?.kind === 'generated_file')) { // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- a one-character end anchor
        return { error: `path "${args.path}" is a folder. Give a file name, e.g. "${args.path}report.txt".` };
    }

    const resolved = await resolveUploadBody(args, ctx);
    if ('error' in resolved) return resolved;
    const { body, handleMime, path } = resolved;

    // joinDavPath drops a trailing slash, so "/Docs/" would PUT a file
    // named "Docs" and fail on its missing parent. A folder is not a file.
    if (/\/$/.test(String(path))) {
        return { error: `path "${path}" is a folder. Give a file name, e.g. "${path}report.txt".` };
    }
    return putFile(path, body, args.contentType || handleMime, ctx);
}

/**
 * Resolve to bytes. Handles stay opaque to the model — this is what keeps a
 * PDF attachment out of the conversation entirely, and it is why binding
 * base64 into `content` is not a real option: the PUT is byte-exact, so a
 * base64 string would land as a base64 *text file* rather than the document.
 * A generated file named by a folder path takes the file's own name.
 * @param {FileOpArgs} args  with a sourceHandle or string content
 * @param {FilesToolCtx} ctx
 * @returns {Promise<{ body: UploadBody, handleMime: string | null, path: string } | { error: string }>}
 */
async function resolveUploadBody(args, ctx) {
    const path = /** @type {string} */ (args.path);
    const handle = args.sourceHandle;
    if (handle && typeof handle === 'object') {
        const kind = handle.kind;
        if (kind === 'gmail_attachment') {
            const { fetchAttachmentBuffer } = require('../gmailTools');
            const fetched = await fetchAttachmentBuffer(ctx.session, {
                messageId: handle.messageId,
                attachmentId: handle.attachmentId,
            });
            return { body: fetched.buffer, handleMime: handle.mimeType || null, path };
        }
        if (kind === 'generated_file') return readGeneratedUpload(handle, path, ctx);
        return { error: `Unsupported sourceHandle.kind: ${kind}` };
    }
    const content = /** @type {string} */ (args.content);
    if (args.isBase64) {
        // Buffer.from(..., 'base64') never throws: it skips what it
        // cannot read and stores the rest, so check the text first.
        const b64 = content.replace(/\s+/g, '');
        if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(b64) || b64.length % 4 === 1) {
            return { error: 'content is not valid base64. Send base64 text, or set isBase64 to false for plain text.' };
        }
        return { body: Buffer.from(b64, 'base64'), handleMime: null, path };
    }
    return { body: content, handleMime: null, path };
}

/**
 * A file a document/presentation step kept for THIS run — resolved against
 * the journey's run ids, never by id alone.
 * @param {NonNullable<FileOpArgs['sourceHandle']>} handle
 * @param {string} path
 * @param {FilesToolCtx} ctx
 * @returns {Promise<{ body: UploadBody, handleMime: string | null, path: string } | { error: string }>}
 */
async function readGeneratedUpload(handle, path, ctx) {
    const { readGeneratedFile } = require('../../core/automationRunner/generatedFileHandle');
    /** @type {{ buffer: Buffer; filename: string; mimeType: string; size: number; } | null} */
    let file;
    try {
        file = await readGeneratedFile(/** @type {{ kind: 'generated_file', fileId: string }} */ (handle), ctx.runScope || null);
    } catch (e) {
        return { error: /** @type {Error} */ (e).message };
    }
    if (!file) return { error: 'That fileId is not a live file of this run (expired, or produced by another automation).' };
    return {
        body: file.buffer,
        handleMime: handle.mimeType || file.mimeType || null,
        // A folder path takes the file's own name.
        path: /\/$/.test(String(path || '')) ? `${path}${file.filename}` : path,
    };
}

/**
 * PUT the bytes. 409 or 404 = a parent folder is missing (Nextcloud answers
 * 404 for a PUT into a missing folder, 409 on older servers): the chain is
 * created once and the PUT retried, so an automation saving into
 * "/Invoices/Vendor/" needs no create-folder steps (which fail with "already
 * exists" on every later run). The happy path still costs a single PUT.
 * @param {string} path
 * @param {UploadBody} body
 * @param {string | null | undefined} contentType  the caller's type, else the handle's
 * @param {FilesToolCtx} ctx
 */
async function putFile(path, body, contentType, ctx) {
    const { ncFetch, authError, root } = ctx;
    const url = joinDavPath(root, path);
    const put = () => ncFetch(url, {
        method: 'PUT',
        headers: {
            'Content-Type': contentType
                || (Buffer.isBuffer(body) ? 'application/octet-stream' : 'text/plain; charset=utf-8'),
        },
        body,
    });
    let res = await put();
    let retried = false;
    if (res.status === 409 || res.status === 404) {
        await ensureParentFolders(ncFetch, root, path);
        res = await put();
        retried = true;
    }
    if (res.status === 401) return { error: authError };
    if (res.status === 409 || (retried && res.status === 404)) return { error: `Parent folder for ${path} does not exist and could not be created.` };
    if (!res.ok && res.status !== 201 && res.status !== 204) {
        const text = await res.text().catch(() => '');
        return { error: `Upload failed (${res.status}): ${text.slice(0, 200)}` };
    }
    return {
        success: true,
        path,
        bytes: Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body),
        created: res.status === 201,
        updated: res.status === 204,
    };
}

module.exports = { uploadNextcloudFile };
