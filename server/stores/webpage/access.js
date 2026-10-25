// @typecheck
// Webpage visibility: which pages a user may list (owned + published into
// their org/groups), the single-row read/write predicates, and the async
// predicate that widens reads by project membership.

const { getOne, getAll } = require('../../db');
const { initDB } = require('./schema');
const { parseJSON, mapWebpageRow } = require('./shared');
const log = require('../../telemetry/log');

/**
 * List webpages the user can see: ones they own + ones published into their
 * org/groups. Mirrors getPublishedAgentsForUser's predicate.
 */
async function getAccessibleWebpages(userId, userGroupIds = [], userOrgIds = [], { limit = 50, offset = 0 } = {}) {
    await initDB();
    const orgIds = Array.isArray(userOrgIds) ? userOrgIds : [...(userOrgIds || [])];
    const groupIds = Array.isArray(userGroupIds) ? userGroupIds : [];
    const rows = await getAll(
        `SELECT w.*,
                COALESCE(s.source_count, 0) AS source_count
         FROM webpages w
         LEFT JOIN (
             SELECT webpage_id, COUNT(*) AS source_count
             FROM webpage_sources GROUP BY webpage_id
         ) s ON s.webpage_id = w.id
         WHERE w.user_id = $1
            OR (w.is_published = TRUE AND w.organization_id IS NOT NULL AND w.organization_id = ANY($2::text[]))
         ORDER BY w.updated_at DESC
         LIMIT $3 OFFSET $4`,
        [userId, orgIds, limit, offset]
    );
    // Filter shared_groups in JS — keeps the SQL portable and parsing consistent.
    return rows
        .map(mapWebpageRow)
        .filter(w => {
            if (w.userId === userId) return true;
            if (!w.isPublished) return false;
            const groups = Array.isArray(w.sharedGroups) ? w.sharedGroups : [];
            if (groups.length === 0) return true; // entire-org publish
            return groups.some(g => groupIds.includes(g));
        });
}

/**
 * The group-share rule as SQL, on the TEXT column `shared_groups` ($2 is the
 * caller's group ids, text[]). Same reading as parseJSON + the JS rule: a
 * NULL, a non-array or an empty array is an entire-org publish; otherwise one
 * shared group must be one of the caller's. The CASE only casts a value that
 * starts like a JSON array, so a non-array value never reaches ::jsonb.
 */
const SHARED_GROUPS_ADMIT_SQL = `(CASE
           WHEN ltrim(shared_groups, E' \\t\\n\\r') LIKE '[%'
             THEN (jsonb_array_length(shared_groups::jsonb) = 0
                   OR shared_groups::jsonb ?| $2::text[])
           ELSE TRUE
         END)`;

/**
 * Cheap existence check: does the user have at least one webpage they can
 * act on (own, or org-published into their org/groups)? Used to grant the
 * webpage automation tools to a user who demonstrably has webpage access even
 * when the separate `webpages` beta toggle is off — the per-call
 * canWriteWebpage gate still enforces access to each specific page.
 *
 * The group-share rule (mirrors getAccessibleWebpages / canReadWebpage) runs
 * in SQL as one EXISTS, so the answer covers EVERY published page in the org.
 * It used to fetch an unordered window of 50 candidates and filter that in
 * JS, which answered "no" to someone whose only page sat outside the window.
 */
async function userHasAnyWebpageAccess(userId, userGroupIds = [], userOrgIds = []) {
    await initDB();
    if (!userId) return false;
    const orgIds = Array.isArray(userOrgIds) ? userOrgIds : [...(userOrgIds || [])];
    const groupIds = Array.isArray(userGroupIds) ? userGroupIds : [];
    // Owner check is a true EXISTS (fast, index-friendly).
    const owned = await getOne(`SELECT 1 FROM webpages WHERE user_id = $1 LIMIT 1`, [userId]);
    if (owned) return true;
    if (orgIds.length === 0) return false;
    try {
        const hit = await getOne(
            `SELECT 1 FROM webpages
              WHERE is_published = TRUE AND organization_id = ANY($1::text[])
                AND ${SHARED_GROUPS_ADMIT_SQL}
              LIMIT 1`,
            [orgIds, groupIds.filter(g => typeof g === 'string')]
        );
        return !!hit;
    } catch (err) {
        // Only a shared_groups value that starts like an array but is not
        // valid JSON gets here (no writer produces one: they all
        // JSON.stringify). Keep the old JS reading for it — parse failure
        // means entire-org — over the distinct sharing configurations, which
        // are few, instead of answering "no".
        log.warn('[WebpageStore] userHasAnyWebpageAccess SQL check failed, using JS fallback:', /** @type {Error} */ (err)?.message);
        const rows = await getAll(
            `SELECT DISTINCT shared_groups FROM webpages
              WHERE is_published = TRUE AND organization_id = ANY($1::text[])`,
            [orgIds]
        );
        return rows.some(r => sharedGroupsAdmit(parseJSON(r.shared_groups, []), groupIds));
    }
}

/** @param {unknown} groups @param {unknown[]} groupIds */
function sharedGroupsAdmit(groups, groupIds) {
    if (!Array.isArray(groups) || groups.length === 0) return true; // entire-org publish
    return groups.some(g => groupIds.includes(g));
}

/**
 * Single-row visibility predicate. Returns true if the caller can read the
 * webpage; mirrors the agent canSeePublished rules.
 * @param {string} userId
 */
function canReadWebpage(webpage, userId, userGroupIds = [], userOrgIds = []) {
    if (!webpage) return false;
    if (webpage.userId === userId) return true;
    if (!webpage.isPublished) return false;
    if (!webpage.organizationId) return false;
    const orgIds = Array.isArray(userOrgIds) ? userOrgIds : [...(userOrgIds || [])];
    if (!orgIds.includes(webpage.organizationId)) return false;
    const groups = Array.isArray(webpage.sharedGroups) ? webpage.sharedGroups : [];
    if (groups.length === 0) return true;
    return groups.some(g => userGroupIds.includes(g));
}

// Same surface as canReadWebpage. Automations were opted in to write to
// shared/published webpages by product decision; if we later need to gate
// writes more tightly (e.g. only writers in an explicit acl), narrow here.
/**
 * @param {string} userId
 */
function canWriteWebpage(webpage, userId, userGroupIds = [], userOrgIds = []) {
    return canReadWebpage(webpage, userId, userGroupIds, userOrgIds);
}

/**
 * WHICH bytes a reader gets — the W2 publish lifecycle's one read rule.
 *
 * Separate from canReadWebpage on purpose: that answers "may this person open
 * the page at all", this answers "and then which snapshot do they see". Both
 * questions have to be asked, and mixing them is how a reader ends up with the
 * owner's live keystrokes.
 *
 *   owner        → { versionId: null } — the live row. The editor IS the live
 *                  row; an owner reading their own pinned snapshot would be
 *                  unable to edit their own page.
 *   anyone else  → the pinned snapshot (`published_version_id`).
 *
 * ── THE NULL CASE IS A KNOWN FAIL-OPEN, WRITTEN DOWN RATHER THAN HIDDEN ────
 * With no pointer this returns `{ versionId: null, fellBackToLive: true }` and
 * the caller serves the LIVE row. That is the wider value for an unknown one,
 * which this product's own rule forbids — a reader then sees work the owner
 * never published.
 *
 * It is built this way because the alternative is worse TODAY: `is_published`
 * has been the only gate for the lifetime of this table, so refusing on a NULL
 * pointer would blank every org-published page that predates this column, on
 * the deploy, before the backfill migration has run. The pointer is written by
 * PATCH /:id/publish (first publish always pins) and backfilled by
 * server/migrations/webpage-published-version-2026-09.js, so after both have
 * run the fallback is unreachable — which is exactly why callers must LOG when
 * they take it. `fellBackToLive` is that signal; it is never true for an owner.
 *
 * This decision needs an explicit product confirmation before it ships; it is
 * pinned in stores/webpageStore.publishLifecycle.test.js so it cannot drift by
 * accident, in either direction.
 */
function resolveReadVersion(webpage, userId) {
    if (!webpage) return { versionId: null, fellBackToLive: false };
    if (webpage.userId === userId) return { versionId: null, fellBackToLive: false };
    const pinned = webpage.publishedVersionId || null;
    return { versionId: pinned, fellBackToLive: !pinned };
}

/**
 * canReadWebpage, widened by project membership.
 *
 * Async because the project role is a DB lookup, which is why this is a
 * separate function rather than a fourth argument: the sync predicate has
 * callers that cannot await, and they keep the old behaviour exactly.
 *
 * Additive, never a downgrade — a standalone page (project_id IS NULL) stays
 * strictly owner-or-published, and this is only ever consulted AFTER the sync
 * check has already said no. Read only: filing a page into a project does not
 * make project members its authors, so the write paths do not call this.
 * @param {string} userId
 */
async function canReadWebpageAsync(webpage, userId, userGroupIds = [], userOrgIds = []) {
    if (canReadWebpage(webpage, userId, userGroupIds, userOrgIds)) return true;
    if (!webpage?.projectId || !userId) return false;
    const { getProjectRole } = require('../../auth/projectAccess');
    return !!(await getProjectRole(userId, webpage.projectId));
}

module.exports = {
    getAccessibleWebpages,
    userHasAnyWebpageAccess,
    canReadWebpage,
    canWriteWebpage,
    canReadWebpageAsync,
    resolveReadVersion,
};
