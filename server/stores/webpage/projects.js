// @typecheck
// Project (Solution) membership for webpages: filing a page into a project,
// taking it back out, and listing the pages a project holds.

const { run, getAll } = require('../../db');
const { initDB } = require('./schema');
const { mapWebpageRow } = require('./shared');

// ── Project membership ──────────────────────────────────────────────
//
// Mirrors studioAppStore's listProjectApps / setAppProject /
// clearProjectFromApps one-for-one. Membership is additive: a page filed into
// a project is still its owner's page, and taking the project away gives it
// back rather than deleting it.

/** Webpages filed into a project. */
async function listProjectWebpages(projectId) {
    await initDB();
    if (!projectId) return [];
    const rows = await getAll(
        `SELECT w.*, 0 AS source_count FROM webpages w
          WHERE w.project_id = $1 ORDER BY w.updated_at DESC`,
        [projectId]
    );
    return rows.map(mapWebpageRow);
}

/**
 * How many webpages each of these projects holds — ONE query for the whole
 * list, keyed by project id.
 *
 * The overview draws a card per Solution and every card carries a tally. Doing
 * that with the listing above would be one round-trip per project per kind, and
 * would read whole rows to throw all but their number away. A project that
 * appears in no row is genuinely EMPTY, which is why the caller distinguishes a
 * missing key (0) from a failed read (the whole call rejects) rather than
 * folding both into a zero.
 */
async function countProjectWebpages(projectIds) {
    await initDB();
    const ids = (Array.isArray(projectIds) ? projectIds : []).filter(id => typeof id === 'string' && id);
    if (!ids.length) return new Map();
    const rows = await getAll(
        `SELECT project_id, COUNT(*)::int AS n FROM webpages
          WHERE project_id = ANY($1) GROUP BY project_id`,
        [ids]
    );
    return new Map(rows.map(r => [r.project_id, Number(r.n) || 0]));
}

/**
 * File a webpage into a project, or take it out (projectId = null).
 *
 * Owner-only, for the same reason setAppProject is: filing a page into a
 * project exposes it to every member without it being org-published, and that
 * is the owner's call. The caller checks the user's role on the TARGET project.
 */
async function setWebpageProject(webpageId, userId, projectId) {
    await initDB();
    const { rowCount } = await run(
        'UPDATE webpages SET project_id = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3',
        [projectId || null, webpageId, userId]
    );
    return rowCount > 0;
}

/** Detach every webpage from a deleted project. Soft ref — nothing else clears it. */
async function clearProjectFromWebpages(projectId) {
    await initDB();
    const { rowCount } = await run(
        'UPDATE webpages SET project_id = NULL WHERE project_id = $1',
        [projectId]
    );
    return rowCount;
}

module.exports = {
    listProjectWebpages,
    countProjectWebpages,
    setWebpageProject,
    clearProjectFromWebpages,
};
