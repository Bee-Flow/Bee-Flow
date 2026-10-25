// @typecheck
/**
 * stores/studioApp/rowMappers.js — the list-safe column set and the row
 * mappers for apps and their version snapshots.
 */

const { parseJSONObject: parseJSON } = require('../lib/json');

// Columns safe for list rendering — never the heavy payloads (definition /
// published_definition) nor the owner-private builder_session.
const META_COLS = `id, user_id, organization_id, project_id, name, description, icon, accent_color, category,
    definition_version, published_version, is_published, shared_groups, nextcloud_menu, published_at, created_at, updated_at,
    template_id, template_version, template_install_hash`;

// ── Row mappers ─────────────────────────────────────────────────────

function mapAppMetaRow(r) {
    return {
        id: r.id,
        userId: r.user_id,
        organizationId: r.organization_id || null,
        // null = standalone; set = belongs to a Studio Project, whose members
        // are an AUDIENCE for it on top of org/group publishing — see
        // canReadStudioAppAsync for what that does and does not widen.
        projectId: r.project_id || null,
        name: r.name,
        description: r.description || '',
        icon: r.icon || null,
        accentColor: r.accent_color || null,
        // Directory category from the org's closed list; null = uncategorised.
        category: r.category || null,
        definitionVersion: parseInt(r.definition_version) || 1,
        // The definition_version that is actually live. null = never published,
        // or published before the column existed — callers must treat it as
        // "unknown", never as "in step with the draft".
        publishedVersion: r.published_version != null ? (parseInt(r.published_version) || null) : null,
        isPublished: r.is_published === true || r.is_published === 't',
        sharedGroups: parseJSON(r.shared_groups, []),
        // Template provenance — all three null on blank apps (and on apps
        // created before the columns existed). templateVersion is normalized
        // to an integer or null; consumers treat null as "unknown", never 0.
        templateId: r.template_id || null,
        templateVersion: r.template_version != null ? (parseInt(r.template_version) || null) : null,
        templateInstallHash: r.template_install_hash || null,
        nextcloudMenu: r.nextcloud_menu === true || r.nextcloud_menu === 't',
        publishedAt: r.published_at ? new Date(r.published_at).toISOString() : null,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    };
}

// Full row: meta + the definition payloads. builder_session deliberately has
// its own accessor (getBuilderSession) and never rides along on app rows.
function mapAppRow(r) {
    return {
        ...mapAppMetaRow(r),
        definition: parseJSON(r.definition, {}),
        publishedDefinition: r.published_definition != null ? parseJSON(r.published_definition, null) : null,
    };
}

function mapVersionMetaRow(r) {
    return {
        id: r.id,
        appId: r.app_id,
        summary: r.summary || '',
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    };
}

function mapVersionRow(r) {
    return {
        ...mapVersionMetaRow(r),
        userId: r.user_id,
        definition: parseJSON(r.definition, {}),
    };
}

module.exports = { META_COLS, mapAppMetaRow, mapAppRow, mapVersionMetaRow, mapVersionRow };

/** @typedef {ReturnType<typeof mapAppMetaRow>} AppMeta */
