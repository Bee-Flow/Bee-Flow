// @typecheck
/**
 * Row → object mappers shared by the parts of studioAppDataStore.
 */

const { parseJSON } = require('../lib/json');

/**
 * @param {string | number | Date} v
 */
function toIso(v) { return v ? new Date(v).toISOString() : null; }

// ── Row mappers ─────────────────────────────────────────────────────

function mapMetaRow(r) {
    return {
        appId: r.app_id,
        ownerUserId: r.owner_user_id,
        model: parseJSON(r.model, {}),
        modelVersion: parseInt(r.model_version) || 0,
        dataVersions: parseJSON(r.data_versions, {}),
        rowCounts: parseJSON(r.row_counts, {}),
        createdAt: toIso(r.created_at),
        updatedAt: toIso(r.updated_at),
    };
}

function mapDatasetRow(r) {
    return {
        id: r.id,
        appId: r.app_id,
        ownerUserId: r.owner_user_id,
        name: r.name,
        tableId: r.table_id || null,
        source: parseJSON(r.source, {}),
        descriptor: parseJSON(r.descriptor, {}),
        cacheTtlSeconds: parseInt(r.cache_ttl_seconds) || 0,
        createdAt: toIso(r.created_at),
        updatedAt: toIso(r.updated_at),
    };
}

function mapCacheRow(r) {
    return {
        id: r.id,
        datasetId: r.dataset_id,
        viewerScopeKey: r.viewer_scope_key,
        paramsHash: r.params_hash,
        dataVersion: parseInt(r.data_version) || 0,
        result: parseJSON(r.result, {}),
        rowCount: parseInt(r.row_count) || 0,
        computedAt: toIso(r.computed_at),
        expiresAt: toIso(r.expires_at),
    };
}

function mapMemberRow(r) {
    return { appId: r.app_id, userId: r.user_id, roleKey: r.role_key, createdAt: toIso(r.created_at) };
}

function mapAttachmentRow(r) {
    return {
        id: r.id,
        appId: r.app_id,
        ownerUserId: r.owner_user_id,
        recordId: r.record_id || null,
        fieldKey: r.field_key || null,
        mimeType: r.mime_type,
        sha256: r.sha256 || '',
        size: parseInt(r.size) || 0,
        scanned: r.scanned === true || r.scanned === 't',
        quarantined: r.quarantined === true || r.quarantined === 't',
        createdAt: toIso(r.created_at),
        updatedAt: toIso(r.updated_at),
    };
}

module.exports = { toIso, mapMetaRow, mapDatasetRow, mapCacheRow, mapMemberRow, mapAttachmentRow };
