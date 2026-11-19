// @typecheck strict
/**
 * Turn a source binding into the bytes of a file, for the `read_table` step.
 *
 * The binding is data a definition (or an upstream step) supplied, so nothing in
 * it is trusted beyond the file id:
 *
 *   { kind: 'form_upload',   fileId }  a file a visitor gave a form of THIS automation
 *   { kind: 'generated_file', fileId } a file an earlier step of THIS journey made
 *   { sourceHandle: <either> }         the same, wrapped by a step output
 *   { fileId, name, mime, size, url }  a file an App Studio app handed to this run
 *                                      (actionExecutor/automationBridge.js expandFileInput)
 *
 * The storage key always comes from the ledger row found by that id, never from
 * the descriptor, because a definition can carry a forged key, name or type. An
 * app's file is the exception: its key is the one the app's signed, time-limited
 * download URL names, read only after the signature checks out, only for an
 * app attachment and only of the automation's own owner (the app runs it as the
 * owner, utils/tempDownloadUrl.js).
 * The read is capped while streaming, so an oversized file is refused without
 * being loaded.
 */

'use strict';

const { tableLimits, exceeds } = require('./limits');

/**
 * @param {string} message
 * @param {string} errorClass
 */
function sourceError(message, errorClass) {
    return Object.assign(new Error(message), { errorClass });
}

/** @typedef {{ sourceHandle?: unknown, kind?: unknown, fileId?: unknown, url?: unknown, name?: unknown, mime?: unknown }} SourceDescriptor */

const NOT_FOUND = 'The file could not be found. It may have expired or belong to another automation.';

/**
 * The ledger-like row of a file an app handed over: the storage key its signed
 * URL names, when the signature is valid, the key is an app attachment and the
 * app belongs to the run's owner; null otherwise.
 * @param {SourceDescriptor} descriptor
 * @param {{ userId?: string }} ctx
 * @param {(url: string) => string | null} resolveKey
 */
function appFileRow(descriptor, ctx, resolveKey) {
    const key = typeof descriptor.url === 'string' ? resolveKey(descriptor.url) : null;
    if (!key || !ctx.userId || key.includes('..') || !key.startsWith(`studio-apps/${ctx.userId}/`) || !key.includes('/attachments/')) return null;
    return {
        storageKey: key,
        size: 0,
        filename: typeof descriptor.name === 'string' && descriptor.name.trim() ? descriptor.name.trim().slice(0, 200) : 'file',
        mimeType: typeof descriptor.mime === 'string' ? descriptor.mime : null,
    };
}

/**
 * The descriptor itself: an object with `.sourceHandle` is unwrapped (once).
 * @param {SourceDescriptor | null | undefined} value
 * @returns {SourceDescriptor | null | undefined}
 */
function unwrap(value) {
    if (value && typeof value === 'object' && !Array.isArray(value) && value.sourceHandle && typeof value.sourceHandle === 'object') {
        return /** @type {SourceDescriptor} */ (value.sourceHandle);
    }
    return value;
}

/**
 * @param {AsyncIterable<Buffer> & { destroy?: () => void }} stream
 * @param {number} maxBytes
 */
async function readCapped(stream, maxBytes) {
    const chunks = [];
    let total = 0;
    for await (const chunk of stream) {
        total += chunk.length;
        if (exceeds(total, maxBytes)) {
            stream.destroy?.();
            throw sourceError(`The file is larger than ${Math.round(maxBytes / 1048576)} MB, which is the limit for table files.`, 'table_source_too_large');
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

/**
 * @param {unknown} value
 * @param {{ automationId?: string, runId?: string, rootRunId?: string, userId?: string }} ctx
 * @param {{ store?: any, storage?: any, journeyRunIds?: Function, limits?: () => ReturnType<typeof tableLimits>, resolveTempKey?: (url: string) => string | null }} [deps]
 * @returns {Promise<{buffer: Buffer, filename: string, mimeType: string, size: number, kind: 'form_upload'|'generated_file'|'app_file'}>}
 */
async function readSourceFile(value, ctx, deps = {}) {
    const store = deps.store || require('../../../stores/automationStore');
    const storage = () => deps.storage || require('../../../stores/storageStore');
    const limits = deps.limits ? deps.limits() : tableLimits();

    const descriptor = unwrap(/** @type {SourceDescriptor | null | undefined} */ (value));
    if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
        throw sourceError('No file is connected to this step. Choose the file to read.', 'table_source_missing');
    }
    const { kind } = descriptor;
    const fileId = typeof descriptor.fileId === 'string' ? descriptor.fileId : '';
    const appFile = !kind && typeof descriptor.url === 'string';
    if (!appFile && kind !== 'form_upload' && kind !== 'generated_file') {
        if (!kind) throw sourceError('No file is connected to this step. Choose the file to read.', 'table_source_missing');
        throw sourceError('This step can read a file from a form, from an app or from an earlier step, not a source of another kind.', 'table_source_unsupported');
    }
    if (!fileId) throw sourceError('No file is connected to this step. Choose the file to read.', 'table_source_missing');

    let row;
    if (appFile) {
        row = appFileRow(descriptor, ctx, deps.resolveTempKey || require('../../../utils/tempDownloadUrl').resolveTempDownloadKey);
    } else if (kind === 'form_upload') {
        row = await store.getClaimedFormUploadForAutomation(fileId, ctx.automationId);
    } else {
        const journeyRunIds = deps.journeyRunIds || require('../generatedFileHandle').journeyRunIds;
        row = await store.getGeneratedFileForRuns(fileId, await journeyRunIds(ctx));
    }
    if (!row) throw sourceError(NOT_FOUND, 'table_source_not_found');
    if (exceeds(row.size, limits.maxFileBytes)) {
        throw sourceError(`The file is larger than ${Math.round(limits.maxFileBytes / 1048576)} MB, which is the limit for table files.`, 'table_source_too_large');
    }

    let streamed;
    try {
        streamed = await storage().streamFile(row.storageKey);
    } catch {
        // The reaper deletes bytes before rows, so a live row without bytes is a normal race.
        throw sourceError(NOT_FOUND, 'table_source_not_found');
    }
    const buffer = await readCapped(streamed.stream, limits.maxFileBytes);
    return {
        buffer,
        filename: row.filename || 'file',
        mimeType: row.mimeType || streamed.contentType || 'application/octet-stream',
        size: buffer.length,
        kind: appFile ? 'app_file' : /** @type {'form_upload'|'generated_file'} */ (kind),
    };
}

module.exports = { readSourceFile };
