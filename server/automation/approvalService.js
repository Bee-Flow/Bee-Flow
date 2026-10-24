// @typecheck
/**
 * approvalService — the ONE place an approval decision happens.
 *
 * Two routes accept decisions (the legacy POST /runs/:runId/approve-step and
 * the Approvals section's POST /approvals/:id/decide); both delegate here so
 * the rules cannot fork: reason required on reject, answers coerced against
 * the SNAPSHOTTED fields (never the live definition — the approver decided on
 * what they saw), one decision ever (conditional UPDATE), and the run resumed
 * exactly as the legacy path did.
 *
 * Identity: the resumed run continues under the OWNER's identity, credentials
 * and quotas — resumeFromStep re-enters executeAutomation with the automation
 * row, whoever decided. The decider is RECORDED (approval.decided_by, the
 * audit event, steps.<id>.output.by), never impersonated. An org admin
 * approving a colleague's automation is authorising the owner's own automation
 * to continue, not running anything as themselves.
 */

const automationStore = require('../stores/automationStore');
const log = require('../telemetry/log');
// The rulebook (pure), the decision write and the vote engine live beside
// this file; decide and withdraw below are the only entry points.
const {
    isRunless, isOwnDeploymentRequest, hasPanel, isSeatedOnPanel, isFinalApprover, hasStages, currentStage,
    isSeatedInStage, isChainParticipant, evaluateStage, seatIndexFor, evaluatePanel, mergeVoteAnswers, voteSummary,
    panelProgress, canDecide, canView,
} = require('./approvalRulebook');
const { outcome, recordDeploymentOutcome, userDisplayName, deciderName, finalizeDecision } = require('./approvalDecision');
const { castStageVote, castPanelVote, nextStageRemindAt } = require('./approvalVotes');
const { fallback, bestEffort } = require('../utils/bestEffort');

/**
 * Lazy backfill: a run paused before the approvals table existed (or whose
 * row failed to write) still needs a row the moment anything touches it.
 * The rendered prompt is recoverable from the awaiting step row's recorded
 * output; the rich extras are not — a backfilled row is plain by nature.
 */
async function ensureApprovalForRun(run, automation) {
    // NOT licence-gated, deliberately — and gating it would break the drain.
    //
    // This never originates work: the first line returns null unless the run
    // is ALREADY parked at an approval step, which only happens after
    // execApproval's Enterprise check passed (or on a row that predates it).
    // All it does is materialise the record for a pause that already
    // happened. Its three callers are the gated list route and the two
    // deliberately-ungated approve-step paths — and those approve-step paths
    // call it to MATERIALISE THE ROW THEY THEN DECIDE. A capability check here
    // would therefore make an unlicensed org unable to finish a run it paused
    // while licensed: exactly the stranding the asymmetric gate exists to
    // prevent. The gate belongs at the mint sites (engine execApproval,
    // appStudio requestApprovalStep), not here.
    if (!run?.awaitingStepId) return null;
    const existing = await automationStore.getApprovalForRunStep(run.id, run.awaitingStepId, { pendingOnly: true });
    if (existing) return existing;
    let prompt = '';
    try {
        const steps = await automationStore.getRunSteps(run.id);
        const awaiting = (steps || []).find(s => s.stepId === run.awaitingStepId && s.status === 'awaiting_approval');
        prompt = awaiting?.output?.prompt || '';
    } catch (err) { fallback('automation/approvalService:ensureApprovalForRun', err); /* plain row without the question beats no row */ }
    let organizationId = automation?.organizationId || null;
    if (!organizationId) {
        try {
            const userStore = require('../stores/userStore');
            organizationId = (await userStore.getUser(run.userId))?.organizationId || null;
        } catch (err) { fallback('automation/approvalService:ensureApprovalForRun#2', err); /* consumer account */ }
    }
    const project = await require('./approvalProject').projectStamp(automation?.projectId);
    const row = await automationStore.createApproval({
        organizationId,
        automationId: run.automationId,
        automationTitle: automation?.title || '',
        ...project,
        runId: run.id,
        rootRunId: run.rootRunId || run.id,
        stepId: run.awaitingStepId,
        ownerId: run.userId,
        prompt,
        expiresAt: run.awaitingStepExpiresAt || null,
    });
    if (row) {
        await automationStore.appendApprovalAudit({
            approvalId: row.id, runId: run.id, stepId: run.awaitingStepId,
            decidedBy: null, decision: 'requested', source: 'backfill',
        }).catch((e) => bestEffort('automation/approvalService:ensureApprovalForRun#3', e));
    }
    return row;
}

/**
 * Can `viewer` decide this approval? Owner, the assignee, a member of the
 * assigned group, or an org admin of the approval's org. `viewer` is what the
 * route already proved: { userId, groupIds: [String], isOrgAdminOfOrg(orgId) }.
 */

/**
 * The decision. `approval` is the pending row (already authz-checked by the
 * caller via canDecide); `run` is the actionable leg (resolveActionableRun).
 * Returns {code, body} ready for res.status(code).json(body).
 */
async function decide({ approval, run, deciderId, decision, reason = null, answers = null, source = 'studio' }) {
    if (!approval) return outcome(404, { error: 'Approval not found' });
    if (approval.status !== 'pending') {
        return outcome(409, { error: `This approval was already ${approval.status}.`, status: approval.status });
    }
    // Four-eyes, enforced here as well as in canDecide: the Nextcloud
    // reaction path checks seats, not canDecide, and reaches decide directly.
    if (isOwnDeploymentRequest(approval, deciderId)) {
        return outcome(403, { error: 'You requested this deployment, so someone else has to decide it.' });
    }
    // Deadline: expired approvals refuse the decision and flip the row so the
    // list agrees with the refusal the caller just saw.
    if (approval.expiresAt && new Date(approval.expiresAt).getTime() < Date.now()) {
        const flipped = await automationStore.decideApproval(approval.id, { status: 'expired', decidedBy: null });
        await automationStore.appendApprovalAudit({
            approvalId: approval.id, runId: approval.runId, stepId: approval.stepId,
            decidedBy: null, decision: 'expired', source,
        }).catch((e) => bestEffort('automation/approvalService:decide', e));
        if (flipped) {
            require('./approvalEvents').dispatchApprovalDecided(flipped);
            await require('./approvalHooks').runOnDecidedHook(flipped);
            await recordDeploymentOutcome(flipped);
        }
        return outcome(410, { error: 'Approval window expired.', error_class: 'ApprovalExpired' });
    }
    if (decision !== 'approve' && decision !== 'reject') {
        return outcome(400, { error: 'decision must be "approve" or "reject"' });
    }
    // A rejection stops the run outright, so it is the one decision that must
    // carry its reason — "why did this never go out?" is asked weeks later by
    // someone who was not in the room.
    //
    // NOT on source 'builder'. That is the legacy owner-scoped
    // POST /runs/:runId/approve-step (routes/automation/webhooksAndRunOps.js),
    // which has accepted reason-less rejections since it shipped, and the
    // clients calling it are BROWSERS THAT ARE ALREADY RUNNING. Two of the
    // three Reject controls in the previously-released SPA send no reason at
    // all — ExecutionsTable's ⋯ menu and ExecutionView both call
    // approveStep(id, 'reject') with no third argument, and ApprovalActionBar
    // sends undefined when its optional box is empty. Enforcing this on that
    // endpoint 400s every one of them until the user happens to hard-reload,
    // which is a breaking API change wearing the clothes of a validation fix.
    //
    // So the rule holds where the contract is new — 'studio', the Approvals
    // panel, whose UI has always required the field — and the legacy endpoint
    // keeps the contract it shipped with. ('nextcloud' only ever approves.)
    const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
    if (decision === 'reject' && !trimmedReason && source !== 'builder') {
        return outcome(400, { error: 'A reason is required to reject.', field: 'reason' });
    }
    // Answers: coerced against the SNAPSHOT. Only meaningful on approve — a
    // rejected run never resumes, so nothing would ever read them.
    let coercedAnswers = null;
    if (decision === 'approve' && Array.isArray(approval.fields) && approval.fields.length) {
        const { coerceSubmission } = require('./formTriggerContract');
        const { values, errors } = coerceSubmission(approval.fields, answers || {});
        if (errors.length) {
            return outcome(400, { error: 'Some answers need attention.', fieldErrors: errors });
        }
        coercedAnswers = values;
    }

    // Run guard — for RUN-sourced approvals only. A run-less approval (app or
    // deployment) has no run by design: the decision itself is the outcome
    // (recorded on the row, delivered via the on_decided hook, the
    // approval.decided event, or the deployment it guards).
    const runless = isRunless(approval);
    if (!runless && (!run || run.status !== 'awaiting_approval' || !run.awaitingStepId)) {
        // The run moved on without us (cancelled, decided elsewhere pre-table,
        // deleted). Close the row so the list stops advertising a decision
        // nobody can make.
        const closed = await automationStore.decideApproval(approval.id, {
            status: 'cancelled', decidedBy: null,
            reason: 'The run is no longer waiting for this approval.',
        });
        if (closed) require('./approvalEvents').dispatchApprovalDecided(closed);
        return outcome(409, { error: `Run is not awaiting approval.` });
    }

    // ── Panel rows: a decision is a VOTE until the rule resolves ─────────
    // The guards above (pending, deadline, reject-needs-reason, answers
    // against the snapshot, run still waiting) apply to every vote; what
    // changes is that the row only flips when the RULE says so.
    if (hasStages(approval)) {
        return castStageVote({ approval, run, deciderId, decision, trimmedReason, coercedAnswers, source });
    }
    if (Array.isArray(approval.approvers) && approval.approvers.length) {
        return castPanelVote({ approval, run, deciderId, decision, trimmedReason, coercedAnswers, source });
    }

    return finalizeDecision({ approval, run, deciderId, decision, trimmedReason, coercedAnswers, source });
}

/**
 * Withdraw a pending approval — the requester's (or an org admin's) "never
 * mind". Authz is the ROUTE's job (owner ∨ org admin — deliberately narrower
 * than canDecide: an assignee declines, they don't withdraw); this handles
 * the state machine. Run-sourced rows also close their paused run: a run
 * whose question was withdrawn must not sit awaiting an answer that can
 * never come.
 */
async function withdraw({ approval, deciderId, reason = null, source = 'studio' }) {
    if (!approval) return outcome(404, { error: 'Approval not found' });
    if (approval.status !== 'pending') {
        return outcome(409, { error: `This approval was already ${approval.status}.`, status: approval.status });
    }
    const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
    const decidedByName = await deciderName(deciderId);

    // Same conditional write as a decision — a withdraw racing an approve
    // loses cleanly (409) instead of cancelling a decided row.
    const cancelled = await automationStore.decideApproval(approval.id, {
        status: 'cancelled',
        decidedBy: deciderId,
        decidedByName,
        reason: trimmedReason || 'Withdrawn before a decision was made.',
    });
    if (!cancelled) {
        const fresh = await automationStore.getApproval(approval.id);
        return outcome(409, { error: `This approval was already ${fresh?.status || 'decided'}.`, status: fresh?.status });
    }
    await automationStore.appendApprovalAudit({
        approvalId: approval.id, runId: approval.runId, stepId: approval.stepId,
        decidedBy: deciderId, decision: 'cancelled',
        comment: trimmedReason || null, source,
    }).catch((e) => bestEffort('automation/approvalService:withdraw', e));
    require('./approvalEvents').dispatchApprovalDecided(cancelled);
    await require('./approvalHooks').runOnDecidedHook(cancelled);
    // A withdrawn deployment gate cancels the deployment it guarded.
    await recordDeploymentOutcome(cancelled);

    // Close the paused run — it is the withdrawn question's mechanism.
    if (approval.runId) {
        const run = await automationStore.getRun(approval.runId).catch((e) => fallback('automation/approvalService:withdraw#2', e, null));
        if (run && run.status === 'awaiting_approval' && run.awaitingStepId === approval.stepId) {
            await automationStore.updateRun(run.id, {
                status: 'cancelled',
                summary: 'Approval withdrawn — the run was closed without a decision.',
                finishedAt: new Date().toISOString(),
                awaitingStepId: null,
                approvalToken: null,
            }).catch((e) => bestEffort('automation/approvalService:withdraw#3', e));
        }
    }

    // Tell the people who were asked (and the owner, when an admin withdrew).
    try {
        const recipients = new Set();
        if (cancelled.assigneeUserId) recipients.add(cancelled.assigneeUserId);
        else if (cancelled.assigneeGroupId) {
            const { groupMemberIds } = require('../core/automationRunner/approvalLifecycle');
            for (const id of (await groupMemberIds(cancelled.assigneeGroupId)).ids) recipients.add(id);
        }
        if (deciderId !== cancelled.ownerId) recipients.add(cancelled.ownerId);
        recipients.delete(deciderId);
        // card:false — the request is gone; a card whose 👍 decides nothing
        // would be worse than no card.
        const { notifyApproval, automationForApproval } = require('./approvalNotify');
        await notifyApproval({
            approval: cancelled,
            automation: await automationForApproval(cancelled),
            recipientIds: [...recipients],
            category: 'info',
            title: `↩️ Approval withdrawn: ${cancelled.automationTitle || 'approval request'}`,
            message: trimmedReason || cancelled.prompt || 'The request was withdrawn before a decision.',
            card: false,
        }).catch((e) => bestEffort('automation/approvalService:withdraw#4', e));
    } catch (e) {
        log.warn(`[approvalService] withdraw notify failed: ${e.message}`);
    }

    return outcome(200, { accepted: true, approval: cancelled });
}

/**
 * Save-time org check for every approval assignee in a definition. validate.js
 * is pure/DB-free, so shape lives there and MEMBERSHIP lives here: an
 * assignee outside the owner's org is a validation error at save, not a
 * silent runtime fallback. Returns [] when everything checks out; errors are
 * `{path, message}` rows shaped like validateDefinition's own.
 */
async function validateApprovalAssignees(definition, ownerId) {
    const steps = [];
    const walk = (list) => {
        for (const s of Array.isArray(list) ? list : []) {
            if (s?.type === 'approval' && s.approval?.assignee) steps.push(s);
            if (Array.isArray(s?.body)) walk(s.body);
            if (Array.isArray(s?.branches)) for (const b of s.branches) walk(b);
        }
    };
    walk(definition?.steps);
    if (!steps.length) return [];

    const userStore = require('../stores/userStore');
    const { isMemberOfOrg } = require('../auth/orgMembership');
    const owner = await userStore.getUser(ownerId).catch((e) => fallback('automation/approvalService:validateApprovalAssignees', e, null));
    const orgId = owner?.organizationId || null;
    const groups = await userStore.getAllGroups().catch((e) => fallback('automation/approvalService:validateApprovalAssignees#2', e, []));
    const errors = [];
    for (const s of steps) {
        const a = s.approval.assignee;
        if (a.userId) {
            const u = await userStore.getUser(a.userId).catch((e) => fallback('automation/approvalService:validateApprovalAssignees#3', e, null));
            const ok = !!u && (!orgId ? a.userId === ownerId : isMemberOfOrg(u, groups, orgId));
            if (!ok) errors.push({ path: `steps.${s.id}.approval.assignee`, message: `Step ${s.id}: the chosen approver is not in your organisation.` });
        } else if (a.groupId) {
            const g = groups.find(x => String(x.id) === String(a.groupId));
            const ok = !!g && !!orgId && String(g.organizationId || '') === String(orgId);
            if (!ok) errors.push({ path: `steps.${s.id}.approval.assignee`, message: `Step ${s.id}: the chosen approver group is not in your organisation.` });
        }
    }
    return errors;
}

module.exports = {
    decide, withdraw, canDecide, canView, ensureApprovalForRun, validateApprovalAssignees,
    isRunless, userDisplayName,
    // Panel machinery — the routes render progress; tests pin the rulebook.
    hasPanel, panelProgress, voteSummary, seatIndexFor,
    // Stage machinery — the routes need to know whose turn it is.
    hasStages, currentStage, isSeatedInStage, isChainParticipant,
    _panelTest: { evaluatePanel, mergeVoteAnswers, isSeatedOnPanel, isFinalApprover },
    _stageTest: { evaluateStage, nextStageRemindAt },
};
