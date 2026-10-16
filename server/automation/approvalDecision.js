/**
 * Recording a decision: the typed outcome routes answer with, the decider's
 * display name, a deployment's outcome, and finalizeDecision, the one write
 * that settles an approval and resumes or fails its run. Used by
 * ./approvalService.js (decide, withdraw) and ./approvalVotes.js.
 */

'use strict';

const automationStore = require('../stores/automationStore');
const { redactRunForViewer } = require('../core/automationModel/callerRunVisibility');
const log = require('../telemetry/log');
const { isRunless, voteSummary } = require('./approvalRulebook');

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
        log.warn(`[approvalService] deployment decision for ${approval.id} not recorded (reconcile will retry): ${e.message}`);
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
async function finalizeDecision({ approval, run, deciderId, decision, trimmedReason, coercedAnswers, source, votes = null }) {
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
    }).catch(() => {});
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
        }).catch(() => {});
    }

    // Run-less: there is no run to resume or fail — the decided row IS the
    // outcome. An app learns of it via its own refetch, the on_decided
    // record-write hook (phase 3) and the approval.decided event above; a
    // deployment through recordDeploymentOutcome.
    if (runless) {
        return outcome(200, { accepted: true, decision, approval: decided, ...(votes ? { votes: votes.map(voteSummary) } : {}) });
    }

    if (decision === 'reject') {
        await automationStore.updateRun(run.id, {
            status: 'error',
            error: `Approval rejected: ${trimmedReason}`,
            errorClass: 'ApprovalRejected',
            finishedAt: decidedAt,
            awaitingStepId: null,
            approvalToken: null,
        });
        const fresh = await automationStore.getRun(run.id);
        return outcome(200, { accepted: true, decision: 'reject', approval: decided, run: redactRunForViewer(fresh, deciderId) });
    }

    // Approve → resume. Clearing the awaiting state FIRST is the run-level
    // half of the double-approve guard (kept from the legacy path).
    const runner = require('../core/automationRunner');
    const RESPONSE_TIMEOUT_MS = 60_000;
    let timedOut = false;
    const guard = new Promise((resolve) => setTimeout(() => { timedOut = true; resolve(null); }, RESPONSE_TIMEOUT_MS));

    await automationStore.updateRun(run.id, {
        awaitingStepId: null,
        approvalToken: null,
    }).catch(() => {});

    const resumePromise = runner.resumeFromStep(run.id, approval.stepId, {
        decision: {
            approved: true,
            by: deciderId,
            reason: trimmedReason || null,
            decidedAt,
            ...(coercedAnswers ? { answers: coercedAnswers } : {}),
            // Panel evidence, additive: who voted what, in order. Downstream
            // steps bind steps.<id>.output.votes when they care.
            ...(votes ? { votes: votes.map(voteSummary) } : {}),
        },
        userId: deciderId,
    }).catch(e => { log.error('[approvalService] resume error:', e.message); return null; });

    const newRun = await Promise.race([resumePromise, guard]);

    await automationStore.updateRun(run.id, {
        status: 'success',
        summary: newRun?.id
            ? `Resumed via approval — see child run ${newRun.id}`
            : 'Resumed via approval — continuation running (see run history).',
        finishedAt: decidedAt,
    }).catch(() => {});

    if (timedOut || !newRun) {
        return outcome(202, { accepted: true, pending: true, approval: decided, message: 'Resume started; check run history.' });
    }
    return outcome(200, { accepted: true, decision: 'approve', approval: decided, run: redactRunForViewer(newRun, deciderId) });
}

module.exports = { outcome, recordDeploymentOutcome, userDisplayName, deciderName, finalizeDecision };
