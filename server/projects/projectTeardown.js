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
 *   2. detach      every SOFT reference (notebooks, automations, apps, pages,
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
 *
 * ── Solution stages ──
 * A UAT or PRD stage project, and a Dev project that still has stages, is
 * never torn down here: 409 `solution_has_stages`, before anything is folded
 * back or detached. The one exception is the commit of a `remove` deployment
 * (design 6.8), which passes `{ removal: { deploymentId } }`: valid while that
 * deployment is an active `remove` of exactly the stage project being torn
 * down. The same capability then lets the detachers clear the stage's items.
 * A Dev project's stages are removed or detached first; no capability covers it.
 */

'use strict';

const { storeError } = require('../stores/lib/managedParts');

/**
 * How a project relates to Solution stages, read uncached. `stageOf` is the
 * Solution a stage project belongs to (the project row, through `projects`,
 * the same store the teardown deletes through); `hasStages` says a Dev project
 * still has one. Only a Solution can: createStages fixes the Dev's kind to
 * 'solution', and setProjectKind refuses to change it while stages exist.
 *
 * @param {string} projectId
 * @param {{ getProject: (id: string) => Promise<any> }} [projects]
 * @returns {Promise<{ stageOf: string|null, hasStages: boolean }>}
 */
async function readStageBinding(projectId, projects = require('../stores/projectStore')) {
    const project = await projects.getProject(projectId);
    if (!project) return { stageOf: null, hasStages: false };
    if (project.stageOf) return { stageOf: project.stageOf, hasStages: false };
    if (project.kind !== 'solution') return { stageOf: null, hasStages: false };
    const { getOne } = require('../db');
    if (await getOne('SELECT 1 AS x FROM projects WHERE stage_of = $1 LIMIT 1', [projectId])) {
        return { stageOf: null, hasStages: true };
    }
    try {
        const row = await getOne('SELECT 1 AS x FROM solution_stages WHERE solution_id = $1 LIMIT 1', [projectId]);
        return { stageOf: null, hasStages: !!row };
    } catch (err) {
        // No stage table yet: no stage either.
        if (/** @type {any} */ (err)?.code !== '42P01') throw err;
        return { stageOf: null, hasStages: false };
    }
}

/**
 * Is `deploymentId` an active `remove` deployment of exactly this stage project?
 * @param {string} deploymentId
 * @param {string} stageProjectId
 */
async function isActiveRemoval(deploymentId, stageProjectId) {
    const stages = require('../stores/solutionStageStore');
    if (!(await stages.isActiveDeployment(deploymentId, stageProjectId))) return false;
    const deployment = await stages.getDeployment(deploymentId);
    return deployment?.kind === 'remove' && deployment.stageProjectId === stageProjectId;
}

/**
 * @param {{
 *   store?: { getProject: (id: string) => Promise<any>, deleteProject: (id: string) => Promise<boolean> },
 *   lifecycle?: { beforeProjectDeleted: (projectId: string) => Promise<any> },
 *   membership?: { detachableKinds: () => Array<{ section: string, clearProject: (projectId: string) => Promise<any> }> },
 *   removeFilesKb?: (project: any) => Promise<any>,
 *   log?: { warn: Function },
 *   stageBinding?: (projectId: string) => Promise<{ stageOf: string|null, hasStages: boolean }>,
 *   isActiveRemoval?: (deploymentId: string, stageProjectId: string) => Promise<boolean>,
 * }} [deps]
 */
function makeProjectTeardown(deps = {}) {
    const store = () => deps.store || require('../stores/projectStore');
    const lifecycle = () => deps.lifecycle || require('../core/projectContent/itemLifecycle');
    const membership = () => deps.membership || require('./membership');
    const removeFilesKb = deps.removeFilesKb || ((project) => require('./projectFiles').removeFilesKb(project));
    const log = deps.log || require('../telemetry/log');
    const stageBinding = deps.stageBinding || ((projectId) => readStageBinding(projectId, store()));
    const activeRemoval = deps.isActiveRemoval || isActiveRemoval;

    /**
     * Why this project may not be torn down, or null. A stage project only
     * under its own active `remove` deployment; a Dev project with stages never.
     * @param {string} projectId
     * @param {{ removal?: { deploymentId?: string }|null }} [opts]
     * @returns {Promise<Error|null>}
     */
    async function teardownRefusal(projectId, { removal = null } = {}) {
        const { stageOf, hasStages } = await stageBinding(projectId);
        if (stageOf) {
            const deploymentId = removal && typeof removal.deploymentId === 'string' ? removal.deploymentId : null;
            if (deploymentId && await activeRemoval(deploymentId, projectId)) return null;
            return storeError(409, 'solution_has_stages',
                'This project is a stage of a Solution. Remove the stage from the Solution instead.', { solutionId: stageOf });
        }
        if (hasStages) {
            return storeError(409, 'solution_has_stages',
                'This Solution has stages. Detach or remove them first.', { solutionId: projectId });
        }
        return null;
    }

    /**
     * Release every soft reference to a project that is about to be deleted.
     * Each store is tried on its own: one that is unavailable must not block
     * the delete and leave the project half-removed. The worst case of a miss
     * is an orphaned project_id, which the stores' own boot-time cleanup also
     * sweeps.
     * @param {string} projectId
     * @param {{ managedWrite?: { deploymentId?: string }|null }} [ctx]  a removal's capability, for a stage's items
     */
    async function detachResources(projectId, ctx = {}) {
        for (const { section, clearProject } of membership().detachableKinds()) {
            try { await clearProject(projectId, ctx); } catch (err) {
                log.warn(`[Projects] could not detach ${section} from ${projectId}:`, /** @type {Error} */ (err).message);
            }
        }
    }

    /**
     * Fold back, detach, delete, then remove the files base. Refuses a
     * Solution stage, or a Dev project with stages, before any of it (see the
     * header); `removal` is the capability of the stage's `remove` deployment.
     * @param {string} projectId
     * @param {{ removal?: { deploymentId?: string }|null }} [opts]
     * @returns {Promise<boolean>} whether the project row was deleted
     */
    async function deleteProject(projectId, { removal = null } = {}) {
        if (!projectId) return false;
        const refused = await teardownRefusal(projectId, { removal });
        if (refused) throw refused;
        try { await lifecycle().beforeProjectDeleted(projectId); } catch (err) {
            log.warn(`[Projects] could not fold back co-edited state of ${projectId}:`, /** @type {Error} */ (err).message);
        }
        await detachResources(projectId, removal ? { managedWrite: removal } : {});

        const project = await store().getProject(projectId);
        const ok = await store().deleteProject(projectId);
        if (ok && project?.filesKbId) {
            try { await removeFilesKb(project); } catch (err) {
                log.warn(`[Projects] could not remove the files base of deleted project ${projectId}:`, /** @type {Error} */ (err).message);
            }
        }
        return ok;
    }

    return { detachResources, deleteProject, teardownRefusal };
}

module.exports = { makeProjectTeardown, readStageBinding, isActiveRemoval };
