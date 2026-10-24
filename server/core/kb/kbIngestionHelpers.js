/**
 * KB Ingestion Helpers — shared logic for both Knowledge Base routes
 * and Notebook source ingestion.
 *
 * Extracts common patterns:
 *   • File content extraction (with Azure Doc Intelligence + OCR fallbacks)
 *   • URL fetching → Markdown conversion
 *   • Document ingestion (dedup → search-service chunk+embed)
 *   • Azure embedding param resolution
 *   • Chunk cleanup via search-service
 */

const kbStore = require('../../stores/knowledgeBases');
const { friendlyError } = require('./friendlyError');
const { assertUrlIsPublic, fetchUrlContent, fetchWithPlaywright } = require('./kbUrlFetch');
const { extractFileContentWithMeta, extractFileContent } = require('./kbFileExtract');
const { findDocumentBySourceUri, findDocumentsBySourceUri } = require('./kbDocLookup');
const { simhash64, getAzureIngestParams, byteLength, isLocalIngest, embedDocumentContent } = require('./kbEmbed');
const { purgeDocumentChunks, reingestDocument, deleteDocumentChunks } = require('./kbReingest');
const { fallback } = require('../../utils/bestEffort');

// ── Ingest funnel ───────────────────────────────────────────────────

/**
 * Is a hash/simhash hit a duplicate *within the same source* (refuse, as
 * before) or an overlap *across sources* (annotate, keep going)?
 *
 * No source on either side means the caller (or the matched row) predates the
 * source model; that keeps the historical KB-wide dedup for every legacy call
 * site — the conservative answer is to refuse, never to embed twice.
 */
function isSameSourceScope(existingSourceId, sourceId) {
    if (!sourceId || !existingSourceId) return true;
    return String(existingSourceId) === String(sourceId);
}

/** Exact-hash lookup that tolerates the older store shape (id only). */
async function findActiveByHash(kbId, hash) {
    if (typeof kbStore.findDocumentByContentHash === 'function') {
        return kbStore.findDocumentByContentHash(kbId, hash);
    }
    const id = await kbStore.hasContentHash(kbId, hash);
    return id ? { id, source_id: null } : null;
}

/** Does this instance embed knowledge locally (and so with the configured model)? */
async function usesLocalIngest() {
    const { resolveKbProvider } = require('./resolveProvider');
    return isLocalIngest(await getAzureIngestParams(), await resolveKbProvider());
}

/**
 * Ingest text content into a KB.
 *
 * Handles: deduplication check → document record creation → chunking + embedding.
 *
 * @param {string}  tenantId  — user ID
 * @param {string}  kbId      — knowledge base ID
 * @param {string}  content   — text/markdown content
 * @param {string}  title     — document title
 * @param {string}  sourceType — 'text' | 'web' | 'upload' | 'notebook_source' | …
 * @param {string|null} sourceUri — source identifier (filename, URL, source ID)
 * @param {object}  [options]
 * @param {boolean} [options.skipDedup=false] - skip deduplication check
 * @param {string}  [options.lang='auto']    - language hint
 * @param {object}  [options.metadata]       - rich metadata (sender, threadId, …)
 * @param {number}  [options.simhashDistance=3]
 * @param {string}  [options.sourceId]       - kb_sources.id the document belongs to
 * @param {string}  [options.externalId]     - id in the external system (NC fileid, row id, URL, …)
 * @param {Date|string} [options.sourceModifiedAt]
 * @param {number}  [options.sizeBytes]      - defaults to the UTF-8 size of `content`
 * @param {string}  [options.mime]
 * @param {number}  [options.pageCount]
 * @param {number}  [options.sheetCount]
 * @param {string}  [options.createdBy]      - user id (null for engine-driven ingests)
 * @param {'processed'|'redacted'} [options.status='processed'] - K4 passes 'redacted'
 * @param {string}  [options.piiStatus]      - 'none'|'found'|'redacted'|'unscanned'
 * @param {object}  [options.piiCategories]
 * @param {string}  [options.extractSummary]
 * @param {'throw'|'record'} [options.onFailure='throw'] - 'record' keeps a
 *   documents row with status 'skipped' | 'error' | 'duplicate' (+ status_reason)
 *   and RESOLVES with { document, chunks:0, status, error } instead of throwing,
 *   so a source refresh can keep going and the UI can show "36 of 38 processed".
 *
 * Duplicates: an exact or near match INSIDE the same source is refused as
 * before (DUPLICATE / NEAR_DUPLICATE, alias row recorded with status
 * 'duplicate'); a match in ANOTHER source is annotated on the new row
 * (overlaps_document_id) and ingested anyway — K4 shows "overlaps with …".
 *
 * @returns {Promise<{document: object, chunks: number, status: string, overlapsDocumentId?: string|null, duplicateOf?: string, error?: string}>}
 */
async function ingestDocument(tenantId, kbId, content, title, sourceType, sourceUri, options = {}) {
    const {
        skipDedup = false, lang = 'auto', metadata = null, simhashDistance = 3,
        sourceId = null, externalId = null, sourceModifiedAt = null, sizeBytes = null, mime = null,
        pageCount = null, sheetCount = null, createdBy = null,
        /**
         * The extractor's `pages[]`, when it produced any (PDFs, mostly).
         *
         * Its own option rather than a field on `privacy`: a document's pages
         * are a property of the DOCUMENT. The Privacy Shield happens to want
         * them too, and reading one feature's option bag for another feature's
         * data is how a shield that gets turned off takes page numbers with it.
         */
        pages = null,
        status: requestedStatus = 'processed', piiStatus, piiCategories, extractSummary,
        onFailure = 'throw',
        /**
         * Privacy Shield at ingest (K4). `{ orgId, userId, pages? }` runs the
         * text through `core/kb/ingestPrivacy` BEFORE it is hashed; `null`
         * opts out.
         *
         * Opt-IN rather than opt-out on purpose. The notebook and webpage
         * source ingests already scan with their own policy and deliberately
         * keep the real text, and silently redacting underneath them would
         * change what those features store without anybody asking for it.
         */
        privacy = null,
    } = options;
    const record = onFailure === 'record';
    // `let`: the privacy screen below may turn a 'processed' ingest into a
    // 'redacted' one, and this is derived before that runs.
    let okStatus = requestedStatus === 'redacted' ? 'redacted' : 'processed';
    const extra = {
        sourceId, externalId, sourceModifiedAt, mime, pageCount, sheetCount, createdBy,
        piiStatus, piiCategories, extractSummary,
        sizeBytes: sizeBytes != null ? sizeBytes : byteLength(content),
    };

    if (!content || content.trim().length < 3) {
        const err = new Error('Content is too short (min 3 chars)');
        if (record) {
            const doc = await kbStore.createDocument(tenantId, kbId, title, sourceType, sourceUri, null, 0, metadata, null, {
                ...extra, status: 'skipped', statusReason: friendlyError(err),
            });
            return { document: doc, chunks: 0, status: 'skipped', error: err.message };
        }
        throw err;
    }

    /**
     * ── PRIVACY BEFORE THE HASH ─────────────────────────────────────
     * The order matters and is not interchangeable. Dedup is a hash of the
     * content, and what gets STORED is the redacted text — so hashing first
     * would fingerprint text that is never written anywhere, and the same
     * file uploaded twice would produce two rows with one hash and two
     * different bodies. Screening first makes the fingerprint describe the
     * thing it is a fingerprint OF.
     *
     * A `block` decision returns here: the row is kept with its reason and no
     * content, which is what makes a held document visible instead of a file
     * that silently never arrived.
     */
    let piiStatusOut = piiStatus;
    let piiCategoriesOut = piiCategories;
    if (privacy && privacy.orgId !== undefined) {
        const { applyShield, OUTCOME } = require('./ingestPrivacy');
        const verdict = await applyShield({
            orgId: privacy.orgId || null,
            userId: privacy.userId || null,
            text: content,
            filename: title,
            pages: privacy.pages || null,
        });
        piiStatusOut = verdict.piiStatus;
        piiCategoriesOut = verdict.piiCategories;
        if (verdict.outcome === OUTCOME.SKIPPED) {
            const doc = await kbStore.createDocument(tenantId, kbId, title, sourceType, sourceUri, null, 0, metadata, null, {
                ...extra, piiStatus: piiStatusOut, piiCategories: piiCategoriesOut,
                status: 'skipped', statusReason: verdict.reason,
            });
            return { document: doc, chunks: 0, status: 'skipped', error: verdict.reason };
        }
        // From here on, `content` IS the text that will be hashed, chunked,
        // embedded and stored. There is no copy of the original.
        content = verdict.text;
        extra.sizeBytes = sizeBytes != null ? sizeBytes : byteLength(content);
        if (verdict.outcome === OUTCOME.REDACTED) okStatus = 'redacted';
    }
    extra.piiStatus = piiStatusOut;
    extra.piiCategories = piiCategoriesOut;

    const hash = kbStore.hashContent(content);
    let overlapsDocumentId = null;

    // ── Exact-hash dedup ──
    if (!skipDedup) {
        const existing = await findActiveByHash(kbId, hash);
        if (existing) {
            if (isSameSourceScope(existing.source_id, sourceId)) {
                // Record the alias (duplicate_of pointer) so the UI shows the
                // attempt, but do NOT re-embed — the canonical doc's chunks cover it.
                let dupRow = null;
                try {
                    if (kbStore.recordDuplicate) {
                        dupRow = await kbStore.recordDuplicate(tenantId, kbId, title, sourceType, sourceUri, hash, existing.id, metadata, {
                            ...extra, statusReason: 'Identical content already in this knowledge base',
                        });
                    }
                } catch (err) { fallback('core/kb/kbIngestionHelpers:ingestDocument', err); /* non-fatal */ }
                if (record) return { document: dupRow, chunks: 0, status: 'duplicate', duplicateOf: existing.id };
                throw Object.assign(new Error('Duplicate content already exists in this KB'), {
                    code: 'DUPLICATE', documentId: existing.id
                });
            }
            overlapsDocumentId = existing.id;
        }
    }

    // ── SimHash near-duplicate probe (e.g. newsletters with tiny variations) ──
    // Skip in skipDedup mode (category_merge re-ingests deliberately) and when
    // the exact match already told us the answer.
    const simhash = simhash64(content);
    if (!skipDedup && !overlapsDocumentId && simhash != null && kbStore.findNearDuplicateBySimhash) {
        let near = null;
        try { near = await kbStore.findNearDuplicateBySimhash(kbId, simhash, simhashDistance); }
        catch (_) { near = null; /* simhash failure shouldn't block ingestion */ }
        if (near) {
            if (isSameSourceScope(near.source_id, sourceId)) {
                let dupRow = null;
                try {
                    if (kbStore.recordDuplicate) {
                        dupRow = await kbStore.recordDuplicate(tenantId, kbId, title, sourceType, sourceUri, hash, near.id, metadata, {
                            ...extra, statusReason: 'Near-identical content already in this knowledge base',
                        });
                    }
                } catch (err) { fallback('core/kb/kbIngestionHelpers:ingestDocument#2', err); /* non-fatal */ }
                if (record) return { document: dupRow, chunks: 0, status: 'duplicate', duplicateOf: near.id };
                throw Object.assign(new Error('Near-duplicate content already in KB'), {
                    code: 'NEAR_DUPLICATE', documentId: near.id
                });
            }
            overlapsDocumentId = near.id;
        }
    }

    // Create document record (with rich metadata + simhash + provenance)
    const doc = await kbStore.createDocument(
        tenantId, kbId, title, sourceType, sourceUri, hash, 0, metadata, simhash,
        { ...extra, overlapsDocumentId, status: okStatus }
    );

    // Send for chunking + embedding
    let chunks = 0;
    try {
        chunks = await embedDocumentContent(tenantId, kbId, doc.id, content, { title, sourceUri, lang, pages });
    } catch (embedErr) {
        if (record) {
            let errDoc = null;
            try {
                errDoc = await kbStore.updateDocumentStatus(doc.id, { status: 'error', statusReason: friendlyError(embedErr), chunkCount: 0 });
            } catch (err) { fallback('core/kb/kbIngestionHelpers:ingestDocument#3', err); /* best-effort */ }
            return { document: errDoc || { ...doc, status: 'error' }, chunks: 0, status: 'error', error: embedErr.message };
        }
        // Legacy contract: no row survives a failed ingest. The row never held
        // content, so there is nothing worth snapshotting.
        await kbStore.deleteDocument(doc.id, { skipSnapshot: true });
        throw embedErr;
    }

    await kbStore.updateChunkCount(doc.id, chunks);
    await kbStore.bumpKBVersion(kbId);

    return {
        document: { ...doc, chunk_count: chunks },
        chunks,
        status: okStatus,
        overlapsDocumentId,
    };
}

/**
 * Record an ingest that never reached ingestDocument (extraction failed,
 * unsupported type, blocked by the shield) as a documents row with status
 * 'skipped' | 'error', so the source shows the file and why it is missing.
 * Never throws on a bad reason; the row is the point.
 *
 * @param {object} p — { tenantId, kbId, title, sourceType, sourceUri, status='error',
 *   error (Error|string) | reason, sourceId, externalId, sizeBytes, mime, createdBy, metadata }
 */
async function recordFailedDocument({ tenantId, kbId, title, sourceType, sourceUri = null, status = 'error', error = null, reason = null, metadata = null, ...extra } = {}) {
    const st = status === 'skipped' ? 'skipped' : 'error';
    const statusReason = reason ? String(reason) : friendlyError(error || 'Processing failed');
    return kbStore.createDocument(tenantId, kbId, title, sourceType, sourceUri, null, 0, metadata, null, {
        ...extra, status: st, statusReason,
    });
}

module.exports = {
    getAzureIngestParams,
    usesLocalIngest,
    extractFileContent,
    extractFileContentWithMeta,
    fetchUrlContent,
    fetchWithPlaywright,
    ingestDocument,
    reingestDocument,
    recordFailedDocument,
    purgeDocumentChunks,
    deleteDocumentChunks,
    findDocumentBySourceUri,
    findDocumentsBySourceUri,
    simhash64,
    assertUrlIsPublic,
    friendlyError,
};
