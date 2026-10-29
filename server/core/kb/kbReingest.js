const kbStore = require('../../stores/knowledgeBases');
const { getServiceHeaders } = require('../serviceAuth');
const { friendlyError } = require('./friendlyError');
const log = require('../../telemetry/log');
const { SEARCH_SERVICE_URL, simhash64, byteLength, embedDocumentContent } = require('./kbEmbed');
const { fallback, bestEffort } = require('../../utils/bestEffort');
const { isMissingTable } = require('../../utils/isMissingTable');

/**
 * Remove a document's chunks (local kb_chunks + remote search service) WITHOUT
 * touching the documents row. Refresh-in-place and source-driven cleanups use
 * this; deleteDocumentChunks below adds the row deletion.
 *
 * ── `strict` TURNS "ATTEMPTED" INTO "SUCCEEDED" ───────────────────
 * Without `strict` the answer of the search service was never read: a 500, a 404 or a time-out came
 * past as a `console.warn` and the caller went cheerfully on with removing the document row. For a
 * re-index that is defensible (the chunks are replaced right afterwards anyway), but for a DELETION
 * it is precisely the bug that this whole path wants to prevent: text gone from the screen, embeddings
 * still searchable. `deleteDocumentChunks` therefore sets `strict: true`: then a non-ok answer throws,
 * and that error lands in `errors` of purgeSourceDocuments, which yields `complete: false` and leaves
 * the source row in place.
 *
 * @param {{ strict?: boolean, deleteLocal?: typeof import('./localKBIngest').deleteChunksLocally }} [opts]  `strict`
 *   (default false): throw if the remote cleanup is not demonstrably done, instead of warning;
 *   `deleteLocal` a test seam for localKBIngest.deleteChunksLocally
 * @param {string} kbId
 * @param {string} docId
 * @param {string} tenantId
 */
async function purgeDocumentChunks(kbId, docId, tenantId, { strict = false, deleteLocal } = {}) {
    // Clean up local kb_chunks (for Azure-path ingested docs)
    try {
        await (deleteLocal || require('./localKBIngest').deleteChunksLocally)(tenantId, kbId, docId);
    } catch (err) {
        if (!isMissingTable(err)) {
            if (strict) throw new Error(`local chunk cleanup failed for document ${docId}: ${/** @type {Error} */ (err).message}`);
            bestEffort('kb/kbReingest:localChunks', err);
        }
    }

    // Also clean up via remote search-service (skip when admin chose local-only)
    try {
        const { resolveKbProvider } = require('./resolveProvider');
        const kbProvider = await resolveKbProvider();
        if (kbProvider !== 'local') {
            // DELETE /kb/documents/{id} — the only chunk-removal route the
            // search-service has (search-service/app/routers/ingest.py), and
            // the one the Node shim in routes/search.js now mirrors. The
            // previous path (/kb/{kb}/documents/{doc}/chunks) existed on
            // neither, so remote chunks were never actually deleted.
            const qs = `tenant_id=${encodeURIComponent(tenantId)}&knowledge_base_id=${encodeURIComponent(kbId)}`;
            const res = await fetch(`${SEARCH_SERVICE_URL}/kb/documents/${encodeURIComponent(docId)}?${qs}`, {
                method: 'DELETE',
                headers: getServiceHeaders(),
                signal: AbortSignal.timeout(10000)
            });
            // A 404 here means "it is no longer there", and so it is done; anything above that
            // is a failed cleanup. `res` may be missing with an old fetch double. Then nothing is
            // demonstrable, and that narrows in strict mode.
            if (res && res.ok === false && res.status !== 404) {
                throw new Error(`search-service returned ${res.status}`);
            }
            if (strict && (!res || typeof res.ok !== 'boolean')) {
                throw new Error('search-service gave no readable answer');
            }
        }
    } catch (e) {
        if (strict) throw new Error(`chunk cleanup failed for document ${docId}: ${/** @type {Error} */ (e).message}`);
        log.warn('[KBHelpers] Search-service chunk cleanup failed:', /** @type {Error} */ (e).message);
    }
}

/**
 * The documents of a base a Solution stage carries change by deploy only (managed_part otherwise).
 * @param {string} kbId
 * @param {{ deploymentId?: string; } | null} managedWrite
 */
async function assertKbDocumentsWrite(kbId, managedWrite) {
    if (typeof kbStore.assertKbWrite !== 'function') return;
    await kbStore.assertKbWrite(kbId, ['documents'], managedWrite, { carryOnly: true });
}

/**
 * Refresh-in-place: re-chunk + re-embed `content` for an EXISTING documents
 * row. The row — and therefore documents.id, citations and the version
 * history — is kept; only the chunks and the fingerprint/bookkeeping columns
 * change. No kb_document_versions snapshot is written: the source of truth
 * for a source-driven document is the external system, not the audit table.
 *
 * "Process again" on a skipped/error row is the same call: it turns the row
 * into a processed one under the same id.
 *
 * @param {string} tenantId
 * @param {string} kbId
 * @param {string} docId
 * @param {string} content
 * @param {NonNullable<Parameters<typeof import('./kbIngestionHelpers').ingestDocument>[6]> & { title?: string,
 *   managedWrite?: { deploymentId?: string } | null }} [options] - the keys of ingestDocument's options
 *   (lang, metadata, externalId, …, onFailure), the title, and a deployment's write capability
 * @returns {Promise<{document: object, chunks: number, status: string, error?: string}>}
 */
async function reingestDocument(tenantId, kbId, docId, content, options = {}) {
    const {
        title, lang = 'auto', metadata, externalId, sourceModifiedAt, sizeBytes, mime, pageCount, sheetCount,
        status: requestedStatus = 'processed', piiStatus, piiCategories, extractSummary, onFailure = 'throw',
        // The extractor's pages, so a re-ingest stamps page numbers the same
        // way a first ingest does. A refresh is how an already-ingested source
        // GAINS pages it never had.
        pages = null,
        // A deployment's capability to write into a carried stage knowledge base.
        managedWrite = null,
    } = options;
    const record = onFailure === 'record';
    const okStatus = requestedStatus === 'redacted' ? 'redacted' : 'processed';

    const existing = await kbStore.getDocument(docId);
    if (!existing) throw Object.assign(new Error('Document not found'), { code: 'NOT_FOUND' });
    if (String(existing.knowledge_base_id) !== String(kbId)) {
        throw Object.assign(new Error('Document belongs to another knowledge base'), { code: 'KB_MISMATCH' });
    }
    // Before any chunk is purged: a carried stage base takes documents by deploy only.
    await assertKbDocumentsWrite(kbId, managedWrite);
    const docTitle = title || existing.title;
    const sourceUri = existing.source_uri || null;

    if (!content || content.trim().length < 3) {
        const err = new Error('Content is too short (min 3 chars)');
        if (record) {
            await purgeDocumentChunks(kbId, docId, tenantId);
            const doc = await kbStore.replaceDocumentContent(docId, {
                title: docTitle, chunkCount: 0, status: 'skipped', statusReason: friendlyError(err), managedWrite,
                externalId, sourceModifiedAt, sizeBytes, mime, pageCount, sheetCount,
            });
            await kbStore.bumpKBVersion(kbId);
            return { document: doc, chunks: 0, status: 'skipped', error: err.message };
        }
        throw err;
    }

    const hash = kbStore.hashContent(content);
    const simhash = simhash64(content);

    // Old chunks go first: ingestLocally replaces per document inside its own
    // transaction, but the search-service path appends.
    await purgeDocumentChunks(kbId, docId, tenantId);

    let chunks = 0;
    try {
        chunks = await embedDocumentContent(tenantId, kbId, docId, content, { title: docTitle, sourceUri, lang, pages });
    } catch (embedErr) {
        if (record) {
            let errDoc = null;
            try {
                errDoc = await kbStore.replaceDocumentContent(docId, {
                    title: docTitle, chunkCount: 0, status: 'error', statusReason: friendlyError(embedErr), managedWrite,
                    externalId, sourceModifiedAt, sizeBytes, mime, pageCount, sheetCount,
                });
            } catch (err) { fallback('core/kb/kbReingest:reingestDocument', err); /* best-effort */ }
            await kbStore.bumpKBVersion(kbId);
            return { document: errDoc || { ...existing, status: 'error', chunk_count: 0 }, chunks: 0, status: 'error', error: /** @type {Error} */ (embedErr).message };
        }
        // Row stays (it is the caller's row), but its chunks are gone: say so.
        try { await kbStore.updateDocumentStatus(docId, { status: 'error', statusReason: friendlyError(embedErr), chunkCount: 0 }); } catch (err) { bestEffort('core/kb/kbReingest:reingestDocument#2', err); /* best-effort */ }
        throw embedErr;
    }

    const doc = await kbStore.replaceDocumentContent(docId, {
        managedWrite,
        title: docTitle,
        contentHash: hash,
        simhash,
        chunkCount: chunks,
        sizeBytes: sizeBytes != null ? sizeBytes : byteLength(content),
        pageCount, sheetCount, mime, sourceModifiedAt, externalId,
        status: okStatus,
        statusReason: null,
        // It has chunks of its own now; it is nobody's alias any more. A row
        // once marked duplicate (a table row the text filter mistook for its
        // neighbour) comes back through here when the source is re-read.
        duplicateOf: null,
        extractSummary, piiStatus, piiCategories,
        metadata,
    });
    await kbStore.bumpKBVersion(kbId);
    return { document: doc, chunks, status: okStatus };
}

/**
 * Delete a document's chunks from the search-service, then remove
 * the document record from the DB.
 *
 * @param {string} kbId     — knowledge base ID
 * @param {string} docId    — document ID
 * @param {string} tenantId — user ID
 * @param {{ skipSnapshot?: boolean, managedWrite?: { deploymentId?: string } | null }} [opts]  `skipSnapshot`:
 *   skip the kb_document_versions snapshot.
 *   Pass true when the caller has already snapshotted (route handlers do, to
 *   carry the user id) AND for every SOURCE-DRIVEN removal (a file vanished
 *   from the folder, a row from the table, a page from the crawl, a re-index):
 *   there the external system is the source of truth, and a snapshot per
 *   refresh would fill an audit table that has no erasure path. Default
 *   false — a human deleting a document through the API still gets the
 *   recovery snapshot.
 */
async function deleteDocumentChunks(kbId, docId, tenantId, { skipSnapshot = false, managedWrite = null } = {}) {
    // Refused BEFORE the chunks are purged: the store guard on deleteDocument
    // alone would run after the embeddings are already gone.
    await assertKbDocumentsWrite(kbId, managedWrite);
    // strict: this is the deletion, not a re-index. If the remote cleanup fails, the
    // document row must NOT fall away, otherwise the embeddings stay searchable without there
    // being a row left to point them out.
    await purgeDocumentChunks(kbId, docId, tenantId, { strict: true });
    await kbStore.deleteDocument(docId, { skipSnapshot, managedWrite });
    await kbStore.bumpKBVersion(kbId);
}

module.exports = { purgeDocumentChunks, reingestDocument, deleteDocumentChunks };
