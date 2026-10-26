// @typecheck
/**
 * Local KB ingestion — chunk, embed, store in PostgreSQL `kb_chunks` — and
 * the maintenance around it (delete, read back, orphan purge, cost logging).
 */

const { getClient } = require('../../db');
const log = require('../../telemetry/log');
const { chunkText, estimateTokens } = require('./chunking');
const { ensureKBChunksTable, isPgvectorAvailable } = require('./kbChunksSchema');
const { trackEmbeddingTokens, trackEmbeddingCost } = require('./embeddingCost');
const { isMissingTable } = require('../../utils/isMissingTable');

// Collaborators that sit in the server's large import cycle are handed in by
// the barrel (localKBIngest.js) through wire(), so this module imports none of
// them itself and the cycle does not grow (lint:scc-ratchet). Lazy ones stay
// lazy: the barrel passes a loader, called where the require used to be.
// dispatchEmbedTexts is the shared Azure-aware embedding chain (provider →
// legacy Azure → CPU) from core/embed/dispatch.
let dispatchEmbedTexts = null;
let loadEmbeddingMigration = null;
function wire(deps) {
    ({ dispatchEmbedTexts, loadEmbeddingMigration } = deps);
}

// ── Embedding dispatch ──────────────────────────────────────────────
// `dispatchEmbedTexts` (provider → legacy Azure → CPU) and `azureEmbed` now
// live in ./embed/dispatch and are imported at the top of this file so the
// node-search pipeline can share the exact same Azure-aware chain.

// ── Main ingestion function ─────────────────────────────────────────

/**
 * Ingest content locally — chunk, embed via Azure, store in PostgreSQL.
 *
 * @param {string} tenantId — user ID
 * @param {string} kbId — knowledge base ID
 * @param {string} docId — document ID
 * @param {string} content — text content to ingest
 * @param {object} options
 * @param {string} [options.title]
 * @param {string} [options.sourceUri]
 * @param {string} [options.lang='auto']
 * @param {Array}  [options.pages]  the extractor's pages, when it produced any.
 *   Present, each chunk gets the page its text starts on and a citation can say
 *   "p. 12". Absent — a plain-text source, a web page, anything ingested before
 *   this existed — the chunks carry no page and the chip says less. Never a
 *   guess: a wrong page is misinformation somebody may act on, where a missing
 *   one is visibly less information.
 * @returns {Promise<{chunks_created: number}>}
 */
async function ingestLocally(tenantId, kbId, docId, content, options = {}) {
    const { title = '', sourceUri = '', lang = 'auto', pages = null } = options;

    // 1. Chunk first so we know how many texts we're embedding
    const chunks = chunkText(content);
    if (chunks.length === 0) {
        throw new Error('Document produced no chunks');
    }
    // Stamp the page each chunk starts on, when the extractor gave us pages.
    // Best-effort by construction (see stampChunkPages): a chunk that cannot
    // be located gets no page rather than a guessed one.
    if (Array.isArray(pages) && pages.length > 0) {
        try {
            require('../documents/pageOffsets').stampChunkPages(chunks, pages);
        } catch (e) {
            log.warn(`[LocalKBIngest] Page stamping skipped: ${/** @type {Error} */ (e).message}`);
        }
    }
    log.info(`[LocalKBIngest] Chunked into ${chunks.length} pieces`);

    // 2. Embed via dispatcher (configured provider → Azure legacy → CPU)
    const chunkTexts = chunks.map(c => c.text);
    let embeddings = [];
    let embedDim = 1536; // fallback if pgvector is disabled — irrelevant in that case
    let embedSource = 'none';

    // Bootstrap pgvector availability flag without committing to a dim yet —
    // we set the dim below once the dispatcher tells us what the configured
    // provider actually produces.
    await ensureKBChunksTable();

    if (isPgvectorAvailable()) {
        // A changed embedding model re-embeds what is stored first, so this
        // document lands in a column of the right dimension instead of
        // failing on it (and paying for vectors that cannot be stored).
        await loadEmbeddingMigration().ensureKbEmbeddingsCurrent({ reason: 'ingest' });
        const result = await dispatchEmbedTexts(chunkTexts);
        embeddings = result.vectors;
        embedSource = result.source || 'none';
        if (embeddings.length > 0 && embeddings[0]?.length) {
            embedDim = embeddings[0].length;
            // Reconcile the kb_chunks embedding column with the actual dim.
            const reconcile = await ensureKBChunksTable(embedDim);
            if (reconcile?.mismatch) {
                // pgvector would refuse the INSERT with "expected 1536
                // dimensions, not 384", which names the symptom and hides the
                // cause: the configured provider failed and a fallback
                // embedder answered instead.
                const cause = result.providerError
                    ? `The embedding provider failed (${result.providerError})`
                    : 'The configured embedding model did not answer';
                throw new Error(`${cause}; the fallback embedder's ${reconcile.mismatch.vectorDim}-dimension vectors cannot be stored next to the existing ${reconcile.mismatch.currentDim}-dimension ones. Try again later.`);
            }
            // Track cost only when we actually used a paid provider/Azure path.
            if (embedSource === 'provider' || embedSource === 'azure') {
                const totalTokens = chunkTexts.reduce((sum, t) => sum + estimateTokens(t), 0);
                trackEmbeddingTokens(totalTokens);
            }
        } else {
            log.warn('[LocalKBIngest] No embeddings produced — falling back to keyword search only for this doc.');
        }
    } else {
        log.info('[LocalKBIngest] Skipping embedding generation (pgvector disabled)');
    }

    // 3. Store in PostgreSQL
    const client = await getClient();
    try {
        await client.query('BEGIN');

        // Delete old chunks for this document (re-ingestion)
        await client.query(
            'DELETE FROM kb_chunks WHERE tenant_id = $1 AND knowledge_base_id = $2 AND document_id = $3',
            [tenantId, kbId, docId]
        );

        // Issue #11: Store original content in documents table for faster reindexing
        // (avoids needing to reconstruct content from chunks)
        try {
            await client.query(
                `UPDATE documents SET original_content = $1 WHERE id = $2::uuid`,
                [content, docId]
            );
        } catch (err) { if (!isMissingTable(err)) throw err; log.debug('Column may not exist yet — ignore, migration handles it', err); }

        // Issue #9: Batch INSERT — 10 chunks per statement to reduce round-trips
        const BATCH_SIZE = 10;
        for (let batchStart = 0; batchStart < chunks.length; batchStart += BATCH_SIZE) {
            const batch = chunks.slice(batchStart, batchStart + BATCH_SIZE);
            const hasVectors = isPgvectorAvailable() && embeddings.length > 0;

            /** @type {string[]} */
            const values = [];
            /** @type {(string | number | null | undefined)[]} */
            const params = [];
            let paramIdx = 1;

            for (let j = 0; j < batch.length; j++) {
                const i = batchStart + j;
                const chunk = /** @type {(typeof batch)[number] & { page_start?: number|null }} */ (batch[j]);
                const chunkType = chunk.chunk_type || 'content';
                // null when the extractor gave no pages, or when this chunk
                // could not be located in them. The column is nullable for
                // exactly that: most of what is already ingested has no page.
                const pageStart = Number.isInteger(chunk.page_start) ? chunk.page_start : null;

                if (hasVectors && embeddings[i]) {
                    const vectorStr = `[${embeddings[i].join(',')}]`;
                    values.push(`($${paramIdx}, $${paramIdx+1}, $${paramIdx+2}, $${paramIdx+3}, $${paramIdx+4}, $${paramIdx+5}, $${paramIdx+6}, setweight(to_tsvector('dutch', $${paramIdx+6}), 'A') || setweight(to_tsvector('simple', $${paramIdx+6}), 'B'), $${paramIdx+7}::vector, $${paramIdx+8}, $${paramIdx+9}, $${paramIdx+10})`);
                    params.push(tenantId, kbId, docId, chunk.chunk_id, lang, title, chunk.text, vectorStr, sourceUri, chunkType, pageStart);
                    paramIdx += 11;
                } else {
                    values.push(`($${paramIdx}, $${paramIdx+1}, $${paramIdx+2}, $${paramIdx+3}, $${paramIdx+4}, $${paramIdx+5}, $${paramIdx+6}, setweight(to_tsvector('dutch', $${paramIdx+6}), 'A') || setweight(to_tsvector('simple', $${paramIdx+6}), 'B'), NULL, $${paramIdx+7}, $${paramIdx+8}, $${paramIdx+9})`);
                    params.push(tenantId, kbId, docId, chunk.chunk_id, lang, title, chunk.text, sourceUri, chunkType, pageStart);
                    paramIdx += 10;
                }
            }

            await client.query(
                `INSERT INTO kb_chunks (
                    tenant_id, knowledge_base_id, document_id,
                    chunk_id, lang, title, content, tsv, embedding, source_uri, chunk_type, page_start
                ) VALUES ${values.join(', ')}`,
                params
            );
        }

        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }

    log.info(`[LocalKBIngest] Stored ${chunks.length} chunks in PostgreSQL (batched)`);
    return { chunks_created: chunks.length };
}

/**
 * Delete chunks for a document locally (or all chunks for a KB if docId is omitted).
 */
async function deleteChunksLocally(tenantId, kbId, docId) {
    await ensureKBChunksTable();

    const client = await getClient();
    try {
        if (docId) {
            await client.query(
                'DELETE FROM kb_chunks WHERE tenant_id = $1 AND knowledge_base_id = $2 AND document_id = $3',
                [tenantId, kbId, docId]
            );
        } else {
            await client.query(
                'DELETE FROM kb_chunks WHERE tenant_id = $1 AND knowledge_base_id = $2',
                [tenantId, kbId]
            );
        }
    } finally {
        client.release();
    }
}

/**
 * Retrieve concatenated chunk content for a document from kb_chunks.
 * Used by the re-index endpoint to recover existing content when Azure mode is active.
 *
 * @param {string} tenantId
 * @param {string} kbId
 * @param {string} docId
 * @returns {Promise<string>} concatenated content
 */
async function getDocumentContent(tenantId, kbId, docId) {
    const pool = require('../../db').pool;
    const client = await pool.connect();
    try {
        const { rows } = await client.query(
            `SELECT content FROM kb_chunks
             WHERE tenant_id = $1 AND knowledge_base_id = $2 AND document_id = $3
             ORDER BY chunk_id ASC`,
            [tenantId, kbId, docId]
        );
        return rows.map(r => r.content).join('\n\n');
    } finally {
        client.release();
    }
}

/**
 * Purge orphaned chunks — rows in kb_chunks whose document_id
 * no longer exists in the documents table.
 *
 * This handles the case where a document was deleted but its chunks
 * weren't cleaned up (e.g. due to a partial failure or race condition).
 *
 * @returns {Promise<number>} number of orphaned rows deleted
 */
async function purgeOrphanedChunks() {
    try {
        await ensureKBChunksTable();
        const client = await getClient();
        try {
            const result = await client.query(
                `DELETE FROM kb_chunks c
                 WHERE NOT EXISTS (
                     SELECT 1 FROM documents d WHERE LOWER(d.id::text) = LOWER(c.document_id)
                 )`
            );
            const deleted = result.rowCount || 0;
            if (deleted > 0) {
                log.info(`[LocalKBIngest] Purged ${deleted} orphaned chunks from kb_chunks`);
            }
            return deleted;
        } finally {
            client.release();
        }
    } catch (err) {
        log.warn('[LocalKBIngest] Orphan purge failed:', /** @type {Error} */ (err).message);
        return 0;
    }
}

module.exports = { trackEmbeddingCost, ingestLocally, deleteChunksLocally, getDocumentContent, purgeOrphanedChunks, wire };
