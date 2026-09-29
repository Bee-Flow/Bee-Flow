// @typecheck
'use strict';

/**
 * Solution membership: `datatables.project_id`.
 *
 * What projects/membership.js registers for this resource kind — list, count,
 * file, detach. Filing a table into a project is its own act with its own
 * gate, deliberately outside META_COLUMNS and outside the metadata PATCH; the
 * comment below says why, and stores/datatableStore.project.test.js holds the
 * door shut.
 */

const { run, getAll } = require('../../db');
const { initDB } = require('./schema');
const { rowToDatatable } = require('./rowMappers');

// ── Solution membership (O1) ────────────────────────────────────────────────
//
// `datatables.project_id` shipped with the column and its partial index and
// nothing that read or wrote it. These three are what projects/membership.js
// registers, in the shape studioAppStore.setAppProject proves.
//
// ── Why these do NOT go through updateDatatableMeta ─────────────────────────
//
// META_COLUMNS is the list of things a PATCH may change about a table, and
// `projectId` is deliberately not in it. Adding it would open
// `PATCH /api/datatables/:id/meta` to writing project_id with no check on the
// caller's role in the TARGET project — filing somebody's table into a project
// through the metadata editor. Membership is its own act with its own gate
// (editor on the project AND owner of the table), so it gets its own statement.
//
// ── Why these take no scope ─────────────────────────────────────────────────
//
// Every other write here is scope-addressed because it names a tenant's
// physical table. These do not: `id` is the primary key, and the ownership
// predicate the registry contract requires is `owner_user_id`. A scope
// argument the caller would have to look up first could only ever disagree
// with the row, and the row is the authority on which tenant it belongs to.

/** The tables filed into one project. */
async function listDatatablesForProject(projectId) {
    await initDB();
    if (!projectId) return [];
    const res = await getAll(
        `SELECT * FROM datatables WHERE project_id = $1 ORDER BY name ASC`,
        [projectId],
    );
    return (res || []).map(rowToDatatable);
}

/**
 * How many tables each of these projects holds — ONE query for the whole
 * list, keyed by project id.
 *
 * The overview draws a card per Solution and every card carries a tally. Doing
 * that with the listing above would be one round-trip per project per kind, and
 * would read whole rows to throw all but their number away. A project that
 * appears in no row is genuinely EMPTY, which is why the caller distinguishes a
 * missing key (0) from a failed read (the whole call rejects) rather than
 * folding both into a zero.
 */
async function countDatatablesForProject(projectIds) {
    await initDB();
    const ids = (Array.isArray(projectIds) ? projectIds : []).filter(id => typeof id === 'string' && id);
    if (!ids.length) return new Map();
    const rows = await getAll(
        `SELECT project_id, COUNT(*)::int AS n FROM datatables
          WHERE project_id = ANY($1) GROUP BY project_id`,
        [ids],
    );
    return new Map((rows || []).map(r => [r.project_id, Number(r.n) || 0]));
}

/**
 * File a table into a project, or take it out (`projectId = null`).
 *
 * Owner-only, matched in the WHERE clause: filing a table into a project shows
 * it to every member without it being published or granted, and that is the
 * owner's decision. `data_version` is untouched — membership changes no rows.
 */
async function setDatatableProject(id, userId, projectId) {
    await initDB();
    if (!id || !userId) return false;
    const { rowCount } = await run(
        `UPDATE datatables SET project_id = $1, updated_at = NOW()
          WHERE id = $2 AND owner_user_id = $3`,
        [projectId || null, id, userId],
    );
    return rowCount > 0;
}

/**
 * Detach every table from a deleted project.
 *
 * Soft reference, so nothing clears it automatically — and deleting a project
 * must never destroy the tables its members built inside it, nor a single row.
 */
async function clearProjectFromDatatables(projectId) {
    await initDB();
    const { rowCount } = await run(
        `UPDATE datatables SET project_id = NULL WHERE project_id = $1`,
        [projectId],
    );
    return rowCount;
}

module.exports = {
    listDatatablesForProject,
    countDatatablesForProject,
    setDatatableProject,
    clearProjectFromDatatables,
};
