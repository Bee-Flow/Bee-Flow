// @typecheck
/**
 * stores/notebook/rowMappers.js — notebook and source rows to API shape.
 * Split out of stores/notebookStore.js.
 */

const { parseJSONObject: parseJSON } = require('../lib/json');

// ── Row Mappers ─────────────────────────────────────────────────────


function mapNotebookRow(r) {
    return {
        id: r.id,
        userId: r.user_id,
        name: r.name,
        description: r.description || '',
        instructions: r.instructions || '',
        knowledgeBaseIds: parseJSON(r.knowledge_base_ids, []),
        settings: parseJSON(r.settings, {}),
        cryptoContext: r._contentCryptoContext || null,
        documentContent: r.document_content || '',
        documentMd: r.document_md != null ? r.document_md : null,
        documentFormat: r.document_format || 'html',
        type: r.type || 'notebook',
        // null = standalone (owner-only, today's behaviour); set = filed into a
        // project, and readable by its members.
        projectId: r.project_id || null,
        organizationId: r.organization_id || null,
        version: typeof r.version === 'number' ? r.version : (parseInt(r.version) || 0),
        sourceCount: parseInt(r.source_count) || 0,
        // Where its owner filed it in the Documents library (notebookLibrary).
        folderId: r.folder_id || null,
        categories: Array.isArray(r.categories) ? r.categories : parseJSON(r.categories, []),
        lastEditedBy: r.last_edited_by || null,
        lastEditedAt: r.last_edited_at ? new Date(r.last_edited_at).toISOString() : null,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    };
}

function mapSourceRow(r) {
    return {
        id: r.id,
        notebookId: r.notebook_id,
        type: r.type,
        name: r.name,
        storageKey: r.storage_key,
        fileName: r.file_name,
        metadata: parseJSON(r.metadata, {}),
        status: r.status,
        stage: r.stage || null,
        error: r.error || null,
        wordCount: parseInt(r.word_count) || 0,
        sortOrder: parseInt(r.sort_order) || 0,
        // Flag (not the content) so the list payload stays small but the UI knows
        // a preview is available and whether a text/meeting source can be retried.
        hasContent: r.has_content !== undefined ? !!r.has_content : !!(r.content_text && r.content_text.length),
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    };
}

module.exports = { mapNotebookRow, mapSourceRow };
