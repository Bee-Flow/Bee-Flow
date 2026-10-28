// @typecheck noImplicitAny
const kbStore = require('../../stores/knowledgeBases');

function docColumns() {
    return Array.isArray(kbStore.DOCUMENT_COLUMNS) ? kbStore.DOCUMENT_COLUMNS.join(', ') : '*';
}

/**
 * Find the KB document record that was created for a notebook source.
 * During ingestion, notebook sources store the source ID as `source_uri`.
 *
 * @param {string} kbId     — knowledge base ID
 * @param {string} sourceId — notebook source ID
 * @returns {Promise<object|null>} document row (projected) or null
 */
async function findDocumentBySourceUri(kbId, sourceId) {
    const { getOne } = require('../../db');
    return await getOne(
        `SELECT ${docColumns()} FROM documents WHERE knowledge_base_id = $1 AND source_uri = $2`,
        [kbId, sourceId]
    );
}

/**
 * All documents for a source, not just the first.
 *
 * Re-ingesting a source (the retry button, or a duplicate add) can leave more
 * than one `documents` row with the same source_uri. Cleanup that resolved only
 * ONE of them deleted that row's chunks and orphaned the rest — embeddings of
 * deleted content stayed searchable, which in a privacy product means deleted
 * text keeps coming back in answers.
 *
 * K1: also keyed on (source_id, external_id) — pass `opts.sourceId` and
 * `opts.externalId` and rows matching EITHER the legacy source_uri OR the
 * (source, external id) pair are returned (duplicate alias rows excluded on
 * the latter, they share the canonical row's external id).
 *
 * @param {string} kbId
 * @param {string|null} sourceUri
 * @param {object} [opts]
 * @param {string} [opts.sourceId]
 * @param {string} [opts.externalId]
 */
async function findDocumentsBySourceUri(kbId, sourceUri, { sourceId = null, externalId = null } = {}) {
    const { getAll } = require('../../db');
    const byPair = sourceId && externalId != null;
    if (!byPair) {
        return await getAll(
            `SELECT ${docColumns()} FROM documents WHERE knowledge_base_id = $1 AND source_uri = $2`,
            [kbId, sourceUri]
        );
    }
    return await getAll(
        `SELECT ${docColumns()} FROM documents
          WHERE knowledge_base_id = $1
            AND (($2::text IS NOT NULL AND source_uri = $2)
                 OR (source_id = $3 AND external_id = $4 AND status <> 'duplicate'))
          ORDER BY created_at DESC`,
        [kbId, sourceUri || null, sourceId, String(externalId)]
    );
}

module.exports = { findDocumentBySourceUri, findDocumentsBySourceUri };
