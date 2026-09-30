// @typecheck
/**
 * What happens to the project-bound state of a notebook or document when the
 * item leaves its project or is deleted.
 *
 * Three kinds of state hang off an item while it is filed in a project, each
 * owned elsewhere and each meaningless (or worse, readable by the wrong
 * people) once the item is gone from there:
 *
 *   co-editing state   core/collab           folded back into the item's own
 *                                            row (a version is kept), then deleted
 *   comment threads    projectCommentStore   sealed with the PROJECT's key and
 *                                            about the project's copy: removed
 *                                            with the item's membership
 *   content signal     contentPiiSignalStore the compliance scan's verdict, keyed
 *                                            to the project it was made in
 *
 *   foldBack(kind, id, reason)     write co-edited state back while the item is
 *                                  still filed where that state came from.
 *                                  Call it BEFORE a move that you know will go
 *                                  through: after the move the item is filed
 *                                  elsewhere and edits not yet written back
 *                                  are not written into it (core/collab
 *                                  lifecycle.detachDoc explains why)
 *   beforeMove({...})              foldBack, but only for a caller the stores
 *                                  will let move the item (its owner, or the
 *                                  project owner taking it out), so nobody
 *                                  else can close a co-editing session by
 *                                  asking for a move that is then refused
 *   leftProject(kind, id, from)    after the item left project `from`
 *   beforeDelete(kind, id, userId) foldBack before the owner deletes (a
 *                                  document: archives) the item
 *   deleted(kind, id)              after the item was deleted for good
 *   beforeProjectDeleted(id)       every co-edited item of a project, folded
 *                                  back before the project (and with it the
 *                                  co-editing state and threads) is deleted
 *
 * Every step is best-effort and independent: a failure is logged with ids
 * only, and never undoes or fails the move or delete that already happened.
 * `kind` is 'notebook' or 'document'; anything else is a no-op.
 */

'use strict';

const KINDS = Object.freeze(['notebook', 'document']);
/** The compliance scan's subject kind for each item kind (core/collab/resources SCAN_SUBJECT). */
const SIGNAL_SUBJECT = Object.freeze({ notebook: 'notebook_document', document: 'studio_document' });

/**
 * @param {{
 *   collab?: { detach: (kind: string, id: string, opts?: { reason?: string }) => Promise<any>,
 *     detachProject: (projectId: string) => Promise<any> },
 *   comments?: { deleteForTarget: Function, deleteForTargetInProject: Function },
 *   signals?: { deleteSignal: (subjectKind: string, subjectId: string) => Promise<any> },
 *   placement?: (kind: string, id: string) => Promise<{ projectId: string|null, ownerId: string|null }|null>,
 *   log?: { warn: Function },
 * }} [deps]
 */
function makeItemLifecycle(deps = {}) {
    const collab = () => deps.collab || require('../collab');
    const comments = () => deps.comments || require('../../stores/projectCommentStore');
    const signals = () => deps.signals || require('../../stores/contentPiiSignalStore');
    const placement = deps.placement || ((kind, id) => require('../collab/resources').makeResources().load(kind, id));
    const log = deps.log || require('../../telemetry/log');

    /** Run one step; a failure is logged (ids only) and answers `fallback`. */
    async function step(what, kind, id, fn, fallback = null) {
        try {
            return await fn();
        } catch (err) {
            log.warn(`[ItemLifecycle] ${what} failed for ${kind} ${id}: ${/** @type {Error} */ (err).message}`);
            return fallback;
        }
    }

    /** @param {string} kind @param {string} id @param {string} [reason] */
    async function foldBack(kind, id, reason = 'detached') {
        if (!KINDS.includes(kind) || !id) return 0;
        const r = await step('folding back co-edited state', kind, id, () => collab().detach(kind, id, { reason }));
        return Number(r && r.detached) || 0;
    }

    /**
     * Before PUT /api/projects/:id/resources moves an item: fold its
     * co-edited state back when the item is really leaving the project it is
     * filed in AND the caller is somebody the stores will let move it.
     *
     * @param {{ kind: string, id: string, userId: string, targetProjectId: string|null,
     *   fromProjectId: string, projectRole?: string }} move
     * @returns {Promise<{ projectId: string|null, ownerId: string|null }|null>}  where the item was
     */
    async function beforeMove({ kind, id, userId, targetProjectId, fromProjectId, projectRole }) {
        if (!KINDS.includes(kind) || !id) return null;
        const where = await step('reading where the item is filed', kind, id, () => placement(kind, id));
        if (!where || !where.projectId) return where || null;
        const leaving = targetProjectId ? where.projectId !== targetProjectId : where.projectId === fromProjectId;
        const mayMove = where.ownerId === userId
            || (!targetProjectId && projectRole === 'owner' && where.projectId === fromProjectId);
        if (leaving && mayMove) await foldBack(kind, id, 'detached');
        return where;
    }

    /**
     * Let go of the project-bound state of an item: its co-editing state
     * (folded back with `reason`), the comment threads `dropThreads` removes,
     * and its compliance content signal.
     * @param {string} kind @param {string} id @param {string} reason @param {() => Promise<any>} dropThreads
     */
    async function release(kind, id, reason, dropThreads) {
        await foldBack(kind, id, reason);
        const threads = await step('removing comment threads', kind, id, dropThreads, 0);
        await step('forgetting the content signal', kind, id, () => signals().deleteSignal(SIGNAL_SUBJECT[kind], id));
        return { threads: Number(threads) || 0 };
    }

    /**
     * The item is no longer filed in `projectId`: that project's threads go.
     * The fold-back is normally a no-op by now (beforeMove did it); this
     * catches a move that did not go through beforeMove.
     * @param {string} kind @param {string} id @param {string} projectId
     */
    async function leftProject(kind, id, projectId) {
        if (!KINDS.includes(kind) || !id || !projectId) return { threads: 0 };
        return release(kind, id, 'detached', () => comments().deleteForTargetInProject(projectId, kind, id));
    }

    /**
     * Before `userId` deletes the item (a document: archives it): fold its
     * co-edited state back into its row while the row can still take it (an
     * archived document is no longer project content, so afterwards nothing
     * would be written back). Only for the item's owner, the one the stores
     * let delete it.
     * @param {string} kind @param {string} id @param {string} userId
     */
    async function beforeDelete(kind, id, userId) {
        if (!KINDS.includes(kind) || !id || !userId) return 0;
        const where = await step('reading where the item is filed', kind, id, () => placement(kind, id));
        if (!where || !where.projectId || where.ownerId !== userId) return 0;
        return foldBack(kind, id, 'deleted');
    }

    /**
     * The item was deleted for good: every thread on it, in any project, goes.
     * @param {string} kind @param {string} id
     */
    async function deleted(kind, id) {
        if (!KINDS.includes(kind) || !id) return { threads: 0 };
        return release(kind, id, 'deleted', () => comments().deleteForTarget(kind, id));
    }

    /**
     * A project is about to be deleted: fold every co-edited notebook and
     * page back into its own row while it is still filed there (the
     * co-editing state, like the comment threads, is deleted with the
     * project, by the database).
     * @param {string} projectId
     */
    async function beforeProjectDeleted(projectId) {
        if (!projectId) return 0;
        const r = await step('folding back co-edited state', 'project', projectId, () => collab().detachProject(projectId));
        return Number(r && r.detached) || 0;
    }

    return { foldBack, beforeMove, leftProject, beforeDelete, deleted, beforeProjectDeleted };
}

const defaultLifecycle = makeItemLifecycle();

module.exports = {
    KINDS,
    SIGNAL_SUBJECT,
    makeItemLifecycle,
    ...defaultLifecycle,
};
