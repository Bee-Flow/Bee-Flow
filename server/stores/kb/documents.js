// @typecheck
/**
 * stores/kb/documents.js — document writes: insert, duplicate alias,
 * status, refresh-in-place, delete (with its recovery snapshot), source uri,
 * chunk count, and the content hash. Every write to a carried base goes
 * through the Solution-stage guard. Split out of stores/knowledgeBases.js.
 */

const crypto = require('crypto');
const { buildUpdate } = require('../lib/sqlBuilder');
const {
    UUID_RE, DOC_STATUSES, PII_STATUSES, DOC_SELECT, toIntOrNull, DOC_CONTENT_COLUMNS,
} = require('./model');

/**
 * @param {import('./model').KbCtx} ctx  the barrel's db handle, schema init,
 *        write guard and the store object itself (methods dispatch through it,
 *        so a method swapped on the export is the one the others call)
 */
function makeDocumentFns(ctx) {
    const { run, getOne, initDB, log, assertKbWrite, self: KnowledgeBasesStore } = ctx;
    return {
        // ── Document CRUD ───────────────────────────────────────────────────

        /**
         * Insert a documents row.
         *
         * The first nine params are the legacy positional signature (routes/templates.js
         * still uses it). `extra` carries the K1 provenance/status columns:
         *   { sourceId, externalId, sourceModifiedAt, sizeBytes, pageCount, sheetCount,
         *     mime, createdBy, status, statusReason, extractSummary, piiStatus,
         *     piiCategories, overlapsDocumentId }
         */
        createDocument: async (tenantId, kbId, title, sourceType, sourceUri, contentHash, chunkCount = 0, metadata = null, simhash = null, extra = {}) => {
            await initDB();
            const x = extra || {};
            // A base whose content a Solution stage carries: documents arrive by deploy (`extra.managedWrite`).
            await assertKbWrite(kbId, ['documents'], x.managedWrite, { carryOnly: true });
            const status = DOC_STATUSES.includes(x.status) ? x.status : 'processed';
            const piiStatus = PII_STATUSES.includes(x.piiStatus) ? x.piiStatus : 'unscanned';
            const row = await getOne(
                `INSERT INTO documents (
                tenant_id, knowledge_base_id, title, source_type, source_uri, content_hash, chunk_count, metadata, simhash,
                source_id, external_id, source_modified_at, size_bytes, page_count, sheet_count, mime, created_by,
                status, status_reason, extract_summary, pii_status, pii_categories, overlaps_document_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9,
                     $10, $11, $12, $13, $14, $15, $16, $17,
                     $18, $19, $20, $21, $22::jsonb, $23)
             RETURNING ${DOC_SELECT}`,
                [tenantId, kbId, title, sourceType, sourceUri, contentHash, chunkCount, metadata ? JSON.stringify(metadata) : '{}', simhash,
                 x.sourceId || null, x.externalId != null ? String(x.externalId) : null, x.sourceModifiedAt || null,
                 toIntOrNull(x.sizeBytes), toIntOrNull(x.pageCount), toIntOrNull(x.sheetCount), x.mime || null, x.createdBy || null,
                 status, x.statusReason ? String(x.statusReason).slice(0, 500) : null, x.extractSummary || null,
                 piiStatus, x.piiCategories ? JSON.stringify(x.piiCategories) : null, x.overlapsDocumentId || null]
            );
            return row;
        },

        /**
         * Record a duplicate relationship: the new row is an alias for `canonicalId`.
         * No new chunks are embedded — the row just points to the canonical doc,
         * carries status 'duplicate' and never counts as content.
         */
        recordDuplicate: async (tenantId, kbId, title, sourceType, sourceUri, contentHash, canonicalId, metadata = null, extra = {}) => {
            await initDB();
            const x = extra || {};
            // A duplicate is a documents row too: the same rule as createDocument.
            await assertKbWrite(kbId, ['documents'], x.managedWrite, { carryOnly: true });
            return getOne(
                `INSERT INTO documents (tenant_id, knowledge_base_id, title, source_type, source_uri, content_hash, chunk_count, duplicate_of, metadata,
                                    status, status_reason, source_id, external_id, created_by, size_bytes, mime)
             VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8::jsonb, 'duplicate', $9, $10, $11, $12, $13, $14)
             RETURNING ${DOC_SELECT}`,
                [tenantId, kbId, title, sourceType, sourceUri, contentHash, canonicalId, metadata ? JSON.stringify(metadata) : '{}',
                 x.statusReason ? String(x.statusReason).slice(0, 500) : null,
                 x.sourceId || null, x.externalId != null ? String(x.externalId) : null, x.createdBy || null,
                 toIntOrNull(x.sizeBytes), x.mime || null]
            );
        },


        /**
         * Mark a row's outcome without touching its content columns — the
         * onFailure:'record' path and "process again" use it.
         * @param {string} docId
         * @param {any} p - { status, statusReason?, chunkCount? }
         */
        updateDocumentStatus: async (docId, { status, statusReason, chunkCount } = {}) => {
            await initDB();
            if (!DOC_STATUSES.includes(status)) throw new Error(`Invalid document status: ${status}`);
            return getOne(
                `UPDATE documents
                SET status = $2,
                    status_reason = $3,
                    chunk_count = COALESCE($4, chunk_count),
                    updated_at = now()
              WHERE id = $1
              RETURNING ${DOC_SELECT}`,
                [docId, status, statusReason ? String(statusReason).slice(0, 500) : null, toIntOrNull(chunkCount)]
            );
        },

        /**
         * Refresh-in-place: the row (and therefore documents.id, citations and
         * version history) is kept; only the content fingerprint and the
         * bookkeeping columns change. The caller has already replaced the chunks
         * (kbIngestionHelpers.reingestDocument). `undefined` keeps a stored
         * value, so a partial patch never blanks a column.
         */
        replaceDocumentContent: async (docId, patch = {}) => {
            await initDB();
            // A carried base in a Solution stage changes document content only
            // through a deploy (design 5.2: publish/audience only).
            const { managedWrite = null, ...updates } = patch || {};
            // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- UUID_RE is a constant anchored pattern with fixed-length groups: linear
            const owner = UUID_RE.test(String(docId))
                ? await getOne('SELECT knowledge_base_id FROM documents WHERE id = $1', [docId])
                : null;
            if (owner?.knowledge_base_id) {
                await assertKbWrite(owner.knowledge_base_id, ['documents'], managedWrite, { carryOnly: true });
            }
            const built = buildUpdate({
                table: 'documents',
                updates,
                columnMap: DOC_CONTENT_COLUMNS,
                extraSet: ['updated_at = now()'],
                where: [{ col: 'id', value: docId }],
                returning: DOC_SELECT,
            });
            // An empty patch has always still stamped the row and returned it —
            // the re-ingest path calls this to say "checked, unchanged", and a
            // document whose updated_at stopped moving reads as abandoned.
            if (!built) {
                return getOne(
                    `UPDATE documents SET updated_at = now() WHERE id = $1 RETURNING ${DOC_SELECT}`,
                    [docId]
                );
            }
            return getOne(built.sql, built.params);
        },


        deleteDocument: async (id, { deletedBy = null, skipSnapshot = false, managedWrite = null } = {}) => {
            await initDB();
            // A carried base in a Solution stage loses documents only through a deploy.
            // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- UUID_RE is a constant anchored pattern with fixed-length groups: linear
            const owner = UUID_RE.test(String(id))
                ? await getOne('SELECT knowledge_base_id FROM documents WHERE id = $1', [id])
                : null;
            if (owner?.knowledge_base_id) {
                await assertKbWrite(owner.knowledge_base_id, ['documents'], managedWrite, { carryOnly: true });
            }
            // Snapshot first so the row can be recovered via listDeletedDocuments.
            // The route handlers used to do this themselves; moving the call here
            // guarantees the snapshot also runs for background callers (reindex
            // cleanup, legacy bulk paths). Pass skipSnapshot:true when the caller
            // has already snapshotted to avoid double-writes.
            if (!skipSnapshot) {
                try {
                    await KnowledgeBasesStore.snapshotDocumentVersion(id, deletedBy);
                } catch (e) {
                    log.warn('[KnowledgeBases] deleteDocument: snapshot failed', /** @type {Error} */ (e).message);
                }
            }
            await run('DELETE FROM documents WHERE id = $1', [id]);
            return true;
        },

        /**
         * Change a document's source_uri — used by transactional category_merge
         * swap: ingest new under a temp uri, then rename to the canonical uri
         * once the embeddings land.
         */
        updateDocumentSourceUri: async (id, newSourceUri) => {
            await initDB();
            return run(
                `UPDATE documents SET source_uri = $2 WHERE id = $1`,
                [id, newSourceUri]
            );
        },


        /**
         * Update chunk count for a document after ingestion.
         */
        updateChunkCount: async (docId, chunkCount) => {
            await initDB();
            return run('UPDATE documents SET chunk_count = $2, updated_at = now() WHERE id = $1', [docId, chunkCount]);
        },

        /**
         * Compute content hash for deduplication.
         */
        hashContent: (content) => {
            return crypto.createHash('sha256').update(content).digest('hex');
        },
    };
}

module.exports = { makeDocumentFns };

/**
 * The K1 provenance/status columns a caller may pass with a document.
 * @typedef {{ sourceId?: string | null, externalId?: string | number | null, sourceModifiedAt?: string | Date | null,
 *   sizeBytes?: number | string | null, pageCount?: number | string | null, sheetCount?: number | string | null,
 *   mime?: string | null, createdBy?: string | null, status?: string, statusReason?: string | null,
 *   extractSummary?: string | null, piiStatus?: string, piiCategories?: string[] | null,
 *   overlapsDocumentId?: string | null, managedWrite?: { deploymentId?: string } | null }} DocumentExtra
 */
