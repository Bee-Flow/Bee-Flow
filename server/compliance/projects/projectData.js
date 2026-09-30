// @typecheck
'use strict';

/**
 * What every project check needs to read collaborative projects the same way.
 *
 * ORGANISATION. `projects.organization_id` is '' for a project of an org-less
 * account, while the Compliance Center files such an install under the org id
 * 'default' (routes/compliance/shared.js resolveOrgId; the scheduler always
 * sweeps it). `orgMatch()` therefore compares COALESCE(NULLIF(col, ''),
 * 'default') with the org asked: a real org sees exactly its own projects, the
 * 'default' bucket sees the org-less ones — the same reading
 * art32-dlp-efficacy.js gives that bucket.
 *
 * WHICH PROJECTS. Collaborative workspaces and the legacy rows nobody has
 * classified yet (`kind IS NULL`); a Studio Solution is not a place people
 * work together on content.
 *
 * NOT PROVISIONED. A table or column that does not exist on this install
 * (42P01 / 42703) means "this feature is not here", never "a count of zero
 * that proves something". Every other SQL error is a read that FAILED, and a
 * check must say so rather than pass.
 *
 * SUBJECTS AND EVIDENCE. A project is `{ id: 'project:<uuid>', label:
 * 'project:<first 8>' }`: a project's NAME can be a client's name, so it never
 * enters a subject, a detail line or the immutable evidence chain; the UI
 * resolves the live name from the id. Offender lists carry ids and counts.
 *
 * Only reads through SQL (layering: compliance may require platform, never
 * another feature such as server/projects/).
 */

const { projectPath } = require('../../utils/appPaths');

const NO_ORG_ORG_ID = 'default';
const NOT_PROVISIONED = new Set(['42P01', '42703']);
// Account states of a person who is still (becoming) a member: 'active', and
// the sign-up states (pending, unverified, waitlist). A NULL status predates
// the column and is active (auth/admin/orgAdminGuards.isActiveUserStatus).
// EVERY OTHER status means the person has LEFT — 'suspended' (billing),
// 'inactive' (the Nextcloud sync's soft delete, services/ncUserGroupSync.js)
// and whatever a later release adds. A list of the leaving states had to
// guess every one of them, and missed 'inactive', the one written most.
const PRESENT_STATUSES = Object.freeze(['active', 'pending', 'unverified', 'waitlist']);
// Offenders named in one evidence row. The counts beside them are exact.
const MAX_OFFENDERS = 50;
// Rows one project query may return — every query here is bounded.
const ROW_LIMIT = 5000;

/** SQL: `<col>` resolves to the org asked in parameter `$<n>`. */
function orgMatch(col, n = 1) {
    return `COALESCE(NULLIF(${col}, ''), '${NO_ORG_ORG_ID}') = $${n}`;
}

/** SQL: the project row `<alias>` is a collaborative workspace (or unclassified). */
function isWorkspace(alias = 'p') {
    return `(${alias}.kind IS NULL OR ${alias}.kind = 'workspace')`;
}

const PRESENT_STATUS_SQL = PRESENT_STATUSES.map(s => `'${s}'`).join(', ');

/** SQL: the account status `<col>` says the person has left (NULL is active). */
function hasLeft(col) {
    return `(${col} IS NOT NULL AND ${col} NOT IN (${PRESENT_STATUS_SQL}))`;
}

function isNotProvisioned(e) {
    return !!e && NOT_PROVISIONED.has(String(e.code || ''));
}

function projectSubject(projectId) {
    const id = String(projectId);
    return { id: `project:${id}`, label: `project:${id.slice(0, 8)}` };
}

/** The project id inside a subject id ('project:<id>' or a bare id). */
function projectIdOf(subjectId) {
    return String(subjectId || '').replace(/^project:/, '');
}

/** A short, non-identifying reference for a details line. */
function shortRef(projectId) {
    return `project:${String(projectId).slice(0, 8)}`;
}

function projectLink(projectId, section = null) {
    return projectPath(projectId, section);
}

/** The default reader: rows of one parameterised query. */
function defaultQuery() {
    return (sql, params) => require('../../db').getAll(sql, params);
}

/**
 * The org's workspace projects, newest activity first (bounded).
 * @returns {Promise<Array<{id: string, owner_id: string, updated_at: any}>>}
 */
async function listWorkspaceProjects(orgId, query, { limit = ROW_LIMIT } = {}) {
    return query(`
        SELECT p.id, p.owner_id, p.updated_at
        FROM projects p
        WHERE ${orgMatch('p.organization_id')} AND ${isWorkspace('p')}
        ORDER BY p.updated_at DESC, p.id
        LIMIT ${Math.max(1, Math.trunc(limit))}
    `, [orgId]);
}

async function countWorkspaceProjects(orgId, query) {
    const rows = await query(`
        SELECT COUNT(*)::int AS n FROM projects p
        WHERE ${orgMatch('p.organization_id')} AND ${isWorkspace('p')}
    `, [orgId]);
    return Number(rows?.[0]?.n) || 0;
}

/** "3 projects: project:1a2b3c4d, project:… and 1 more" — ids, never names. */
function nameOffenders(ids, max = 5) {
    const list = ids.slice(0, max).map(shortRef);
    const more = ids.length > max ? ` and ${ids.length - max} more` : '';
    return `${list.join(', ')}${more}`;
}

module.exports = {
    NO_ORG_ORG_ID,
    NOT_PROVISIONED,
    PRESENT_STATUSES,
    hasLeft,
    MAX_OFFENDERS,
    ROW_LIMIT,
    orgMatch,
    isWorkspace,
    isNotProvisioned,
    projectSubject,
    projectIdOf,
    shortRef,
    projectLink,
    defaultQuery,
    listWorkspaceProjects,
    countWorkspaceProjects,
    nameOffenders,
};
