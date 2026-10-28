// @typecheck
/**
 * stores/kb/documentQueries.js — document reads: near-duplicate and
 * content-hash lookups, by source + external id, per-source and per-base
 * counters, the projected listings and thread explorer, one document, its
 * stored text. Split out of stores/knowledgeBases.js.
 */

const { UUID_RE, ACTIVE_STATUS_SQL, DOC_SELECT, buildDocumentFilters } = require('./model');

/**
 * @param {import('./model').KbCtx} ctx  the barrel's db handle, schema init,
 *        write guard and the store object itself (methods dispatch through it,
 *        so a method swapped on the export is the one the others call)
 */
function makeDocumentQueryFns(ctx) {
    const { getOne, getAll, initDB, self: KnowledgeBasesStore } = ctx;
    return {
        /**
         * Find a near-duplicate by simhash within a given Hamming distance among
         * ACTIVE documents (a skipped/failed/duplicate row is never a canonical).
         * Returns { id, title, simhash, source_id } or null. `distance` defaults to 3.
         */
        findNearDuplicateBySimhash: async (kbId, simhash, distance = 3) => {
            await initDB();
            if (simhash == null) return null;
            // Count set bits in the XOR to compute Hamming distance.
            return getOne(
                `SELECT id, title, simhash, source_id FROM documents
             WHERE knowledge_base_id = $1
               AND ${ACTIVE_STATUS_SQL}
               AND simhash IS NOT NULL
               AND length(replace((($2::bigint # simhash)::bit(64))::text, '0', '')) <= $3
             ORDER BY created_at DESC
             LIMIT 1`,
                [kbId, simhash, distance]
            );
        },


        /**
         * Documents of a source keyed by the external system's id (Nextcloud
         * fileid, datatable row id, transcription id, URL). Duplicate alias rows
         * are excluded — they share the canonical row's external id.
         */
        findDocumentsBySourceExternalId: async (sourceId, externalId) => {
            await initDB();
            if (!sourceId || externalId == null) return [];
            return getAll(
                `SELECT ${DOC_SELECT} FROM documents
             WHERE source_id = $1 AND external_id = $2 AND status <> 'duplicate'
             ORDER BY created_at DESC`,
                [sourceId, String(externalId)]
            );
        },

        findDocumentBySourceExternalId: async (sourceId, externalId) => {
            const rows = await KnowledgeBasesStore.findDocumentsBySourceExternalId(sourceId, externalId);
            return rows[0] || null;
        },

        /**
         * Per-source status counters for the Sources tab:
         * { [sourceId]: { documentCount, processedCount, redactedCount, skippedCount, errorCount, duplicateCount, piiFoundCount } }
         * `documentCount` counts every row (the "38 files" half of "38 files · 36 processed").
         */
        countsBySource: async (sourceIds) => {
            await initDB();
            const ids = Array.from(new Set((sourceIds || []).filter(Boolean)));
            const out = {};
            if (ids.length === 0) return out;
            const rows = await getAll(
                `SELECT source_id,
                    COUNT(*)::int AS document_count,
                    COUNT(*) FILTER (WHERE status = 'processed')::int AS processed_count,
                    COUNT(*) FILTER (WHERE status = 'redacted')::int AS redacted_count,
                    COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped_count,
                    COUNT(*) FILTER (WHERE status = 'error')::int AS error_count,
                    COUNT(*) FILTER (WHERE status = 'duplicate')::int AS duplicate_count,
                    COUNT(*) FILTER (WHERE pii_status IN ('found','redacted'))::int AS pii_found_count,
                    COALESCE(SUM(chunk_count) FILTER (WHERE ${ACTIVE_STATUS_SQL}), 0)::int AS total_chunks
               FROM documents
              WHERE source_id = ANY($1::uuid[])
              GROUP BY source_id`,
                [ids]
            );
            for (const r of rows || []) {
                out[r.source_id] = {
                    documentCount: Number(r.document_count) || 0,
                    processedCount: Number(r.processed_count) || 0,
                    redactedCount: Number(r.redacted_count) || 0,
                    skippedCount: Number(r.skipped_count) || 0,
                    errorCount: Number(r.error_count) || 0,
                    duplicateCount: Number(r.duplicate_count) || 0,
                    piiFoundCount: Number(r.pii_found_count) || 0,
                    totalChunks: Number(r.total_chunks) || 0,
                };
            }
            return out;
        },

        /**
         * KB-level counters with the same status semantics as listKBs:
         * { documentCount (active), documentCountAll, totalChunks }.
         */
        countDocumentsByStatus: async (kbId) => {
            await initDB();
            const r = await getOne(
                `SELECT COUNT(*) FILTER (WHERE ${ACTIVE_STATUS_SQL})::int AS document_count,
                    COUNT(*)::int AS document_count_all,
                    COALESCE(SUM(chunk_count) FILTER (WHERE ${ACTIVE_STATUS_SQL}), 0)::int AS total_chunks
               FROM documents WHERE knowledge_base_id = $1`,
                [kbId]
            );
            return {
                documentCount: Number(r?.document_count) || 0,
                documentCountAll: Number(r?.document_count_all) || 0,
                totalChunks: Number(r?.total_chunks) || 0,
            };
        },

        /**
         * List documents of a KB — PROJECTED (never original_content).
         *
         * @param {string} kbId
         * @param {{ limit?: number, offset?: number, filters?: Record<string, unknown> }} [opts]
         *   filters: sender, threadId, hasAttachment, dateFrom, dateTo, sourceType (legacy
         *   metadata filters) plus K1: sourceId, status (string|string[]), pii ('found' =
         *   found|redacted, or an exact pii_status), q (title ILIKE)
         */
        listDocuments: async (kbId, opts = {}) => {
            await initDB();
            const { limit = 200, offset = 0, filters = {} } = opts;
            const { clauses, vals } = buildDocumentFilters(kbId, filters);
            vals.push(limit); const limitIdx = vals.length;
            vals.push(offset); const offsetIdx = vals.length;
            return getAll(
                `SELECT ${DOC_SELECT} FROM documents
             WHERE ${clauses.join(' AND ')}
             ORDER BY created_at DESC
             LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
                vals
            );
        },

        countDocuments: async (kbId, filters = {}) => {
            await initDB();
            const { clauses, vals } = buildDocumentFilters(kbId, filters);
            const row = await getOne(`SELECT COUNT(*)::int AS n FROM documents WHERE ${clauses.join(' AND ')}`, vals);
            return row?.n || 0;
        },

        /**
         * Return distinct threadIds + sibling counts for a KB — for the thread explorer UI.
         */
        listThreads: async (kbId, opts = {}) => {
            await initDB();
            const { limit = 100 } = opts;
            return getAll(
                `SELECT metadata->>'threadId' AS thread_id,
                    COUNT(*)::int AS message_count,
                    MAX(created_at) AS latest
             FROM documents
             WHERE knowledge_base_id = $1
               AND metadata ? 'threadId'
               AND metadata->>'threadId' IS NOT NULL
             GROUP BY thread_id
             ORDER BY latest DESC
             LIMIT $2`,
                [kbId, limit]
            );
        },

        listDocumentsByThread: async (kbId, threadId) => {
            await initDB();
            return getAll(
                `SELECT ${DOC_SELECT} FROM documents
             WHERE knowledge_base_id = $1 AND metadata->>'threadId' = $2
             ORDER BY (metadata->>'date')::timestamptz NULLS LAST, created_at`,
                [kbId, threadId]
            );
        },

        /** One document, projected (no original_content). */
        getDocument: async (id) => {
            if (!id || !UUID_RE.test(String(id))) return null;
            await initDB();
            return getOne(`SELECT ${DOC_SELECT} FROM documents WHERE id = $1`, [id]);
        },

        /**
         * The stored full text of a document (the reindex path and the content
         * endpoint). Kept separate from getDocument on purpose: nothing that
         * renders a list should ever be handed the body.
         */
        getDocumentOriginalContent: async (id) => {
            await initDB();
            const row = await getOne('SELECT original_content FROM documents WHERE id = $1', [id]);
            return row ? (row.original_content ?? null) : null;
        },


        /**
         * Check if ACTIVE content with the same hash already exists in this KB
         * (deduplication). A skipped/error/duplicate row never blocks a retry.
         * Returns the canonical document id or null.
         */
        hasContentHash: async (kbId, contentHash) => {
            const row = await KnowledgeBasesStore.findDocumentByContentHash(kbId, contentHash);
            return row ? row.id : null;
        },

        /**
         * Same lookup, but returns { id, title, source_id, status } so the ingest
         * funnel can tell a same-source duplicate (refuse) from a cross-source
         * overlap (annotate).
         */
        findDocumentByContentHash: async (kbId, contentHash) => {
            await initDB();
            if (!kbId || !contentHash) return null;
            return getOne(
                `SELECT id, title, source_id, status FROM documents
             WHERE knowledge_base_id = $1 AND content_hash = $2 AND ${ACTIVE_STATUS_SQL}
             ORDER BY created_at ASC
             LIMIT 1`,
                [kbId, contentHash]
            );
        },

        /**
         * Find the most recent document in a KB with a given source_uri. Used by the
         * support→KB automation to UPDATE (replace chunks) rather than duplicate when a
         * ticket is re-resolved. Returns the (projected) row or null.
         */
        findDocumentBySourceUri: async (kbId, sourceUri) => {
            await initDB();
            if (!kbId || !sourceUri) return null;
            return getOne(
                `SELECT ${DOC_SELECT} FROM documents WHERE knowledge_base_id = $1 AND source_uri = $2 ORDER BY id DESC LIMIT 1`,
                [kbId, sourceUri]
            );
        },

    };
}

module.exports = { makeDocumentQueryFns };
