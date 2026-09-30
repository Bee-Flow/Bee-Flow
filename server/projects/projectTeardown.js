// @typecheck
/**
 * Deleting a project without losing what its members did in it, whoever asks
 * for the delete: the owner through `DELETE /api/projects/:id`, or account
 * erasure for every project the erased person owned (stores/user/projectErasure.js).
 *
 * The order is the point, and both callers need the same one:
 *
 *   1. fold back   co-edited state of every notebook or page filed here is
 *                  written into the item's own row while the item is still
 *                  filed here (core/projectContent/itemLifecycle). The
 *                  co-editing log cascades with the project row, so edits not
 *                  yet materialised would otherwise be gone for good, and
 *                  those items are usually other members' work.
 *   2. detach      every SOFT reference (notebooks, routines, apps, pages,
 *                  tables, agents, meetings) is cleared, so the item survives
 *                  standalone instead of pointing at nothing
 *                  (projects/membership.js `detachableKinds`)
 *   3. delete      the project row; shares, activity, team chats, comment
 *                  threads and co-editing state cascade
 *   4. files base  the project's own knowledge base of uploaded files is
 *                  removed after the delete went through: nobody can reach it
 *                  any more, so keeping it is personal data kept for no purpose
 *
 * A conversation SHARED into the project blocks step 3 (the schema forbids a
 * shared conversation without a project). Checking for that first is the
 * caller's decision: the route answers with the chats and their owners, and
 * account erasure keeps that one project. `deleteProject` rethrows what the
 * store's DELETE throws so each caller can tell that refusal apart.
 *
 * Steps 1, 2 and 4 are best-effort: a failure is logged with ids only and
 * never stops the delete.
 */

'use strict';

/**
 * @param {{
 *   store?: { getProject: (id: string) => Promise<any>, deleteProject: (id: string) => Promise<boolean> },
 *   lifecycle?: { beforeProjectDeleted: (projectId: string) => Promise<any> },
 *   membership?: { detachableKinds: () => Array<{ section: string, clearProject: (projectId: string) => Promise<any> }> },
 *   removeFilesKb?: (project: any) => Promise<any>,
 *   log?: { warn: Function },
 * }} [deps]
 */
function makeProjectTeardown(deps = {}) {
    const store = () => deps.store || require('../stores/projectStore');
    const lifecycle = () => deps.lifecycle || require('../core/projectContent/itemLifecycle');
    const membership = () => deps.membership || require('./membership');
    const removeFilesKb = deps.removeFilesKb || ((project) => require('./projectFiles').removeFilesKb(project));
    const log = deps.log || require('../telemetry/log');

    /**
     * Release every soft reference to a project that is about to be deleted.
     * Each store is tried on its own: one that is unavailable must not block
     * the delete and leave the project half-removed. The worst case of a miss
     * is an orphaned project_id, which the stores' own boot-time cleanup also
     * sweeps.
     * @param {string} projectId
     */
    async function detachResources(projectId) {
        for (const { section, clearProject } of membership().detachableKinds()) {
            try { await clearProject(projectId); } catch (err) {
                log.warn(`[Projects] could not detach ${section} from ${projectId}:`, /** @type {Error} */ (err).message);
            }
        }
    }

    /**
     * Fold back, detach, delete, then remove the files base.
     * @param {string} projectId
     * @returns {Promise<boolean>} whether the project row was deleted
     */
    async function deleteProject(projectId) {
        if (!projectId) return false;
        try { await lifecycle().beforeProjectDeleted(projectId); } catch (err) {
            log.warn(`[Projects] could not fold back co-edited state of ${projectId}:`, /** @type {Error} */ (err).message);
        }
        await detachResources(projectId);

        const project = await store().getProject(projectId);
        const ok = await store().deleteProject(projectId);
        if (ok && project?.filesKbId) {
            try { await removeFilesKb(project); } catch (err) {
                log.warn(`[Projects] could not remove the files base of deleted project ${projectId}:`, /** @type {Error} */ (err).message);
            }
        }
        return ok;
    }

    return { detachResources, deleteProject };
}

module.exports = { makeProjectTeardown };
