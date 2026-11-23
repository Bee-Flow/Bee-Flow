// @typecheck
'use strict';
const { sharingOf } = require('../lib/documentSharing');
/**
 * Pure row -> API-shape mappers for studio documents (no DB access).
 * Split out of documentStore.js; the store re-exports them.
 */

function mapRow(row) {
    if (!row) return null;
    let settings = {};
    if (row.settings) {
        settings = typeof row.settings === 'string' ? JSON.parse(row.settings) : row.settings;
    }
    return {
        id: row.id,
        userId: row.user_id,
        name: row.name,
        docType: row.doc_type,
        description: row.description || '',
        bodyHtml: row.body_html || '',
        css: row.css || '',
        settings,
        organizationId: row.organization_id || null,
        kind: row.kind || 'document', visibility: row.visibility || 'private',
        sharing: sharingOf(row),
        cryptoContext: row._contentCryptoContext || null,
        folderId: row.folder_id || null, categories: row.categories || [],
        versionId: row.version_id || null, baselineVersionId: row.baseline_version_id || null,
        archived: row.archived === true,
        projectId: row.project_id || null,
        updatedBy: row.updated_by || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

/**
 * Who a list row is shared with: 'restricted' (some people or groups),
 * 'organisation' or 'private'; the library query reads it (documentSharing
 * audienceSql), a row without it says what its visibility says.
 */
function listAudience(row) {
    return row.audience || (row.visibility === 'team' ? 'organisation' : 'private');
}

/**
 * The list row deliberately omits the slots. A documents list renders names,
 * types and dates; shipping every document's full markup to paint a list is
 * the kind of thing that only hurts once somebody has three hundred of them.
 */
function mapListRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        userId: row.user_id,
        name: row.name,
        docType: row.doc_type,
        description: row.description || '',
        kind: row.kind || 'document', visibility: row.visibility || 'private',
        audience: listAudience(row),
        folderId: row.folder_id || null, categories: row.categories || [], versionId: row.version_id,
        htmlSize: Number(row.html_size) || 0,
        projectId: row.project_id || null,
        // The Solution a template is filed in (its own column, never project_id).
        solutionProjectId: row.solution_project_id || null,
        updatedBy: row.updated_by || null,
        archived: row.archived === true,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        // Notebook rows only: how many sources it reads.
        ...(row.source_count === null || row.source_count === undefined ? {} : { sourceCount: Number(row.source_count) || 0 }),
    };
}

/**
 * The card a project listing shows. No slots and no library metadata (folder,
 * categories, visibility are the owner's own filing), just what a project
 * member needs to find the document and see whose it is.
 */
function mapProjectCard(row) {
    return {
        id: row.id,
        name: row.name,
        docType: row.doc_type,
        kind: row.kind || 'document',
        userId: row.user_id,
        projectId: row.project_id || null,
        updatedBy: row.updated_by || null,
        updatedAt: row.updated_at,
        createdAt: row.created_at,
    };
}

module.exports = { mapRow, mapListRow, mapProjectCard };
