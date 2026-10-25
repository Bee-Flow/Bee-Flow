// @typecheck strict
/**
 * Filing a NEW meeting note into a project, at upload time.
 *
 * `POST /api/transcriptions` takes an optional `projectId`. Before a single
 * byte is transcribed, `resolve` decides whether the uploader may put a
 * meeting there:
 *
 *   no role on the project          404  (a project's existence is not probeable)
 *   viewer                          403  (adding content is an editor's act)
 *   a Studio Solution               409  KIND_NOT_ALLOWED (projects/membership.js)
 *   another organisation            409  project_org_mismatch: the note is
 *                                        stamped with, and encrypted under, the
 *                                        uploader's organisation, and a project
 *                                        holds only its own organisation's content
 *
 * `announce` then writes the activity row and the live `resource_added` event
 * once the note exists. It never throws: the upload has already been accepted
 * by then, and a missed audit row must not fail a recording.
 *
 * A factory, so a test hands in its own role lookup, project store and feed;
 * the default instance uses the real ones, required on first use.
 */

'use strict';

/**
 * @param {object} [deps]
 * @param {Function} [deps.getProjectRole]    (userId, projectId) => 'owner'|'editor'|'viewer'|null
 * @param {Function} [deps.getProject]        (id) => project | null
 * @param {typeof import('./membership')} [deps.membership]        projects/membership surface ({ isAllowedIn })
 * @param {Function} [deps.logActivity]       projectStore.logActivity
 * @param {Function} [deps.emitProjectEvent]  core/projectFeed.emitProjectEvent
 * @param {typeof import('../telemetry/log')} [deps.log]
 */
function makeMeetingFiling(deps = {}) {
    const getProjectRole = (/** @type {Parameters<typeof import('../auth/projectAccess').getProjectRole>} */ ...a) => (deps.getProjectRole || require('../auth/projectAccess').getProjectRole)(...a);
    /**
     * @param {string} id
     */
    const getProject = (id) => (deps.getProject || require('../stores/projectStore').getProject)(id);
    const membership = () => deps.membership || require('./membership');
    const logActivity = (/** @type {Parameters<typeof import('../stores/projectStore').logActivity>} */ ...a) => (deps.logActivity || require('../stores/projectStore').logActivity)(...a);
    const emitProjectEvent = (/** @type {Parameters<typeof import('../core/projectFeed').emitProjectEvent>} */ ...a) => (deps.emitProjectEvent || require('../core/projectFeed').emitProjectEvent)(...a);
    const log = () => deps.log || require('../telemetry/log');

    /**
     * @param {number} status
     * @param {string} code
     * @param {string} error
     * @returns {{ok: false, status: number, code: string, error: string}}
     */
    const refuse = (status, code, error) => ({ ok: false, status, code, error });

    /**
     * May `userId` (whose note will carry `orgId`) file a new meeting into
     * `projectId`?
     *
     * @returns {Promise<{ok: true, projectId: string} | {ok: false, status: number, code: string, error: string}>}
     * @param {string} userId
     * @param {string|null} orgId
     * @param {string} projectId
     */
    async function resolve(userId, orgId, projectId) {
        const role = await getProjectRole(userId, projectId);
        if (!role) return refuse(404, 'not_found', 'Not found');
        if (role !== 'editor' && role !== 'owner') {
            return refuse(403, 'forbidden', 'You can view this project, but only its editors can add meeting notes to it.');
        }
        const project = await getProject(projectId);
        if (!project) return refuse(404, 'not_found', 'Not found');
        if (!membership().isAllowedIn('meeting', project.kind ?? null)) {
            return refuse(409, 'KIND_NOT_ALLOWED', 'A Studio Solution holds no meeting notes. Add it to a project instead.');
        }
        if ((project.organizationId || '') !== (orgId || '')) {
            return refuse(409, 'project_org_mismatch', 'This project belongs to another organization, so your meeting note cannot be filed in it.');
        }
        return { ok: true, projectId: project.id || projectId };
    }

    /**
     * The activity row and the live event for a meeting note just filed. Never throws.
     * @param {string} projectId
     * @param {string} actorId
     * @param {string} meetingId
     */
    async function announce(projectId, actorId, meetingId) {
        const details = { targetType: 'meeting', targetId: meetingId };
        try {
            await logActivity(projectId, actorId, 'resource_added', details);
        } catch (err) {
            log().error('[Transcriptions] could not record the new meeting note in the project activity log:', /** @type {Error} */ (err).message);
        }
        try {
            await emitProjectEvent(projectId, {
                kind: 'resource_added', actorId, targetType: 'meeting', targetId: meetingId, payload: details,
            });
        } catch (err) {
            log().warn('[Transcriptions] project event for a new meeting note failed:', /** @type {Error} */ (err).message);
        }
    }

    return { resolve, announce };
}

/** @typedef {ReturnType<typeof makeMeetingFiling> & { makeMeetingFiling: typeof makeMeetingFiling }} MeetingFilingExports */

module.exports = makeMeetingFiling();
/** @type {MeetingFilingExports} */ (module.exports).makeMeetingFiling = makeMeetingFiling;
