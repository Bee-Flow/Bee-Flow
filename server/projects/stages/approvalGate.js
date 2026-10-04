/**
 * The PRD approval gate of a deployment (design 6.6, D8, D9, D19).
 *
 * A deployment that needs approval (model.needsApproval) is admitted as
 * `awaiting_approval`, and `request` opens the approval for it:
 *
 *   1. createApproval with source 'deployment', the sentinel step id
 *      'stage.prd' (the approvals CHECK needs a non-null step id for a non-app
 *      source, D8), the deployment id, the PRD project, the Solution owner as
 *      owner, the requester, counts-and-names details, the deployment context
 *      and the stage chain of the stage's `approval_policy`; 7 days to decide.
 *   2. setApprovalId on the deployment row.
 *   3. the 'requested' audit row, as the app approval step writes one.
 *   4. approvalEvents.dispatchApprovalRequested: the project feed only, never
 *      an approval.requested trigger for this source.
 *   5. a bell (and card) for the FIRST stage's seats; the hand-over path of
 *      approvalService notifies the next stages.
 *
 * The decision reaches the deployment through the store
 * (solutionStageStore.recordDeploymentDecision), never through this module.
 *
 * `validatePolicy` is the deadlock guard: with four-eyes the requester (the
 * Solution owner) can never decide, so every stage of the chain needs a seat
 * that is not the owner (a group counts when it has another member).
 */

'use strict';

const { HttpError } = require('../../core/http/errors');
const log = require('../../telemetry/log');

const STEP_ID = 'stage.prd';
const DECIDE_WITHIN_MS = 7 * 24 * 60 * 60 * 1000;
const STAGE_LABEL = Object.freeze({ uat: 'UAT', prd: 'Production' });

const dep = (deps, name, load) => (deps && deps[name] !== undefined ? deps[name] : load());
const lifecycle = () => require('../../core/automationRunner/approvalLifecycle');
const stagesRules = () => require('../../automation/approvalStages');

function needsApprover(message, details = {}) {
    return new HttpError(400, 'approval_policy_needs_approver', message, details);
}

/**
 * The stage chain of a policy, checked: every seat in the organisation
 * (validateStages) and every active stage with a seat that is not the owner.
 *
 * @param {{ stages?: object[] }|object[]|null} policy
 * @param {{ orgId?: string|null, ownerId: string }} who
 * @param {object} [deps]  `{ validateStages, groupMemberIds }`
 * @returns {Promise<object[]>} the validated chain
 * @throws {HttpError} 400 approval_policy_needs_approver
 */
async function validatePolicy(policy, { orgId = null, ownerId } = /** @type {any} */ ({}), deps = {}) {
    const authored = Array.isArray(policy) ? { stages: policy } : (policy || {});
    const chain = stagesRules().desugarApprovalStages(authored);
    if (!chain) throw needsApprover('Production approval needs at least one approver who is not the Solution owner.');
    const validateStages = dep(deps, 'validateStages', () => lifecycle().validateStages);
    const groupMemberIds = dep(deps, 'groupMemberIds', () => lifecycle().groupMemberIds);
    const stages = await validateStages(chain, orgId, ownerId);
    if (!stages) throw needsApprover('Production approval needs at least one approver who is not the Solution owner.');
    for (const stage of stagesRules().activeStages(stages)) {
        let other = false;
        for (const seat of stage.approvers || []) {
            if (seat && seat.userId && seat.userId !== ownerId) { other = true; break; }
            if (seat && seat.groupId) {
                const { ids } = await groupMemberIds(seat.groupId);
                if ((ids || []).some(id => id !== ownerId)) { other = true; break; }
            }
        }
        if (!other) {
            throw needsApprover(`The approval stage "${stage.name || stage.key}" needs an approver who is not the Solution owner.`, { stageKey: stage.key });
        }
    }
    return stages;
}

function titleFor({ kind, releaseSeq, solutionName, stage, deleteData = false }) {
    const where = STAGE_LABEL[stage] || stage;
    if (kind === 'settings') return `Change the approval gate of ${solutionName} in ${where}`;
    if (kind === 'remove' && deleteData === true) return `Remove ${solutionName} from ${where} and delete its data`;
    if (kind === 'remove') return `Remove ${solutionName} from ${where}`;
    if (kind === 'rollback') return `Roll back ${solutionName} in ${where} to release ${releaseSeq}`;
    if (kind === 'redeploy') return `Apply the settings of ${solutionName} in ${where} (release ${releaseSeq})`;
    return `Deploy release ${releaseSeq} of ${solutionName} to ${where}`;
}

/** Counts and part names only: never values, rows or documents. */
function detailsFor(plan) {
    const p = plan || {};
    const lines = [];
    if (p.kind === 'remove' && p.deleteData === true) {
        lines.push('The stage\'s tables and knowledge bases are deleted with their data. This cannot be undone.', '');
    }
    const parts = Array.isArray(p.parts) ? p.parts : [];
    const byAction = {};
    for (const part of parts) byAction[part.action] = (byAction[part.action] || 0) + 1;
    for (const action of ['create', 'replace', 'revive', 'retire', 'unchanged']) {
        if (byAction[action]) lines.push(`- ${action}: ${byAction[action]}`);
    }
    const changed = parts.filter(x => ['create', 'replace', 'revive', 'retire'].includes(x.action) && x.name).slice(0, 20);
    if (changed.length) lines.push('', ...changed.map(x => `- ${x.action} ${x.kind} "${String(x.name).slice(0, 80)}"`));
    const retired = (Array.isArray(p.data) ? p.data : []).reduce((n, d) => n + ((d.retire || []).length), 0);
    if (retired) lines.push('', `Columns retired: ${retired}`);
    const acks = Array.isArray(p.acknowledgementsRequired) ? p.acknowledgementsRequired : [];
    if (acks.length) lines.push('', `Acknowledged by the requester: ${[...new Set(acks.map(a => a.code || a))].join(', ')}`);
    if (p.settingsPatch) lines.push(`Settings changed: ${Object.keys(p.settingsPatch).join(', ')}`);
    return lines.join('\n') || null;
}

/**
 * Open the approval of an `awaiting_approval` deployment.
 *
 * @param {{ deployment: object, stage: object, plan?: object, actor: { id: string } }} input
 *   `stage` is the solution_stages row (approvalPolicy, organizationId, runAsUserId, projectId)
 * @param {object} [deps]  automationStore (createApproval, appendApprovalAudit), solutionStageStore
 *   (setApprovalId), projectStore (getProject), approvalEvents, notifyApproval, panelRecipientIds,
 *   validateStages, groupMemberIds, now
 * @returns {Promise<object>} the approval row
 */
async function request({ deployment, stage, plan = null, actor } = /** @type {any} */ ({}), deps = {}) {
    if (!deployment || !deployment.id) throw new TypeError('approvalGate.request: a deployment is required');
    if (!stage || !stage.projectId) throw new TypeError('approvalGate.request: the stage row is required');
    const automationStore = dep(deps, 'automationStore', () => require('../../stores/automationStore'));
    const stageStore = dep(deps, 'solutionStageStore', () => require('../../stores/solutionStageStore'));
    const projectStore = dep(deps, 'projectStore', () => require('../../stores/projectStore'));
    const now = dep(deps, 'now', () => () => Date.now());

    const solution = await projectStore.getProject(deployment.solutionId || stage.solutionId);
    const ownerId = (solution && solution.ownerId) || stage.runAsUserId;
    const solutionName = (solution && solution.name) || 'the Solution';
    const stages = await validatePolicy(stage.approvalPolicy, { orgId: stage.organizationId || null, ownerId }, deps);
    const { firstStageKey, stageByKey, collectParticipants } = stagesRules();
    const firstKey = firstStageKey(stages);
    const first = stageByKey(stages, firstKey);
    const releaseSeq = deployment.releaseSeq ?? plan?.release?.seq ?? null;
    const title = titleFor({
        kind: deployment.kind, releaseSeq, solutionName, stage: deployment.stage || stage.stage,
        deleteData: (plan || deployment.plan)?.deleteData === true,
    });

    const approval = await automationStore.createApproval({
        source: 'deployment',
        stepId: STEP_ID,
        deploymentId: deployment.id,
        organizationId: stage.organizationId || null,
        projectId: stage.projectId,
        projectTitle: `${solutionName} · ${STAGE_LABEL[stage.stage] || stage.stage}`,
        automationTitle: title,
        ownerId,
        requestedBy: actor && actor.id ? actor.id : deployment.requestedBy,
        prompt: title,
        detailsMd: detailsFor(plan || deployment.plan),
        context: {
            deploymentId: deployment.id, planHash: deployment.planHash || plan?.planHash || null,
            releaseSeq, stageProjectId: stage.projectId,
            solutionId: deployment.solutionId || stage.solutionId,
        },
        approvers: first.approvers,
        approvalRule: first.rule || 'all',
        quorumCount: Number.isFinite(first.quorum) ? first.quorum : null,
        stages,
        stageParticipants: collectParticipants(stages),
        stageKey: firstKey,
        expiresAt: new Date(now() + DECIDE_WITHIN_MS).toISOString(),
    });
    if (!approval) throw new Error('The approval of this deployment could not be created.');

    await stageStore.setApprovalId(deployment.id, approval.id);
    try {
        await automationStore.appendApprovalAudit({
            approvalId: approval.id, runId: null, stepId: STEP_ID,
            decidedBy: actor && actor.id ? actor.id : null, decision: 'requested', source: 'deployment',
        });
    } catch (err) {
        log.warn(`[SolutionStages] approval audit for ${deployment.id} failed: ${err.message}`);
    }
    try {
        dep(deps, 'approvalEvents', () => require('../../automation/approvalEvents')).dispatchApprovalRequested(approval);
    } catch (err) {
        log.warn(`[SolutionStages] approval event for ${deployment.id} failed: ${err.message}`);
    }
    try {
        const recipients = await dep(deps, 'panelRecipientIds', () => lifecycle().panelRecipientIds)(first.approvers);
        const notify = dep(deps, 'notifyApproval', () => require('../../automation/approvalNotify').notifyApproval);
        await notify({ approval, recipientIds: recipients, title: `Approval needed: ${title}`, message: title });
    } catch (err) {
        log.warn(`[SolutionStages] approval notification for ${deployment.id} failed: ${err.message}`);
    }
    return approval;
}

/**
 * Where a deployment's approval stands: 'not_required' (it never had one),
 * 'requested' (awaiting, the approval not created yet), or the approval's own
 * status (pending | approved | rejected | expired | cancelled | withdrawn),
 * 'missing' when the row is gone.
 *
 * @returns {Promise<{ state: string, approvalId: string|null, decidedBy?: string|null, decidedAt?: string|null }>}
 */
async function approvalStateFor(deployment, deps = {}) {
    if (!deployment) return { state: 'not_required', approvalId: null };
    if (!deployment.approvalId) {
        return { state: deployment.status === 'awaiting_approval' ? 'requested' : 'not_required', approvalId: null };
    }
    const automationStore = dep(deps, 'automationStore', () => require('../../stores/automationStore'));
    const approval = await automationStore.getApproval(deployment.approvalId);
    if (!approval) return { state: 'missing', approvalId: deployment.approvalId };
    return {
        state: approval.status || 'pending',
        approvalId: approval.id,
        decidedBy: approval.decidedBy ?? null,
        decidedAt: approval.decidedAt ?? null,
    };
}

module.exports = { request, approvalStateFor, validatePolicy, titleFor, detailsFor, STEP_ID };
