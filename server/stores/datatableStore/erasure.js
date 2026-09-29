// @typecheck
'use strict';

/**
 * What happens to a departing account's tables.
 *
 * A personal table (never published, no grants) goes with the account; a
 * shared one is the ORGANISATION's record under its own lawful basis and is
 * transferred rather than dropped — so this module answers "what does this
 * user own, and how many grants does each carry" and leaves the decision to
 * the caller. Beside it: handing a table over, and dropping every grant the
 * leaver held or was given.
 */

const { run, getAll } = require('../../db');
const { assertScope } = require('./scope');
const { initDB } = require('./schema');
const { rowToDatatable } = require('./rowMappers');
const { getDatatable } = require('./datatables');

/**
 * Tables owned by a departing user. Personal ones (never published, no grants)
 * go with the account; shared ones are the ORGANISATION's records under its own
 * lawful basis and are transferred rather than dropped, so the caller decides.
 * A user-scoped table is always the first kind — nobody else could ever reach it.
 */
async function listOwnedBy(userId) {
    await initDB();
    const res = await getAll(
        `SELECT d.*, (SELECT COUNT(*)::int FROM datatable_grants g WHERE g.datatable_id = d.id) AS grant_count
           FROM datatables d WHERE d.owner_user_id = $1`,
        [userId],
    );
    return (res || []).map(r => ({ ...rowToDatatable(r), grantCount: Number(r.grant_count) || 0 }));
}

/** Hand a table to a new owner (offboarding a leaver who shared it). */
async function transferOwner(id, scope, newOwnerUserId) {
    await initDB();
    assertScope(scope, 'transferOwner');
    await run(
        `UPDATE datatables SET owner_user_id = $4, updated_at = NOW()
          WHERE id = $1 AND scope_kind = $2 AND scope_id = $3`,
        [id, scope.kind, scope.id, newOwnerUserId],
    );
    return getDatatable(id, scope);
}

/** Drop every grant a departing user held or was given. */
async function purgeGrantsForUser(userId) {
    await initDB();
    const res = await run(
        `DELETE FROM datatable_grants WHERE grantee_type = 'user' AND grantee_id = $1`, [userId],
    );
    return res?.rowCount || 0;
}

module.exports = {
    listOwnedBy,
    transferOwner,
    purgeGrantsForUser,
};
