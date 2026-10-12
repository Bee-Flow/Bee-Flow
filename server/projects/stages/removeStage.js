/**
 * The `remove` deployment kind (design 6.8): take a UAT or PRD stage down
 * for good, through the same admission, lock, approval gate and runner as a
 * release deployment.
 *
 *   PREPARE  every automation of the stage is switched off through
 *            goLive.deactivateCore (remote subscriptions revoked first), and
 *            every published app, page and agent is unpublished. Journaled
 *            with what was on, so a failure before the commit puts it back
 *            (compensate.js `deactivate` / `unpublish`).
 *   COMMIT   (status `committing`, so the capability holds) the parts are
 *            deleted with the deployment's capability. Tables are dropped
 *            with their rows only with `deleteData`; otherwise they stay with
 *            their data, owned by the run-as user, their reference-row lock
 *            lifted, and the teardown detaches them from the project (as it
 *            does knowledge bases). Then ONE transaction removes the
 *            solution_stages row, its bindings, variable values and stamps and
 *            moves the deployment to `converging`.
 *   FINISH   projectTeardown.deleteProject with `{ removal: { deploymentId } }`,
 *            the one capability that lets it tear a stage project down; the
 *            deployment is still active (`converging`) while it runs. The
 *            stage can then be created again (a new project).
 *
 * The deployment carries `deleteData` in its PLAN (hashed, acknowledged as
 * `stage.delete_data`, and in the approval's details).
 *
 * The commit is the point of no return: parts are deleted one store call at a
 * time, so nothing can bring them back. Every delete is journaled as `pending`
 * first, so a crash leaves a trace, and the commit is repeatable (a part that
 * is gone counts as removed). The runner therefore never compensates a remove
 * that began deleting (`removeStarted`): it finishes the commit forward, or
 * fails the row as `remove_incomplete`, and a new removal finishes the job.
 */

'use strict';

const log = require('../../telemetry/log');
const { stageLockSql } = require('../../stores/solutionStage/stages');
const { storesOf, makeJournal } = require('./prepare');
const { toConverging } = require('./commit');

const dep = (deps, name, load) => (deps && deps[name] !== undefined ? deps[name] : load());

/**
 * Does this remove deployment drop the stage's tables and knowledge bases with their data? Only the
 * PLAN says so: it is what was hashed, acknowledged and (in PRD) approved. The raw `settingsPatch`
 * of a request is never read here.
 */
function deletesData(deployment) {
    return !!(deployment && deployment.plan && deployment.plan.deleteData === true);
}

/** A part that is already gone is a part that is removed: a repeated commit must not stop on it. */
const isGone = (err) => !!err && (err.status === 404 || err.code === 'not_found' || err.code === 'datatable_not_found');

async function liveStamps(s, stage) {
    return [...(await s.blueprintStore.listStamps(stage.projectId)).values()].filter(st => !st.retiredAt);
}

/**
 * Switch the stage off: every automation deactivated, every app, page and agent unpublished.
 *
 * @param {{ deployment: object, stage: object }} input
 * @param {object} [deps]  stores (prepare.storesOf), `goLive`, `goLiveDeps`
 */
async function prepareRemove({ deployment, stage }, deps = {}) {
    const s = storesOf(deps);
    const goLive = dep(deps, 'goLive', () => require('../../automation/goLive'));
    const journal = makeJournal(s.stageStore, deployment.id, 'prepare');
    const managedWrite = { deploymentId: deployment.id };
    const runAs = stage.runAsUserId;
    let off = 0;
    for (const st of await liveStamps(s, stage)) {
        const row = { ref: st.ref, kind: st.kind, entityId: st.entityId };
        if (st.kind === 'automation') {
            const a = await s.automationStore.getAutomation(st.entityId);
            if (!a || !a.isActive) continue;
            const step = await journal.pending('deactivate', { ...row, before: { isActive: true } });
            await goLive.deactivateCore({ automation: a, actorId: runAs, deps: deps.goLiveDeps || {} });
            await step.done();
            off += 1;
        } else if (st.kind === 'app') {
            const app = await s.studioAppStore.getStudioApp(st.entityId);
            if (!app || !app.isPublished) continue;
            const step = await journal.pending('unpublish', { ...row, before: { isPublished: true } });
            await s.studioAppStore.setStudioAppAudience(st.entityId, runAs, { isPublished: false, managedWrite });
            await step.done();
            off += 1;
        } else if (st.kind === 'webpage') {
            const page = await s.webpageStore.getWebpageRaw(st.entityId);
            if (!page || !page.isPublished) continue;
            const step = await journal.pending('unpublish', { ...row, before: { isPublished: true } });
            await s.webpageStore.setWebpagePublished(st.entityId, false, runAs);
            await step.done();
            off += 1;
        } else if (st.kind === 'agent') {
            const agent = await s.agentStore.getAgent(st.entityId);
            if (!agent || agent.is_published !== true) continue;
            const step = await journal.pending('unpublish', { ...row, before: { isPublished: true } });
            await s.agentStore.setAgentPublished(st.entityId, false, runAs);
            await step.done();
            off += 1;
        }
    }
    return { switchedOff: off };
}

const REMOVABLE = Object.freeze(['automation', 'app', 'webpage', 'agent', 'skill', 'document', 'datatable', 'knowledge_base']);

/**
 * Did this removal's commit begin deleting? (A commit-phase step that is done or pending: a delete may have
 * landed before its journal row was marked done.) After that, compensation must not run.
 *
 * @param {{ deployment: object }} input
 * @param {object} [deps]
 */
async function removeStarted({ deployment }, deps = {}) {
    const s = storesOf(deps);
    const steps = await s.stageStore.listSteps(deployment.id, { phase: 'commit' });
    // A step that failed with an error refused before it deleted anything (a guard, a lock); one that
    // is still `pending` may have landed.
    return steps.some(st => st.status === 'pending' || st.status === 'done');
}

/** Delete (or, for data without `deleteData`, keep) one part of the stage. */
async function removePart(s, st, { stage, managedWrite, deleteData, deps }) {
    const runAs = stage.runAsUserId;
    const scope = () => s.datatableStore.orgScope(stage.organizationId);
    switch (st.kind) {
        case 'automation': await s.automationStore.deleteAutomation(st.entityId, { managedWrite }); return 'delete';
        case 'app': await s.studioAppStore.deleteStudioApp(st.entityId, runAs, { managedWrite }); return 'delete';
        case 'webpage': await s.webpageStore.deleteWebpage(st.entityId, runAs, { managedWrite }); return 'delete';
        case 'agent': await s.agentStore.deleteAgent(st.entityId, runAs, { managedWrite }); return 'delete';
        case 'skill': await s.skillStore.deleteSkill(st.entityId, runAs, false, { managedWrite }); return 'delete';
        case 'document': {
            await s.templates.clearTemplateSolution(st.entityId, stage.projectId, runAs, { managedWrite });
            await dep(deps, 'documentStore', () => require('../../stores/documentStore')).deleteDocument(st.entityId, runAs);
            return 'delete';
        }
        case 'datatable':
            if (deleteData) { await s.datatableDbStore.dropDatatable(st.entityId, scope(), { managedWrite }); return 'delete'; }
            // Kept with its data: a reference table's row lock belonged to the stage.
            await s.datatableStore.setReferenceFlag(st.entityId, scope(), false, { managedWrite });
            return 'detach';
        case 'knowledge_base':
            if (deleteData) { await s.kbStore.deleteKB(st.entityId, { managedWrite }); return 'delete'; }
            return 'detach';
        default:
            return 'skip';
    }
}

/** The stage's own rows: settings, bindings, variable values, stamps (one transaction, with the move to converging). */
async function deleteStageRows(client, s, stage) {
    if (typeof s.stageStore.removeStageRows === 'function') return s.stageStore.removeStageRows(client, stage.projectId);
    await client.query('DELETE FROM solution_bindings WHERE project_id = $1', [stage.projectId]);
    await client.query('DELETE FROM solution_variable_values WHERE project_id = $1', [stage.projectId]);
    await client.query('DELETE FROM project_solution_entities WHERE project_id = $1', [stage.projectId]);
    await client.query('DELETE FROM solution_stages WHERE project_id = $1', [stage.projectId]);
    return true;
}

/**
 * The commit of a removal: the parts go with the capability, then one
 * transaction removes the stage's rows and moves the deployment to `converging`.
 *
 * @param {{ deployment: object, stage: object }} input  the row is `committing`
 * @param {object} [deps]
 */
async function commitRemove({ deployment, stage }, deps = {}) {
    const s = storesOf(deps);
    const managedWrite = { deploymentId: deployment.id };
    const deleteData = deletesData(deployment);
    const journal = makeJournal(s.stageStore, deployment.id, 'commit');
    for (const st of await liveStamps(s, stage)) {
        if (!REMOVABLE.includes(st.kind)) continue;
        const row = { ref: st.ref, kind: st.kind, entityId: st.entityId };
        const step = await journal.pending('remove_part', row);
        let action;
        try {
            action = await removePart(s, st, { stage, managedWrite, deleteData, deps });
        } catch (err) {
            if (!isGone(err)) { await step.failed({ detail: { code: err && err.code ? String(err.code) : 'failed' } }).catch(() => {}); throw err; }
            action = 'delete';
        }
        await step.done({ detail: { action } });
    }
    return s.withTransaction(async (client) => {
        await client.query(`SET LOCAL lock_timeout = '5s'`);
        await client.query(stageLockSql, [stage.projectId]);
        await deleteStageRows(client, s, stage);
        return toConverging(client, s, deployment);
    });
}

/**
 * Tear the stage project down with the removal capability, then close the deployment.
 *
 * @param {{ deployment: object, stage: object }} input  the row is `converging`
 * @param {object} [deps]  `teardown` ({ deleteProject }), `emitProjectEvent`
 */
async function finishRemove({ deployment, stage }, deps = {}) {
    const s = storesOf(deps);
    const teardown = dep(deps, 'teardown', () => require('../projectTeardown').makeProjectTeardown());
    const removal = { deploymentId: deployment.id };
    let warnings = [];
    try {
        await teardown.deleteProject(stage.projectId, { removal });
    } catch (err) {
        // The stage's rows are gone already; a project left behind is reported, and a retry tears it down.
        warnings = [{ task: 'teardown', ref: null, code: err && err.code ? String(err.code) : 'failed' }];
        log.warn(`[stages/removeStage] teardown of ${stage.projectId} failed: ${err && err.message}`);
    }
    const emit = dep(deps, 'emitProjectEvent', () => require('../../core/projectFeed').emitProjectEvent);
    try {
        await emit(stage.solutionId, {
            kind: 'deployment.succeeded', actorId: deployment.requestedBy || null, targetType: 'deployment', targetId: deployment.id,
            payload: { deploymentId: deployment.id, kind: 'remove', stage: stage.stage, warnings: warnings.length },
        }, { label: 'Solution stages' });
    } catch { /* the feed is best-effort */ }
    const report = { warnings, attempts: 1 };
    const row = await s.stageStore.transitionDeployment(deployment.id, ['converging'], warnings.length ? 'succeeded_with_warnings' : 'succeeded', { report });
    return { deployment: row, report };
}

module.exports = { prepareRemove, commitRemove, finishRemove, removeStarted, deletesData, removePart };
