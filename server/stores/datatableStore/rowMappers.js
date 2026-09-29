// @typecheck
'use strict';

/**
 * How a stored row becomes the object every caller sees.
 *
 * A `datatables` row is handed out in BOTH shapes on purpose — camelCase for
 * the API and the snake_case `auth/datatableAccess.gradeForPrincipal` reads —
 * because a mismatch there fails by comparing undefined to undefined, which is
 * the worst kind of quiet. A `datatable_grants` row gets the same treatment.
 *
 * Beside the mappers: the id a new table is minted with, the JSONB column
 * reader every mapper uses, and `inTransaction` — the envelope that lets a
 * caller's transaction carry the model document and the DDL that follows from
 * it into ONE commit.
 */

const crypto = require('crypto');
const { withTransaction } = require('../../db');
const { parseJSONObject } = require('../lib/json');

function newDatatableId() {
    return 'tbl_' + crypto.randomBytes(6).toString('hex');
}

function rowToDatatable(r) {
    if (!r) return null;
    // The scope columns are the address. The fallback to organization_id is for
    // one case only: a replica reading a row the scope migration has not
    // reached yet. It reproduces exactly what the backfill writes, so a
    // half-migrated deployment reads the right tenant instead of no tenant.
    const scopeKind = r.scope_kind || 'org';
    const scopeId = r.scope_id || r.organization_id || null;
    return {
        id: r.id,
        scope: { kind: scopeKind, id: scopeId },
        scopeKind,
        organizationId: r.organization_id || null,
        ownerUserId: r.owner_user_id,
        projectId: r.project_id || null,
        key: r.key,
        name: r.name,
        description: r.description || '',
        lawfulBasis: r.lawful_basis || null,
        isPublished: !!r.is_published,
        sharedGroups: parseJSONObject(r.shared_groups, []),
        writeMode: r.write_mode,
        rowScope: r.row_scope,
        retentionDays: r.retention_days === null ? null : Number(r.retention_days),
        retentionField: r.retention_field,
        subjectColumn: r.subject_column || null,
        lastRetentionAt: r.last_retention_at || null,
        // NULL = an ordinary table. A non-null value names the column contract
        // in core/dataEngine/dataModel/managedTables.js, and it is what the
        // schema route refuses column drops against.
        managedKind: r.managed_kind || null,
        // Where the rows come from, for a table that mirrors an external one
        // (managed_kind 'nextcloud_table'), and how the last fetch went. NULL
        // on every ordinary table. Neither is reachable through PATCH — see
        // META_COLUMNS — they are written only by the mirror engine.
        source: parseJSONObject(r.source, null),
        syncState: parseJSONObject(r.sync_state, null),
        rowCount: Number(r.row_count) || 0,
        dataVersion: Number(r.data_version) || 0,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        // The snake_case shape auth/datatableAccess expects. Kept alongside the
        // camelCase view so callers never have to re-map before asking for a
        // grade — a mismatch there fails OPEN-looking (undefined !== undefined
        // is false), which is exactly the bug worth designing out.
        scope_kind: scopeKind,
        scope_id: scopeId,
        organization_id: r.organization_id || null,
        owner_user_id: r.owner_user_id,
        is_published: !!r.is_published,
        shared_groups: parseJSONObject(r.shared_groups, []),
        write_mode: r.write_mode,
        row_scope: r.row_scope,
    };
}

/**
 * Run `fn` on the CALLER's transaction when they own one, otherwise open our
 * own. Every write below takes an optional `client` for this reason: the model
 * document and the physical DDL that follows from it have to land in ONE
 * commit. They used to be two — the model committed first, and a DDL failure
 * (a bad type, a lock timeout, a replica restart) left the model claiming a
 * column Postgres does not have, `model_version` already bumped, and
 * migrationPlan step 4 skipping the field for ever because its id is now in
 * `oldIds`. The divergence was permanent and nothing reported it.
 */
function inTransaction(client, fn) {
    return client ? fn(client) : withTransaction(fn);
}

function rowToGrant(r) {
    return r && {
        id: r.id,
        datatableId: r.datatable_id,
        grantee_type: r.grantee_type,
        grantee_id: r.grantee_id,
        grade: r.grade,
        grantedBy: r.granted_by,
        createdAt: r.created_at,
    };
}

module.exports = {
    newDatatableId,
    rowToDatatable,
    inTransaction,
    rowToGrant,
};
