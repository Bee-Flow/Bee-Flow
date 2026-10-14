// @typecheck
/**
 * stores/studioApp/publication.js — where an app shows up besides the app
 * list: the Nextcloud app menu, Studio Project membership, and the anonymous
 * public pages.
 */

const crypto = require('crypto');
const { dep } = require('./deps');
const { initDB } = require('./schema');
const { META_COLS, mapAppMetaRow } = require('./rowMappers');

const { run, getOne, getAll } = dep('db');

// ── Nextcloud app-menu publication ──────────────────────────────────

/**
 * Toggle whether this app should appear in the Nextcloud app menu of the
 * organisation's connected Nextcloud. Owner-scoped in the WHERE (IDOR-safe,
 * same contract as updateStudioApp). Returns the updated meta row or null.
 */
async function setStudioAppNextcloudMenu(id, ownerId, enabled) {
    await initDB();
    const row = await getOne(
        `UPDATE studio_apps SET nextcloud_menu = $1, updated_at = NOW()
         WHERE id = $2 AND user_id = $3
         RETURNING ${META_COLS}`,
        [!!enabled, id, ownerId]
    );
    return row ? mapAppMetaRow(row) : null;
}

/**
 * Apps the organisation's Nextcloud connector should expose as top-menu
 * entries: org-scoped, owner-opted-in (nextcloud_menu) AND currently
 * published with a frozen definition to serve. Meta only — the connector
 * needs names/icons, never definitions. Ordered by name so the menu order
 * is stable across syncs; capped because each row becomes an icon in every
 * user's Nextcloud top bar.
 */
const MAX_NEXTCLOUD_MENU_APPS = 30;
async function listNextcloudMenuApps(organizationId, { limit = MAX_NEXTCLOUD_MENU_APPS } = {}) {
    await initDB();
    if (!organizationId) return [];
    const rows = await getAll(
        `SELECT ${META_COLS} FROM studio_apps
         WHERE organization_id = $1
           AND nextcloud_menu = TRUE
           AND is_published = TRUE
           AND published_definition IS NOT NULL
         ORDER BY name ASC, id ASC
         LIMIT $2`,
        [organizationId, Math.min(limit, MAX_NEXTCLOUD_MENU_APPS)]
    );
    return rows.map(mapAppMetaRow);
}

// ── Project membership ──────────────────────────────────────────────

/** Apps filed into a project. Meta only — never the definition payloads. */
async function listProjectApps(projectId) {
    await initDB();
    if (!projectId) return [];
    const rows = await getAll(
        `SELECT ${META_COLS} FROM studio_apps WHERE project_id = $1 ORDER BY updated_at DESC`,
        [projectId]
    );
    return rows.map(mapAppMetaRow);
}

/**
 * How many apps each of these projects holds — ONE query for the whole
 * list, keyed by project id.
 *
 * The overview draws a card per Solution and every card carries a tally. Doing
 * that with the listing above would be one round-trip per project per kind, and
 * would read whole rows to throw all but their number away. A project that
 * appears in no row is genuinely EMPTY, which is why the caller distinguishes a
 * missing key (0) from a failed read (the whole call rejects) rather than
 * folding both into a zero.
 */
async function countProjectApps(projectIds) {
    await initDB();
    const ids = (Array.isArray(projectIds) ? projectIds : []).filter(id => typeof id === 'string' && id);
    if (!ids.length) return new Map();
    const rows = await getAll(
        `SELECT project_id, COUNT(*)::int AS n FROM studio_apps
          WHERE project_id = ANY($1) GROUP BY project_id`,
        [ids]
    );
    return new Map(rows.map(r => [r.project_id, Number(r.n) || 0]));
}

/**
 * File an app into a project, or take it out (projectId = null).
 *
 * Owner-only: filing an app into a project exposes it to every member without
 * it being org-published, which is the owner's decision. Callers check the
 * user's role on the TARGET project separately.
 */
async function setAppProject(appId, userId, projectId) {
    await initDB();
    const { rowCount } = await run(
        'UPDATE studio_apps SET project_id = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3',
        [projectId || null, appId, userId]
    );
    return rowCount > 0;
}

/**
 * Detach every app from a deleted project.
 *
 * Soft reference, so nothing clears it automatically — and deleting a project
 * must never destroy the apps its members built inside it.
 */
async function clearProjectFromApps(projectId) {
    await initDB();
    const { rowCount } = await run(
        'UPDATE studio_apps SET project_id = NULL WHERE project_id = $1',
        [projectId]
    );
    return rowCount;
}

// ── Public pages (anonymous entry points) ───────────────────────────
//
// The row id IS the URL token and IS the credential (automation_form_pages
// precedent). WHAT the anonymous visitor may see is not stored here — that is
// `publicAccess` in the app definition, so it versions with the app; this row
// only answers "is this URL live, and for which app?".

function mapPublicPageRow(r) {
    if (!r) return null;
    return {
        token: r.id,
        appId: r.app_id,
        createdBy: r.created_by || null,
        createdAt: r.created_at,
        lastSeenAt: r.last_seen_at || null,
        visits: Number(r.visits || 0),
    };
}

/** Mint a public URL for an app. 192 bits, exactly like a form page token. */
async function createPublicPage(appId, userId) {
    await initDB();
    const token = crypto.randomBytes(24).toString('hex');
    await run(
        'INSERT INTO studio_app_public_pages (id, app_id, created_by) VALUES ($1, $2, $3)',
        [token, appId, userId || null]
    );
    return { token, appId, createdBy: userId || null, visits: 0 };
}

/** Resolve a URL token. Shape is checked by the caller before any DB work. */
async function getPublicPage(token) {
    await initDB();
    if (!token) return null;
    return mapPublicPageRow(await getOne('SELECT * FROM studio_app_public_pages WHERE id = $1', [token]));
}

async function listPublicPages(appId) {
    await initDB();
    const rows = await getAll(
        'SELECT * FROM studio_app_public_pages WHERE app_id = $1 ORDER BY created_at DESC',
        [appId]
    );
    return rows.map(mapPublicPageRow);
}

/** Revoke a public URL. Scoped by appId so a token from another app can't be
 *  deleted by guessing (the caller has already proven ownership of the app). */
async function deletePublicPage(token, appId) {
    await initDB();
    const { rowCount } = await run(
        'DELETE FROM studio_app_public_pages WHERE id = $1 AND app_id = $2',
        [token, appId]
    );
    return rowCount > 0;
}

/** Advisory visit counter — never allowed to fail a request. */
async function touchPublicPage(token) {
    try {
        await run(
            'UPDATE studio_app_public_pages SET last_seen_at = NOW(), visits = visits + 1 WHERE id = $1',
            [token]
        );
    } catch (_) { /* advisory only */ }
}

module.exports = {
    setStudioAppNextcloudMenu,
    listNextcloudMenuApps,
    MAX_NEXTCLOUD_MENU_APPS,
    listProjectApps,
    countProjectApps,
    setAppProject,
    clearProjectFromApps,
    createPublicPage,
    getPublicPage,
    listPublicPages,
    deletePublicPage,
    touchPublicPage,
};
