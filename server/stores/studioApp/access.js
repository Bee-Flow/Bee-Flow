// @typecheck
/**
 * stores/studioApp/access.js — the read/write predicates over a mapped app
 * row (sync, and widened by project membership), and the existence check.
 */

const { dep } = require('./deps');
// ── Access predicates (pure) ────────────────────────────────────────

/**
 * Single-row visibility predicate over a mapped app row. Owner always;
 * otherwise the app must be published into an org the user belongs to, with
 * shared_groups=[] meaning the whole org. Mirrors canReadWebpage.
 */
function canReadStudioApp(app, userId, userGroupIds = [], userOrgIds = []) {
    if (!app || !userId) return false;
    if (app.userId === userId) return true;
    if (!app.isPublished) return false;
    if (!app.organizationId) return false;
    const orgIds = Array.isArray(userOrgIds) ? userOrgIds : [...(userOrgIds || [])];
    if (!orgIds.includes(app.organizationId)) return false;
    const groups = Array.isArray(app.sharedGroups) ? app.sharedGroups : [];
    if (groups.length === 0) return true;
    return groups.some(g => userGroupIds.includes(g));
}

/**
 * canReadStudioApp, widened by Studio Project membership.
 *
 * Async because the project role is a DB lookup, which is why this is a
 * separate function rather than a fourth argument: the sync predicate has
 * callers that cannot await (the templates, the pure filters), and they keep
 * the old behaviour to the letter.
 *
 * The owner retains preview access. Reading somebody else's app requires use_apps
 * and either its publication audience or membership in the app's project.
 *
 * READ ONLY. Filing an app into a project does not make the project's members
 * its authors — canWriteStudioApp stays owner-only for the acts-as-author
 * reason below, and no write path calls this.
 *
 * PUBLICATION IS STILL REQUIRED. Project membership answers WHO may read, not
 * whether there is anything to read: without is_published there is no frozen
 * published_definition, the runtime route refuses the app before it asks any
 * predicate, and the owner's live draft is never served to anyone else. So a
 * standalone app (project_id IS NULL) and an unpublished one both stay exactly
 * as private as they were.
 */
async function canReadStudioAppAsync(app, userId, userGroupIds = [], userOrgIds = [], /** @type {import('../../core/entitlements/entitlementTypes').SessionLike | null} */ session = null) {
    if (!app || !userId) return false;
    if (app.userId === userId) return true;
    if (!app.isPublished || !await dep('mayUseSharedApps')(userId, session)) return false;
    if (canReadStudioApp(app, userId, userGroupIds, userOrgIds)) return true;
    if (!app.projectId) return false;
    const { getProjectRole } = dep('projectAccess')();
    return !!(await getProjectRole(userId, app.projectId));
}

// Owner-only, unlike canWriteWebpage. Deliberate: app actions run automations
// acts-as-author, so shared editors could otherwise point the owner's
// credentials at arbitrary automations by rewiring the definition.
function canWriteStudioApp(app, userId) {
    if (!app || !userId) return false;
    return app.userId === userId;
}

module.exports = { canReadStudioApp, canReadStudioAppAsync, canWriteStudioApp };
