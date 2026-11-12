// @typecheck strict
/**
 * The step that keeps the original file of a document (core/kb/originals.mts)
 * when the knowledge base opted in and the caller still has the bytes: the
 * refresh engine (`fetched.original`) and the upload routes (the multer buffer).
 *
 * Never throws: the text ingest is what made the document searchable, and a
 * copy that could not be kept (too large, privacy redaction in force, storage
 * down) is a log line, not a failed document.
 */

/**
 * @typedef {{ kb: Record<string, any>, tenantId?: string, docId: string | null | undefined, status?: string,
 *   original: { buffer: Buffer, mime?: string | null, filename?: string | null } | null | undefined,
 *   log: (...a: unknown[]) => void, keepOriginal?: typeof import('../originals.mts').keepOriginal,
 *   deleteOriginal?: typeof import('../originals.mts').deleteOriginal }} KeepArgs
 */

/**
 * @param {KeepArgs} p  `status` is the outcome of the ingest; only an indexed ('processed') document keeps its file
 * @returns {Promise<void>}
 */
async function keepIfEnabled({ kb, tenantId, docId, status, original, log, keepOriginal, deleteOriginal }) {
    if (!docId) return;
    // A document whose text came out redacted keeps no file: an earlier copy would be the unredacted one
    // beside the redacted text (deleteOriginal never throws and does nothing without one).
    if (status === 'redacted') {
        const drop = deleteOriginal || require('../originals.mts').deleteOriginal;
        await drop({ tenantId: tenantId || kb.tenant_id, kbId: kb.id, documentId: docId }).catch((e) => log(`original of ${docId} not removed: ${/** @type {Error} */ (e).message}`));
        return;
    }
    if (!kb.keep_originals || !original) return;
    // Only a document that was indexed: a skipped, failed or duplicate row has no text to go with the file
    // (and a file the privacy policy held back must not be kept through the side door).
    if (status !== 'processed') return;
    try {
        const keep = keepOriginal || require('../originals.mts').keepOriginal;
        const res = await keep({
            tenantId: tenantId || kb.tenant_id, kbId: kb.id, documentId: docId,
            buffer: original.buffer, mime: original.mime || null, filename: original.filename || null,
        });
        if (res && res.kept === false) log(`original of ${docId} not kept (${res.reason})`);
    } catch (e) {
        log(`original of ${docId} not kept: ${/** @type {Error} */ (e).message}`);
    }
}

/**
 * The refresh engine's call: the adapter's `fetched.original`, through the injectable `deps.keepOriginal`.
 * @param {{ kb: Record<string, any>, tenantId: string, docId: string | null | undefined, status?: string,
 *   fetched: import('./index').FetchedDoc, log: (...a: unknown[]) => void, deps: import('./index').SyncDeps }} p
 * @returns {Promise<void>}
 */
function keepFetchedOriginal({ kb, tenantId, docId, status, fetched, log, deps }) {
    const original = fetched.original ? { ...fetched.original, mime: fetched.original.mime || fetched.mime || null, filename: fetched.original.filename || fetched.title || null } : null;
    return keepIfEnabled({ kb, tenantId, docId, status, original, log, keepOriginal: deps.keepOriginal, deleteOriginal: deps.deleteOriginal });
}

/**
 * An upload route's call: the multer file of a request.
 * @param {{ kb: Record<string, any>, docId: string | null | undefined, status?: string,
 *   file: { buffer?: Buffer, mimetype?: string, originalname?: string }, log: (...a: unknown[]) => void }} p
 * @returns {Promise<void>}
 */
function keepUploadedOriginal({ kb, docId, status, file, log }) {
    const original = file.buffer ? { buffer: file.buffer, mime: file.mimetype || null, filename: file.originalname || null } : null;
    return keepIfEnabled({ kb, docId, status, original, log });
}

module.exports = { keepFetchedOriginal, keepUploadedOriginal, keepIfEnabled };
