// @typecheck
'use strict';

/**
 * The retention sweep's half of the store (jobs/datatableRetention).
 *
 * Deliberately UNSCOPED: the sweep is a platform job with no viewer, and
 * `idx_datatables_retention` is the partial index built for exactly its
 * predicate. Beside the listing it owns the two things a pass writes back —
 * the heartbeat that tells "nothing was old enough" apart from "the job never
 * ran", and the true COUNT(*) that re-syncs a counter arithmetic has drifted.
 */

const { run, getAll } = require('../../db');
const { assertScope } = require('./scope');
const { initDB } = require('./schema');
const { rowToDatatable } = require('./rowMappers');
const { notifyDatatableChanged } = require('./liveChanges');

/**
 * Every table anywhere in the deployment that has a retention window.
 *
 * Deliberately NOT scoped: the sweep is a platform job with no viewer, and
 * `idx_datatables_retention` is the partial index built for exactly this
 * predicate. `retention_days IS NOT NULL` is the whole opt-in — the column
 * beside it, `retention_field`, is NOT NULL with a default, so it can never be
 * the thing that keeps rows alive.
 */
async function listDatatablesWithRetention() {
    await initDB();
    const res = await getAll(
        `SELECT * FROM datatables WHERE retention_days IS NOT NULL ORDER BY id ASC`,
    );
    return (res || []).map(rowToDatatable);
}

/**
 * Record that the sweep looked at this table. Stamped whether or not anything
 * was deleted: "nothing was old enough" and "the job never ran" are different
 * facts, and only this column can tell them apart.
 *
 * Separate from bumpAfterWrite because that one also bumps `data_version`, and
 * a pass that deleted nothing changed no data.
 */
async function stampRetentionSweep(id, scope) {
    await initDB();
    assertScope(scope, 'stampRetentionSweep');
    await run(
        `UPDATE datatables SET last_retention_at = NOW()
          WHERE id = $1 AND scope_kind = $2 AND scope_id = $3`,
        [id, scope.kind, scope.id],
    );
}

/**
 * Re-sync `row_count` with what the table actually holds.
 *
 * The counter is maintained by arithmetic (bumpAfterWrite) so a row write never
 * takes a lock, and arithmetic drifts: a retention pass that deleted 4,000 rows
 * from a counter that was already wrong stays wrong. The sweep already knows
 * the true COUNT(*), so it hands it over rather than adding another guess.
 */
async function setRowCount(id, scope, count) {
    await initDB();
    assertScope(scope, 'setRowCount');
    await run(
        `UPDATE datatables SET row_count = GREATEST(0, $4), data_version = data_version + 1, updated_at = NOW()
          WHERE id = $1 AND scope_kind = $2 AND scope_id = $3`,
        [id, scope.kind, scope.id, Math.max(0, Number(count) || 0)],
    );
    // The retention sweep's own path. It matters MORE here than after an
    // ordinary write: rows this pass removed are rows a knowledge base must
    // stop answering from, and a purge that leaves its copies searchable has
    // not purged anything.
    notifyDatatableChanged(id);
}

module.exports = {
    listDatatablesWithRetention,
    stampRetentionSweep,
    setRowCount,
};
