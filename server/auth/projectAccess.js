// @typecheck
/**
 * Project access resolution — the single entry point for "what may this user do
 * in this project?".
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * `projectStore.getProjectRole(userId, projectId, groupIds)` takes the caller's
 * group ids as a THIRD ARGUMENT THAT DEFAULTS TO `[]`. Forgetting it is silent
 * and it fails in the safe-looking direction — the user simply has no role — so
 * nothing crashes and nothing logs. Seven of nine call sites forgot it:
 *
 *   routes/ai/directChat.js        project instructions + KB silently not injected
 *   core/agentRuntime/chatStream.js  same, agent path
 *   routes/memory.js  (×5)         403 on a project the user really is a member of
 *
 * The effect was that sharing a project with a GROUP appeared to work in the
 * Projects UI (which passes the argument) while being inert everywhere else.
 *
 * So the argument is gone from the API surface. Every function here resolves
 * groups itself, fresh from the DB, via `resolveUserGroups` — deliberately not
 * from `req.session.user.groups`, which is stale until the user logs in again.
 * A group removal has to take effect immediately; that is the whole point of a
 * group-based revocation.
 *
 * `projectStore.getProjectRole` stays as the low-level primitive for callers
 * that already hold the group list (routes/projects.js resolves it once per
 * request and reuses it across the role ladder).
 *
 * ── Roles ───────────────────────────────────────────────────────────────────
 *
 *   owner   projects.owner_id — implicit, never a project_shares row
 *   editor  may write project content and post into shared threads
 *   viewer  read only
 *   null    no access (callers must treat this as 404, not 403 — see below)
 *
 * 404 vs 403: a user with no role must not be able to tell a project they
 * cannot see from one that does not exist, so `requireProjectRole` returns 404
 * for "no role" and 403 only for "role too low". This mirrors what
 * routes/projects.js already did before this module existed.
 *
 * No request schema lives here: this file declares no route and reads no
 * request. `req.body.projectId` below is a usage example.
 */

const projectStore = require('../stores/projectStore');
const { resolveUserGroups } = require('./audience');
const log = require('../telemetry/log');

const ARCHIVED_MESSAGE = 'This project is archived. Restore it to make changes.';

/** Ordering for the role ladder. Higher wins. */
const ROLE_ORDER = Object.freeze({ viewer: 0, editor: 1, owner: 2 });

/**
 * The user's effective role on a project, or null.
 *
 * Never throws: a failure to resolve is reported as "no role", because every
 * caller's safe default is to deny. Errors are logged, not swallowed silently —
 * a project that becomes invisible because the DB hiccuped should be visible in
 * the logs.
 *
 * @param {string} userId
 * @param {string} projectId
 * @returns {Promise<'owner'|'editor'|'viewer'|null>}
 */
async function getProjectRole(userId, projectId) {
    if (!userId || !projectId) return null;
    try {
        const groupIds = await resolveUserGroups(userId);
        return await projectStore.getProjectRole(userId, projectId, groupIds);
    } catch (err) {
        log.error('[ProjectAccess] role resolution failed:', err.message);
        return null;
    }
}

/**
 * Does the user hold at least `minRole` on the project?
 *
 * This is the function the non-Express callers want (directChat, chatStream,
 * notebooks, automations). It replaces `projectStore.userHasAccess`, whose
 * boolean answer conflated "is a member" with "may write" — which is how a
 * viewer ended up able to delete every memory in a project via routes/memory.js.
 *
 * @param {string} userId
 * @param {string} projectId
 * @param {'viewer'|'editor'|'owner'} [minRole='viewer']
 * @returns {Promise<boolean>}
 */
async function hasProjectRole(userId, projectId, minRole = 'viewer') {
    const role = await getProjectRole(userId, projectId);
    if (!role) return false;
    return ROLE_ORDER[role] >= ROLE_ORDER[minRole];
}

/**
 * Resolve a project id supplied by the client into one the caller may actually
 * use, or null.
 *
 * Chat requests carry `projectId` in the REQUEST BODY, so it is attacker-chosen.
 * The pattern that must be used everywhere downstream is:
 *
 *     const validProjectId = await resolveRequestedProject(userId, req.body.projectId);
 *     // ...then use validProjectId, NEVER req.body.projectId, from here on
 *
 * The bug this exists to prevent: directChat.js checked access, logged a warning
 * on failure, and then went on to pass the UNVALIDATED id to
 * `memoryStore.findRelevantMemories`, which drops its `user_id` filter whenever
 * a projectId is present. Any authenticated user could name any project UUID and
 * have that project's memories injected into their prompt.
 *
 * A Studio Solution (`kind: 'solution'`) resolves to null as well: chats are
 * filed into collaborative projects, never into a Solution, so its
 * instructions, knowledge and memories are not a chat's context and a new
 * conversation is not filed under it. A legacy project (kind null) still
 * resolves until its owner classifies it.
 *
 * @param {string} userId
 * @param {string|null|undefined} requestedProjectId
 * @param {'viewer'|'editor'|'owner'} [minRole='viewer']
 * @returns {Promise<{projectId: string, role: string, project: object}|null>}
 */
async function resolveRequestedProject(userId, requestedProjectId, minRole = 'viewer') {
    if (!userId || !requestedProjectId || typeof requestedProjectId !== 'string') return null;
    const role = await getProjectRole(userId, requestedProjectId);
    if (!role || ROLE_ORDER[role] < ROLE_ORDER[minRole]) {
        log.warn(`[ProjectAccess] user ${userId} denied '${minRole}' on project ${requestedProjectId}`);
        return null;
    }
    let project = null;
    try {
        project = await projectStore.getProject(requestedProjectId);
    } catch (err) {
        log.error('[ProjectAccess] project fetch failed:', err.message);
        return null;
    }
    if (!project) return null;
    if (project.kind === 'solution') {
        log.warn(`[ProjectAccess] project ${requestedProjectId} is a Solution; chats are not filed into it`);
        return null;
    }
    return { projectId: requestedProjectId, role, project };
}

/**
 * Express middleware enforcing a minimum role on `req.params[paramName]`.
 *
 * Sets `req.projectRole` for the handler. Returns 404 (not 403) when the user
 * has no role at all, so project existence is not probeable.
 *
 * An ARCHIVED project is read-only: after the role check, a gate of `editor`
 * or `owner` answers 409 `project_archived`. Viewer gates keep working, so an
 * archived project can still be read and followed. The routes that must work
 * on an archived project (restore, archive, delete) pass `{ allowArchived: true }`.
 * The project row is read once for that and left on `req.project`.
 *
 * @param {'viewer'|'editor'|'owner'} minRole
 * @param {string|{ paramName?: string, allowArchived?: boolean }} [options]
 *        a string is the param name (default 'id')
 */
function requireProjectRole(minRole, options = 'id') {
    const opts = typeof options === 'string' ? { paramName: options } : (options || {});
    const paramName = opts.paramName || 'id';
    const allowArchived = opts.allowArchived === true;
    const checksArchive = !allowArchived && ROLE_ORDER[minRole] >= ROLE_ORDER.editor;
    return async function requireProjectRoleMw(req, res, next) {
        try {
            const userId = req.session?.user?.id;
            if (!userId) return res.status(401).json({ error: 'Not authenticated' });
            const projectId = req.params?.[paramName];
            const role = await getProjectRole(userId, projectId);
            if (!role) return res.status(404).json({ error: 'Not found' });
            if (ROLE_ORDER[role] < ROLE_ORDER[minRole]) {
                return res.status(403).json({ error: 'Insufficient permissions' });
            }
            if (checksArchive || allowArchived) {
                const project = await projectStore.getProject(projectId);
                if (project) req.project = project;
                if (checksArchive && project?.archivedAt) {
                    return res.status(409).json({ error: ARCHIVED_MESSAGE, code: 'project_archived' });
                }
            }
            req.projectRole = role;
            next();
        } catch (err) {
            log.error('[ProjectAccess] role check failed:', err.message);
            res.status(500).json({ error: 'Access check failed' });
        }
    };
}

module.exports = {
    ARCHIVED_MESSAGE,
    ROLE_ORDER,
    getProjectRole,
    hasProjectRole,
    resolveRequestedProject,
    requireProjectRole,
};
