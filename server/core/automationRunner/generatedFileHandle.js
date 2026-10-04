/**
 * `generated_file` handles — how a file a document step KEPT gets pushed on.
 *
 * generate_document, fill_document and presentation write into Bee Flow's own
 * storage and record a row in `automation_generated_files`; deliberately no
 * URL, because the only readers are a form page of the same journey and an
 * approval that snapshots it. Their outputs carry a handle instead:
 *
 *     sourceHandle: { kind: 'generated_file', fileId }
 *
 * nextcloud_upload_file and drive_upload_file accept it the way they accept a
 * `gmail_attachment` handle — bytes the tool fetches itself, never bytes the
 * model copied into an argument. This module is the one place the handle is
 * turned into bytes, and it is scoped to the RUN: `getGeneratedFileForRuns`
 * only answers for the journey's run ids, so an automation cannot upload a file
 * another automation produced by guessing an id. Outside a run (a chat) there is
 * no journey, so the handle is refused with a clear message rather than
 * resolved against nothing.
 */

const automationStore = require('../../stores/automationStore');
const { MAX_DOCUMENT_BYTES } = require('./execDocument');
const log = require('../../telemetry/log');

function isGeneratedFileHandle(handle) {
    return !!handle && typeof handle === 'object' && handle.kind === 'generated_file' && typeof handle.fileId === 'string' && handle.fileId.length > 0;
}

/** Every run id of the journey `runScope` belongs to — the ledger's visibility set. */
async function journeyRunIds(runScope) {
    const rootRunId = runScope.rootRunId || runScope.runId;
    const ids = new Set([runScope.runId, rootRunId].filter(Boolean));
    try {
        const chain = await automationStore.getRunsInChain(rootRunId);
        for (const r of chain) if (r && r.id) ids.add(r.id);
    } catch (e) {
        log.warn(`[generatedFileHandle] could not read the run chain for ${rootRunId}: ${e.message}`);
    }
    return [...ids];
}

/**
 * @param {{kind:'generated_file', fileId:string}} handle
 * @param {{runId:string, rootRunId?:string}|null} runScope
 * @returns {Promise<{buffer:Buffer, filename:string, mimeType:string, size:number}|null>}
 *   null when the id is not a live file of this journey (expired, or someone
 *   else's); throws `handle_scope_missing` when there is no run at all.
 */
async function readGeneratedFile(handle, runScope) {
    if (!isGeneratedFileHandle(handle)) return null;
    if (!runScope || !runScope.runId) {
        throw Object.assign(
            new Error('A generated_file handle can only be used inside an automation run — the file belongs to that run.'),
            { errorClass: 'handle_scope_missing' },
        );
    }
    const runIds = await journeyRunIds(runScope);
    const file = await automationStore.getGeneratedFileForRuns(handle.fileId, runIds);
    if (!file) return null;

    const storageStore = require('../../stores/storageStore');
    const { stream, contentType } = await storageStore.streamFile(file.storageKey);
    const chunks = [];
    let total = 0;
    for await (const chunk of stream) {
        total += chunk.length;
        if (total > MAX_DOCUMENT_BYTES) {
            stream.destroy?.();
            throw Object.assign(new Error(`The generated file is larger than ${MAX_DOCUMENT_BYTES / 1048576} MB.`), { errorClass: 'document_too_large' });
        }
        chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    return {
        buffer,
        filename: file.filename || 'document',
        mimeType: file.mimeType || contentType || 'application/octet-stream',
        size: buffer.length,
    };
}

module.exports = { isGeneratedFileHandle, readGeneratedFile, journeyRunIds };
