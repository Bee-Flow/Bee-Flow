// @typecheck
/**
 * Recording a decision: the typed outcome routes answer with, the decider's
 * display name, a deployment's outcome, and finalizeDecision, the one write
 * that settles an approval and resumes or fails its run. Used by
 * ./approvalService.js (decide, withdraw) and ./approvalVotes.js.
 */

'use strict';

const automationStore = require('../stores/automationStore');
const { redactRunForViewer } = require('../auth/callerRunVisibility');
const log = require('../telemetry/log');
const { isRunless, voteSummary } = require('./approvalRulebook');
const { bestEffort, fallback } = require('../utils/bestEffort');
const { approvalOutput } = require('../core/automationModel/approvalOutput.mts');
const { ON_REJECTED_LABEL } = require('../core/automationModel/edgeLabels.mts');

// The parent run's summary once a rejection continued on its branch (D4a).
const REJECTED_BRANCH_SUMMARY = 'Rejected — continued on the rejected branch';

/** Small typed outcome so routes stay one-line thin. */
function outcome(code, body) { return { code, body }; }

/**
 * Hand a final deployment-gate row to the deployment it guards: the store
 * moves the deployment out of awaiting_approval (approved / rejected /
 * cancelled). A store, not projects/, so automation/ keeps its layering.
 * Best-effort after the decision committed: the runner's
 * reconcileAwaitingApprovals is the backstop for a failed call.
 */
async function recordDeploymentOutcome(approval) {
    if (approval?.source !== 'deployment' || approval.status === 'pending') return;
    try {
        await require('../stores/solutionStageStore').recordDeploymentDecision(approval);
    } catch (e) {
        log.warn(`[approvalService] deployment decision for ${approval.id} not recorded (reconcile will retry): ${/** @type {Error} */ (e).message}`);
    }
}

// users has no `name` column: the person's name is displayName, then username,
// then e-mail (BFSF-389). One helper so the three decision sites cannot drift.
function userDisplayName(u) {
    return u?.displayName || u?.username || u?.email || null;
}

async function deciderName(userId) {
    try {
        const userStore = require('../stores/userStore');
        const u = await userStore.getUser(userId);
        return userDisplayName(u);
    } catch { return null; }
}

/**
 * The TERMINAL machinery, shared by the single-assignee path and a panel
 * whose rule just resolved: the conditional decision write, audit, the
 * approval.decided event, the on_decided hook, the owner bell, and — for
 * run-sourced rows — failing or resuming the run. `votes` (panel rows)
 * travels into the resume decision object and the response, so downstream
 * steps can read steps.<id>.output.votes.
 */
async function finalizeDecision(/** @type {{ approval: any, run: any, deciderId: any, decision: any, trimmedReason: any, coercedAnswers: any, source: any, votes?: unknown[] | null, respond?: 'created' | 'finished' | null }} */ { approval, run, deciderId, decision, trimmedReason, coercedAnswers, source, votes = null, respond = null }) {
    const runless = isRunless(approval);
    const decidedByName = await deciderName(deciderId);
    const decidedAt = new Date().toISOString();

    // THE decision write — conditional on pending, so of two concurrent
    // deciders exactly one proceeds; the loser 409s and never resumes.
    const decided = await automationStore.decideApproval(approval.id, {
        status: decision === 'approve' ? 'approved' : 'rejected',
        decidedBy: deciderId,
        decidedByName,
        reason: trimmedReason || null,
        answers: coercedAnswers,
    });
    if (!decided) {
        const fresh = await automationStore.getApproval(approval.id);
        return outcome(409, { error: `This approval was already ${fresh?.status || 'decided'}.`, status: fresh?.status });
    }
    await automationStore.appendApprovalAudit({
        approvalId: approval.id, runId: run?.id || null, stepId: approval.stepId,
        decidedBy: deciderId, decision: decision === 'approve' ? 'approved' : 'rejected',
        comment: trimmedReason || null, source,
    }).catch((e) => bestEffort('automation/approvalDecision:finalizeDecision', e));
    // The general-purpose reaction channel — automations subscribed to
    // approval.decided fire whatever the source. Fire-and-forget: fan-out
    // must never delay or fail the decision the caller just made.
    require('./approvalEvents').dispatchApprovalDecided(decided, { votes });
    // The app's own reaction: the snapshotted on_decided record write. Runs
    // AFTER the decision committed; a failure is audited and belled, never
    // rolled back (at-least-once-decided, best-effort-hook).
    await require('./approvalHooks').runOnDecidedHook(decided);
    // A deployment gate: the decided row moves its deployment (approved →
    // the runner executes it after re-checking the plan; rejected closes it).
    await recordDeploymentOutcome(decided);

    // Tell the owner when someone else decided their automation's approval.
    // card:false — an outcome notice has nothing left to react to, so it goes
    // to the bell (and whatever else the policy names) but never posts a card
    // with a 👍 that would decide something already decided.
    if (deciderId !== approval.ownerId) {
        const { notifyApproval, automationForApproval } = require('./approvalNotify');
        await notifyApproval({
            approval: decided || approval,
            automation: await automationForApproval(approval),
            recipientIds: [approval.ownerId],
            category: 'heads_up',
            title: decision === 'approve'
                ? `✅ Approved by ${decidedByName || 'a colleague'}: ${approval.automationTitle || 'automation'}`
                : `⛔ Declined by ${decidedByName || 'a colleague'}: ${approval.automationTitle || 'automation'}`,
            message: trimmedReason ? `"${trimmedReason}"` : (approval.prompt || ''),
            card: false,
        }).catch((e) => bestEffort('automation/approvalDecision:finalizeDecision#2', e));
    }

    // Run-less: there is no run to resume or fail — the decided row IS the
    // outcome. An app learns of it via its own refetch, the on_decided
    // record-write hook (phase 3) and the approval.decided event above; a
    // deployment through recordDeploymentOutcome.
    if (runless) {
        return outcome(200, { accepted: true, decision, approval: decided, ...(votes ? { votes: votes.map(voteSummary) } : {}) });
    }

    const resume = { approval: decided, run, deciderId, trimmedReason, coercedAnswers, votes, decidedAt, respond };
    if (decision === 'reject') {
        // A reject continues along the approval's 'on_rejected' edge when the
        // definition the run is pinned to wires one; without it the run ends
        // as before (ApprovalRejected).
        if (await rejectHasBranch(run, approval.stepId)) return resumeDecidedRun({ ...resume, approved: false });
        return rejectRun({ approval: decided, run, deciderId, trimmedReason, decidedAt });
    }
    return resumeDecidedRun({ ...resume, approved: true });
}

/**
 * Whether the definition a paused run continues on (resume.js
 * automationToResume: the version it started on) has an 'on_rejected' edge
 * out of the approval step. Any failure to read it answers false: the reject
 * then ends the run, as it always did.
 * @param {{ automationId: string, version?: number | null } | null | undefined} run  the paused run row
 * @param {string | null | undefined} stepId
 * @returns {Promise<boolean>}
 */
async function rejectHasBranch(run, stepId) {
    if (!run?.automationId || !stepId) return false;
    try {
        const { automationToResume } = require('../core/automationRunner/resume');
        const automation = await automationToResume(run);
        const edges = Array.isArray(automation?.definition?.edges) ? automation.definition.edges : [];
        return edges.some((/** @type {{ from?: string, label?: string } | null} */ e) => e && e.from === stepId && e.label === ON_REJECTED_LABEL);
    } catch (e) {
        return fallback('automation/approvalDecision:rejectHasBranch', e, false);
    }
}

/**
 * A rejection fails the paused run, closes its paused step row as 'rejected'
 * (the step would otherwise go on saying "Waiting for your approval" on a
 * finished run) and tells the stream (run-watch F10).
 * @param {{ approval: any, run: any, deciderId: string, trimmedReason: string, decidedAt: string }} p
 */
async function rejectRun({ approval, run, deciderId, trimmedReason, decidedAt }) {
    const error = `Approval rejected: ${trimmedReason}`;
    await automationStore.updateRun(run.id, {
        status: 'error',
        error,
        errorClass: 'ApprovalRejected',
        finishedAt: decidedAt,
        awaitingStepId: null,
        approvalToken: null,
    });
    await Promise.resolve().then(() => automationStore.closeAwaitingStepRow(run.id, approval.stepId, 'awaiting_approval', 'rejected'))
        .catch((e) => bestEffort('automation/approvalDecision:rejectRun', e));
    require('../core/runEventBus').emitRunClosed(run, { status: 'error', errorClass: 'ApprovalRejected', error });
    const fresh = await automationStore.getRun(run.id);
    return outcome(200, { accepted: true, decision: 'reject', approval, run: redactRunForViewer(fresh, deciderId) });
}

/**
 * A decision that continues the run — an approve, or a reject with a wired
 * 'on_rejected' edge — answered within the response cap
 * (core/automationRunner/startCapped.mts): 200 with the continuation when it
 * ends in time, else 202 with its run id. `respond: 'created'` answers 202 as
 * soon as the continuation exists. The decision reaches the continuation as
 * the approval step's output, in the one shape approvalOutput.mts makes;
 * runDag routes `approved: false` along the rejected branch only.
 * @param {{ approval: any, run: any, deciderId: string, trimmedReason: string, coercedAnswers: any, votes: unknown[] | null, decidedAt: string, respond: 'created' | 'finished' | null, approved: boolean }} p
 */
async function resumeDecidedRun({ approval, run, deciderId, trimmedReason, coercedAnswers, votes, decidedAt, respond, approved }) {
    // Clearing the awaiting state FIRST is the run-level half of the
    // double-approve guard (kept from the legacy path).
    const runner = require('../core/automationRunner');
    const { startCapped, pendingRunBody } = require('../core/automationRunner/startCapped.mts');
    const decision = approved ? 'approve' : 'reject';

    await automationStore.updateRun(run.id, {
        awaitingStepId: null,
        approvalToken: null,
    }).catch((e) => bestEffort('automation/approvalDecision:finalizeDecision#3', e));
    // A rejected step row says so, as on a reject that ends the run.
    if (!approved) {
        await Promise.resolve().then(() => automationStore.closeAwaitingStepRow(run.id, approval.stepId, 'awaiting_approval', 'rejected'))
            .catch((e) => bestEffort('automation/approvalDecision:resumeDecidedRun', e));
    }

    const decisionOutput = approvalOutput({
        approved,
        by: deciderId,
        reason: trimmedReason || null,
        decidedAt,
        answers: coercedAnswers,
        // Panel evidence: who voted what, in order. Downstream steps bind
        // steps.<id>.output.votes when they care.
        votes: votes ? votes.map(voteSummary) : [],
    });
    /** @type {{ kind: 'finished', run: any } | { kind: 'pending', runId: string } | null} */
    const resumed = await startCapped((onRunCreated) => runner.resumeFromStep(run.id, approval.stepId, { decision: decisionOutput, userId: deciderId, onRunCreated }),
        { respond, label: 'approvalService/resume' })
        .catch((e) => { log.error('[approvalService] resume error:', e.message); return null; });
    const childId = resumed?.kind === 'finished' ? resumed.run?.id : resumed?.runId;

    // The continuation never started, so there is no run to follow: the
    // parent ends in error rather than "success — continuation running", and
    // the answer says so. The decision itself stands (written above).
    if (!childId) return resumeFailed({ approval, run, decision, decidedAt });

    await automationStore.updateRun(run.id, {
        status: 'success',
        summary: approved ? `Resumed via approval — see child run ${childId}` : REJECTED_BRANCH_SUMMARY,
        finishedAt: decidedAt,
    }).catch((e) => bestEffort('automation/approvalDecision:finalizeDecision#4', e));

    if (resumed?.kind === 'finished') {
        return outcome(200, { accepted: true, decision, approval, run: redactRunForViewer(resumed.run, deciderId) });
    }
    return outcome(202, { ...pendingRunBody(childId, 'Resume started; check run history.'), ...(approved ? {} : { decision }), approval });
}

/**
 * The decision was recorded but its continuation could not start: the
 * parent run ends in error `resume_failed` (it would otherwise say "success"
 * with nothing after it) and the caller gets a 500 naming the code.
 * @param {{ approval: any, run: any, decision: 'approve' | 'reject', decidedAt: string }} p
 */
async function resumeFailed({ approval, run, decision, decidedAt }) {
    const error = decision === 'approve'
        ? 'The approval was recorded, but the run could not continue.'
        : 'The rejection was recorded, but the run could not continue on its rejected branch.';
    await automationStore.updateRun(run.id, {
        status: 'error',
        error,
        errorClass: 'resume_failed',
        finishedAt: decidedAt,
    }).catch((e) => bestEffort('automation/approvalDecision:resumeFailed', e));
    require('../core/runEventBus').emitRunClosed(run, { status: 'error', errorClass: 'resume_failed', error });
    return outcome(500, { error: `${error} Check its run history.`, code: 'resume_failed', decision, approval });
}

module.exports = { outcome, recordDeploymentOutcome, userDisplayName, deciderName, finalizeDecision };

/** @typedef {import('./approvalRulebook').Approval} Approval */

/** @typedef {import('./approvalRulebook').ApprovalVote} ApprovalVote */

/**
 * @typedef DecisionCall  what decide hands to the vote and decision writers
 * @property {Approval} approval
 * @property {Record<string, any>|null} run  the run row the approval pauses (null for a run-less approval)
 * @property {string} deciderId
 * @property {string} decision  'approve' | 'reject'
 * @property {string} [trimmedReason]
 * @property {Record<string, unknown>|null} [coercedAnswers]
 * @property {string} source
 * @property {ApprovalVote[]|null} [votes]
 */
