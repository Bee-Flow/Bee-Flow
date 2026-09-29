// @typecheck
'use strict';

/**
 * Explicit per-principal access: the `datatable_grants` rows.
 *
 * A grant is viewer or editor and nothing else — owner is derived from the
 * row, never granted, and org-wide write goes through `write_mode` so it stays
 * auditable on its own column. Adding one is guarded on the table living in
 * the caller's scope, exactly as the dependents index is: a caller holding the
 * wrong scope writes nothing rather than attaching a grant to a stranger's
 * table.
 *
 * Who may actually see a table is NOT decided here — that is
 * auth/datatableAccess.gradeForPrincipal, which reads these rows.
 */

const crypto = require('crypto');
const { run, getAll } = require('../../db');
const { assertScope } = require('./scope');
const { initDB } = require('./schema');
const { rowToGrant } = require('./rowMappers');

/** The grants for one table. */
async function listGrants(datatableId) {
    await initDB();
    if (!datatableId) throw new Error('listGrants requires a datatableId');
    const res = await getAll(
        `SELECT * FROM datatable_grants WHERE datatable_id = $1 ORDER BY created_at ASC`,
        [datatableId],
    );
    return (res || []).map(rowToGrant);
}

/**
 * Grants for MANY tables in one round trip — what a list endpoint needs so it
 * does not fan out one query per table.
 * @returns {Promise<Map<string, Array>>} datatableId → grants
 */
async function listGrantsForTables(datatableIds) {
    await initDB();
    const ids = (Array.isArray(datatableIds) ? datatableIds : []).filter(Boolean);
    if (!ids.length) return new Map();
    const res = await getAll(
        `SELECT * FROM datatable_grants WHERE datatable_id = ANY($1::text[])`,
        [ids],
    );
    const out = new Map(ids.map(id => [id, []]));
    for (const r of (res || [])) {
        if (!out.has(r.datatable_id)) out.set(r.datatable_id, []);
        out.get(r.datatable_id).push(rowToGrant(r));
    }
    return out;
}

/**
 * Add or upgrade one grant.
 *
 * The INSERT is guarded on the table living in `scope`, exactly as
 * reconcileUsage is: a caller holding the wrong scope writes nothing rather
 * than attaching a grant to a stranger's table.
 */
async function addGrant(datatableId, scope, { granteeType, granteeId, grade, grantedBy }) {
    await initDB();
    assertScope(scope, 'addGrant');
    const id = 'dtg_' + crypto.randomBytes(6).toString('hex');
    await run(
        `INSERT INTO datatable_grants
            (id, datatable_id, scope_kind, scope_id, grantee_type, grantee_id, grade, granted_by)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8
          WHERE EXISTS (SELECT 1 FROM datatables WHERE id = $2 AND scope_kind = $3 AND scope_id = $4)
         ON CONFLICT (datatable_id, grantee_type, grantee_id)
         DO UPDATE SET grade = EXCLUDED.grade, granted_by = EXCLUDED.granted_by`,
        [id, datatableId, scope.kind, scope.id, granteeType, granteeId, grade, grantedBy],
    );
    return listGrants(datatableId);
}

async function removeGrant(datatableId, grantId) {
    await initDB();
    await run(`DELETE FROM datatable_grants WHERE id = $1 AND datatable_id = $2`, [grantId, datatableId]);
    return listGrants(datatableId);
}

module.exports = {
    listGrants,
    listGrantsForTables,
    addGrant,
    removeGrant,
};
