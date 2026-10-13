// @typecheck
/**
 * stores/kb/versions.js — history: knowledge-base metadata snapshots
 * (kb_versions) and the recovery snapshot of a deleted document
 * (kb_document_versions) with its retention. Split out of
 * stores/knowledgeBases.js.
 */

const { DOC_SELECT } = require('./model');

/**
 * @param {import('./model').KbCtx} ctx  the barrel's db handle, schema init,
 *        write guard and the store object itself (methods dispatch through it,
 *        so a method swapped on the export is the one the others call)
 */
function makeVersionFns(ctx) {
    const { run, getOne, getAll, initDB, log } = ctx;
    return {
        // ── KB Versioning ───────────────────────────────────────────────────
        // Snapshot the current state of a KB into kb_versions. Returns the new
        // version number, or null on failure. Best-effort: a failed snapshot
        // must never block the caller's mutation.
        snapshotKBVersion: async (kbId, changedBy, changeReason = null) => {
            await initDB();
            try {
                const kb = await getOne(`SELECT * FROM knowledge_bases WHERE id = $1`, [kbId]);
                if (!kb) return null;
                const next = await getOne(
                    `SELECT COALESCE(MAX(version_number), 0) + 1 AS v FROM kb_versions WHERE kb_id = $1`,
                    [kbId]
                );
                const versionNumber = next?.v || 1;
                await run(
                    `INSERT INTO kb_versions (kb_id, version_number, snapshot, changed_by, change_reason)
                 VALUES ($1, $2, $3, $4, $5)`,
                    [kbId, versionNumber, JSON.stringify(kb), changedBy || null, changeReason || null]
                );
                return versionNumber;
            } catch (e) {
                log.warn('[KnowledgeBases] snapshotKBVersion failed:', e.message);
                return null;
            }
        },

        listKBVersions: async (kbId, { limit = 50, offset = 0 } = {}) => {
            await initDB();
            return getAll(
                `SELECT id, version_number, changed_by, change_reason, created_at
             FROM kb_versions WHERE kb_id = $1
             ORDER BY version_number DESC LIMIT $2 OFFSET $3`,
                [kbId, limit, offset]
            );
        },

        getKBVersion: async (kbId, versionNumber) => {
            await initDB();
            return getOne(
                `SELECT * FROM kb_versions WHERE kb_id = $1 AND version_number = $2`,
                [kbId, versionNumber]
            );
        },

        // Snapshot a document BEFORE its row is deleted so a re-ingest can
        // recover the original metadata. Chunks themselves live in the
        // search-service; we record what's needed to reconstruct a re-ingest
        // request (title, source URI, content hash). Best-effort.
        //
        // The payload is the PROJECTED row: never original_content. This table
        // has no erasure path of its own, so a full-text copy here would outlive
        // every retention rule and every "delete my data" request.
        snapshotDocumentVersion: async (documentId, deletedBy = null) => {
            await initDB();
            try {
                const doc = await getOne(`SELECT ${DOC_SELECT} FROM documents WHERE id = $1`, [documentId]);
                if (!doc) return null;
                const { original_content: _omit, ...payload } = doc;
                await run(
                    `INSERT INTO kb_document_versions
                    (document_id, knowledge_base_id, tenant_id, title, source_type,
                     source_uri, content_hash, payload, deleted_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                    [
                        doc.id, doc.knowledge_base_id, doc.tenant_id,
                        doc.title, doc.source_type, doc.source_uri,
                        doc.content_hash, JSON.stringify(payload), deletedBy,
                    ]
                );
                return doc.id;
            } catch (e) {
                log.warn('[KnowledgeBases] snapshotDocumentVersion failed:', e.message);
                return null;
            }
        },

        /**
         * Retention for kb_document_versions: keep the newest `keepPerDoc`
         * snapshots per document AND drop anything older than `maxAgeDays`.
         * K3's tick calls this. Returns the number of rows removed.
         */
        pruneDocumentVersions: async (keepPerDoc = 3, maxAgeDays = 30) => {
            await initDB();
            const keep = Math.max(0, parseInt(keepPerDoc, 10) || 0);
            const days = Math.max(1, parseInt(maxAgeDays, 10) || 30);
            const r = await run(
                `DELETE FROM kb_document_versions v
              WHERE v.deleted_at < now() - ($2::int * INTERVAL '1 day')
                 OR v.id IN (
                    SELECT id FROM (
                        SELECT id, row_number() OVER (PARTITION BY document_id ORDER BY deleted_at DESC, id DESC) AS rn
                          FROM kb_document_versions
                    ) ranked
                     WHERE ranked.rn > $1
                 )`,
                [keep, days]
            );
            return (r && r.rowCount) || 0;
        },

        listDeletedDocuments: async (kbId, { limit = 100 } = {}) => {
            await initDB();
            return getAll(
                `SELECT id, document_id, title, source_type, source_uri, deleted_at, deleted_by
             FROM kb_document_versions WHERE knowledge_base_id = $1
             ORDER BY deleted_at DESC LIMIT $2`,
                [kbId, limit]
            );
        },
    };
}

module.exports = { makeVersionFns };
