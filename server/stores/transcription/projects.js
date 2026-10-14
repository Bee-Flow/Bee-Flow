// @typecheck
/**
 * Meeting notes as project content (projects/membership.js, kind 'meeting'):
 * filing, detaching, the project's card listing and counts, and the detach
 * sweep after a project delete.
 */

const { run, getOne, getAll } = require('../../db');
const { initDB } = require('./schema');
const { parseJsonArray } = require('./jsonArrays');

// ── Project membership ───────────────────────────────────

/**
 * File a meeting note into a project (projects/membership.js, kind 'meeting').
 *
 * Owner-only: filing makes the note readable to every member of the project,
 * and that is the owner's call. The route checks the caller's role on the
 * TARGET project; the statement checks the rest with no gap before the write:
 * the caller owns the note, and the project exists in the note's own
 * organisation (an empty organisation matches only an empty one).
 * `updated_at` is left alone on purpose: filing is not an edit, and a
 * knowledge source that follows a meeting tag re-reads notes by it.
 *
 * A note in a project belongs to the project's members, all of them and only
 * them: it cannot also be shared another way. So a note that is already shared
 * (published to the organisation or to groups, or shared with people) is
 * refused with a 409 that says so, rather than quietly widening or replacing
 * who can read it. (The publish route refuses the other direction: a filed
 * note cannot be published.)
 */
async function setTranscriptionProject(id, userId, projectId, callerOrgIds = []) {
    await initDB();
    if (!id || !userId || !projectId) return false;
    const held = await getOne('SELECT is_published, shared_groups, shared_with FROM transcriptions WHERE id = $1 AND user_id = $2', [id, userId]);
    if (held && (held.is_published === true || parseJsonArray(held.shared_groups).length > 0 || parseJsonArray(held.shared_with).length > 0)) {
        throw Object.assign(
            new Error('This meeting note is already shared another way. Make it personal first, then add it to the project: a note in a project is open to the whole project, and to nobody else.'),
            { status: 409, code: 'MEETING_ALREADY_SHARED' },
        );
    }
    const { rowCount } = await run(
        `UPDATE transcriptions t SET project_id = $1
          WHERE t.id = $2 AND t.user_id = $3
            AND EXISTS (SELECT 1 FROM projects p
                         WHERE p.id = $1 AND (COALESCE(p.organization_id, '') = COALESCE(t.organization_id, '')
                            OR (COALESCE(t.organization_id, '') = '' AND p.organization_id = ANY($4::text[]))))`,
        [projectId, id, userId, [...callerOrgIds]]
    );
    return (rowCount || 0) > 0;
}

/**
 * Take a meeting note out of ONE project. With `userId`, only when that person
 * owns it; with null, whoever owns it, which projects/membership.js allows only
 * the owner of that project. Scoped to `projectId` either way.
 */
async function detachTranscriptionFromProject(id, projectId, userId = null) {
    await initDB();
    if (!id || !projectId) return false;
    const { rowCount } = await run(
        `UPDATE transcriptions SET project_id = NULL
          WHERE id = $1 AND project_id = $2 AND ($3::text IS NULL OR user_id = $3)`,
        [id, projectId, userId]
    );
    return (rowCount || 0) > 0;
}

/**
 * The meeting notes filed into a project, as cards: what a list row shows and
 * nothing it does not. No transcript, summary or snippet leaves here: those
 * are the note's content, read through getTranscription when someone opens it.
 */
async function listProjectMeetings(projectId, { limit = 100, offset = 0 } = {}) {
    await initDB();
    if (!projectId) return [];
    const rows = await getAll(
        `SELECT id, title, user_id, project_id, status, duration_seconds, created_at, updated_at,
                COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(action_items) = 'array' THEN action_items ELSE '[]'::jsonb END), 0)::int AS action_item_count
           FROM transcriptions
          WHERE project_id = $1
          ORDER BY created_at DESC, id
          LIMIT $2 OFFSET $3`,
        [projectId, Math.min(Math.max(Number(limit) || 100, 1), 200), Math.max(Number(offset) || 0, 0)]
    );
    return rows.map(r => ({
        id: r.id,
        title: r.title,
        userId: r.user_id,
        projectId: r.project_id || null,
        status: r.status || 'completed',
        durationSeconds: Number(r.duration_seconds) || 0,
        actionItemCount: Number(r.action_item_count) || 0,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    }));
}

/**
 * How many meeting notes each of these projects holds, in ONE query. Missing
 * from the map means none; a failed read rejects.
 */
async function countProjectMeetings(projectIds) {
    await initDB();
    const ids = (Array.isArray(projectIds) ? projectIds : []).filter(id => typeof id === 'string' && id);
    if (!ids.length) return new Map();
    const rows = await getAll(
        `SELECT project_id, COUNT(*)::int AS n FROM transcriptions
          WHERE project_id = ANY($1::text[]) GROUP BY project_id`,
        [ids]
    );
    return new Map(rows.map(r => [r.project_id, Number(r.n) || 0]));
}

/** Detach every meeting note from a deleted project; the notes stay their owners'. */
async function clearProjectFromTranscriptions(projectId) {
    await initDB();
    if (!projectId) return 0;
    const { rowCount } = await run('UPDATE transcriptions SET project_id = NULL WHERE project_id = $1', [projectId]);
    return rowCount || 0;
}

module.exports = {
    setTranscriptionProject,
    detachTranscriptionFromProject,
    listProjectMeetings,
    countProjectMeetings,
    clearProjectFromTranscriptions,
};
