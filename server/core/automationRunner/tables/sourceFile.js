// @typecheck noImplicitAny
/**
 * Turn a source binding into the bytes of a file, for the `read_table` step.
 *
 * The binding is data a definition (or an upstream step) supplied, so nothing in
 * it is trusted beyond the file id:
 *
 *   { kind: 'form_upload',   fileId }  a file a visitor gave a form of THIS automation
 *   { kind: 'generated_file', fileId } a file an earlier step of THIS journey made
 *   { sourceHandle: <either> }         the same, wrapped by a step output
 *
 * The storage key always comes from the ledger row found by that id, never from
 * the descriptor, because a definition can carry a forged key, name or type.
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

/** @typedef {{ sourceHandle?: unknown, kind?: unknown, fileId?: unknown }} SourceDescriptor */

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
 * @param {{ automationId?: string, runId?: string, rootRunId?: string }} ctx
 * @param {{ store?: any, storage?: any, journeyRunIds?: Function, limits?: () => ReturnType<typeof tableLimits> }} [deps]
 * @returns {Promise<{buffer: Buffer, filename: string, mimeType: string, size: number, kind: 'form_upload'|'generated_file'}>}
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
    if (kind !== 'form_upload' && kind !== 'generated_file') {
        if (!kind) throw sourceError('No file is connected to this step. Choose the file to read.', 'table_source_missing');
        throw sourceError('This step can read a file from a form or from an earlier step, not a source of another kind.', 'table_source_unsupported');
    }
    if (!fileId) throw sourceError('No file is connected to this step. Choose the file to read.', 'table_source_missing');

    let row;
    if (kind === 'form_upload') {
        row = await store.getClaimedFormUploadForAutomation(fileId, ctx.automationId);
    } else {
        const journeyRunIds = deps.journeyRunIds || require('../generatedFileHandle').journeyRunIds;
        row = await store.getGeneratedFileForRuns(fileId, await journeyRunIds(ctx));
    }
    if (!row) throw sourceError('The file could not be found. It may have expired or belong to another automation.', 'table_source_not_found');
    if (exceeds(row.size, limits.maxFileBytes)) {
        throw sourceError(`The file is larger than ${Math.round(limits.maxFileBytes / 1048576)} MB, which is the limit for table files.`, 'table_source_too_large');
    }

    let streamed;
    try {
        streamed = await storage().streamFile(row.storageKey);
    } catch {
        // The reaper deletes bytes before rows, so a live row without bytes is a normal race.
        throw sourceError('The file could not be found. It may have expired or belong to another automation.', 'table_source_not_found');
    }
    const buffer = await readCapped(streamed.stream, limits.maxFileBytes);
    return {
        buffer,
        filename: row.filename || 'file',
        mimeType: row.mimeType || streamed.contentType || 'application/octet-stream',
        size: buffer.length,
        kind,
    };
}

module.exports = { readSourceFile };
