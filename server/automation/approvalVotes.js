// @typecheck
/**
 * Votes on multi-person approvals: a vote in the current stage of a stage
 * chain, a vote on a panel, and the notices that hand the turn on. When a
 * vote settles the approval it goes through finalizeDecision
 * (./approvalDecision.js). Called from decide in ./approvalService.js.
 */

'use strict';

const automationStore = require('../stores/automationStore');
const {
    deploymentRequesterId, currentStage, isSeatedInStage, evaluateStage, seatIndexFor, evaluatePanel,
    mergeVoteAnswers, voteSummary, panelProgress, isFinalApprover,
} = require('./approvalRulebook');
const { outcome, userDisplayName, finalizeDecision } = require('./approvalDecision');
const log = require('../telemetry/log');
const { fallback, bestEffort } = require('../utils/bestEffort');

/** The next stage's reminder deadline, or undefined to leave the clock alone. */
function nextStageRemindAt(approval, stage) {
    const hours = Number(stage?.remindAfterHours);
    if (!Number.isFinite(hours) || hours < 1) return undefined;
    const { approvalClocks } = require('../core/automationRunner/approvalLifecycle');
    return approvalClocks({ remindAfterHours: hours, expiresAt: approval.expiresAt || null }).remindAt;
}

/**
 * One vote on a STAGED approval. The caller (decide) has already run every
 * shared guard (pending, deadline, reason-on-reject, answers against the
 * snapshot, run still waiting); this owns the chain:
 *
 *   • only the CURRENT stage's seats may vote — the vote is filed under that
 *     stage's key, which is what the two partial-unique indexes make safe;
 *   • the stage's own rule decides its verdict, using the very same
 *     arithmetic a one-stage panel uses;
 *   • a stage that PASSES hands over to the next stage (a conditional UPDATE,
 *     so of two votes that each complete a quorum exactly one advances) and
 *     announces it to that stage's people — or, if it was the last, finishes;
 *   • a stage that REJECTS ends the whole approval, immediately. Every stage
 *     holds a veto: that is what a chain of sign-offs means.
 */
async function castStageVote({ approval, run, deciderId, decision, trimmedReason, coercedAnswers, source }) {
    const { nextStageKey, stageByKey, stagePosition } = require('./approvalStages');

    let voterName = null;
    let groupIds = [];
    try {
        const userStore = require('../stores/userStore');
        const { parseGroupIds } = require('../auth/orgMembership');
        const u = await userStore.getUser(deciderId);
        voterName = userDisplayName(u);
        groupIds = u ? parseGroupIds(u).map(String) : [];
    } catch (err) { fallback('automation/approvalVotes:castStageVote', err); /* seat matching falls back to personal seats only */ }
    const viewer = { userId: deciderId, groupIds };

    const stage = currentStage(approval);
    if (!stage) return outcome(409, { error: 'This approval has no stage waiting for a decision.' });
    if (!isSeatedInStage(stage, viewer)) {
        return outcome(403, { error: `This approval is at "${stage.name}", which you are not an approver for.` });
    }

    const votes = await automationStore.getApprovalVotes(approval.id);
    const stageVotes = votes.filter(v => v.stage === stage.key);
    const seatIdx = seatIndexFor(stage.approvers, stageVotes, viewer);
    if (seatIdx < 0) {
        const already = stageVotes.some(v => v.voterId === deciderId);
        return outcome(409, {
            error: already
                ? `You already voted in "${stage.name}".`
                : `Your seat in "${stage.name}" has already been decided by a colleague.`,
        });
    }

    const vote = await automationStore.castApprovalVote({
        approvalId: approval.id, stage: stage.key, seatIndex: seatIdx,
        voterId: deciderId, voterName, decision,
        reason: trimmedReason || null, answers: coercedAnswers,
    });
    if (!vote) {
        return outcome(409, { error: 'Someone beat you to this vote — refresh to see the current state.' });
    }
    await automationStore.appendApprovalAudit({
        approvalId: approval.id, runId: approval.runId, stepId: approval.stepId,
        decidedBy: deciderId,
        decision: decision === 'approve' ? 'vote_approved' : 'vote_rejected',
        comment: trimmedReason || null, source: `${source}:${stage.key}`,
    }).catch((e) => bestEffort('automation/approvalVotes:castStageVote#2', e));

    const allVotes = [...votes, vote];
    const verdict = evaluateStage(stage, [...stageVotes, vote], deploymentRequesterId(approval));

    // A rejection anywhere ends the chain. No send-back, no skip: every stage
    // holds a veto, and the requester hears immediately.
    if (verdict === 'rejected') {
        return finalizeDecision({
            approval, run, deciderId, decision: 'reject', trimmedReason,
            coercedAnswers: null, source, votes: allVotes,
        });
    }

    if (verdict === 'passed') {
        const nextKey = nextStageKey(approval.stages, stage.key);
        if (nextKey) {
            const next = stageByKey(approval.stages, nextKey);
            // Re-arm the reminder from the NEXT stage's own clock: a reminder
            // already spent on stage 1 must not silence stage 2.
            const remindAt = nextStageRemindAt(approval, next);
            const advanced = await automationStore.advanceApprovalStage(approval.id, {
                from: stage.key, to: nextKey, remindAt,
                // Re-point the panel-era columns at the stage now waiting, so
                // the pre-stages readers (request bells, expiry announcements)
                // address the people whose turn it actually is.
                mirror: {
                    approvers: next?.approvers || null,
                    rule: next?.rule || 'all',
                    quorum: Number.isFinite(next?.quorum) ? next.quorum : null,
                },
            });
            if (advanced) {
                await automationStore.appendApprovalAudit({
                    approvalId: approval.id, runId: approval.runId, stepId: approval.stepId,
                    decidedBy: null, decision: 'stage_passed',
                    comment: `${stage.name} → ${next?.name || nextKey}`, source,
                }).catch((e) => bestEffort('automation/approvalVotes:castStageVote#3', e));
                await notifyStageApprovers(advanced, next).catch((e) => bestEffort('automation/approvalVotes:castStageVote#4', e));
            }
            const fresh = advanced || await automationStore.getApproval(approval.id);
            return outcome(200, {
                accepted: true, decision: 'vote_recorded', stage: nextKey,
                approval: fresh, votes: allVotes.map(voteSummary),
                progress: panelProgress(fresh, allVotes),
            });
        }
        // The last stage passed — the whole approval is approved.
        return finalizeDecision({
            approval, run, deciderId, decision: 'approve', trimmedReason,
            coercedAnswers: mergeVoteAnswers(allVotes),
            source, votes: allVotes,
        });
    }

    // The stage is still open — the vote stands, the row stays pending.
    const fresh = await automationStore.getApproval(approval.id);
    return outcome(200, {
        accepted: true, decision: 'vote_recorded',
        approval: fresh || approval, votes: allVotes.map(voteSummary),
        progress: panelProgress(fresh || approval, allVotes),
        ...(stagePosition(approval.stages, stage.key) || {}),
    });
}

/** "Your turn" — the incoming stage's people, and nobody else. */
async function notifyStageApprovers(approval, stage) {
    if (!stage) return;
    const { panelRecipientIds } = require('../core/automationRunner/approvalLifecycle');
    const { notifyApproval, automationForApproval } = require('./approvalNotify');
    const { stagePosition } = require('./approvalStages');
    const pos = stagePosition(approval.stages, stage.key);
    const where = pos ? ` (step ${pos.index} of ${pos.total})` : '';
    // A hand-over IS a fresh request — this stage's people have not been asked
    // before — so it goes out on every channel the policy names, card included.
    await notifyApproval({
        approval,
        automation: await automationForApproval(approval),
        // Four-eyes: the deploy's requester is never asked to decide it.
        recipientIds: (await panelRecipientIds(stage.approvers))
            .filter(id => id !== deploymentRequesterId(approval)),
        category: 'heads_up',
        title: `🔔 Your approval is needed: ${stage.name}`,
        message: `${approval.prompt || 'An approval'}${where}${stage.description ? ` — ${stage.description}` : ''}`,
    }).catch((e) => bestEffort('automation/approvalVotes:notifyStageApprovers', e));
}

/**
 * One vote on a panel row. The caller (decide) has already run every shared
 * guard; this owns seat assignment, the vote insert (the unique indexes are
 * the race guards), rule evaluation, the stage flip to the final sign-off,
 * and — when the rule resolves — handing the verdict to finalizeDecision.
 */
async function castPanelVote({ approval, run, deciderId, decision, trimmedReason, coercedAnswers, source }) {
    // The voter's groups decide which seats they can fill; one lookup serves
    // the name on the vote row too.
    let voterName = null;
    let groupIds = [];
    try {
        const userStore = require('../stores/userStore');
        const { parseGroupIds } = require('../auth/orgMembership');
        const u = await userStore.getUser(deciderId);
        voterName = userDisplayName(u);
        groupIds = u ? parseGroupIds(u).map(String) : [];
    } catch (err) { fallback('automation/approvalVotes:castPanelVote', err); /* seat matching falls back to personal seats only */ }
    const viewer = { userId: deciderId, groupIds };

    const votes = await automationStore.getApprovalVotes(approval.id);
    const stage = approval.stage || 'panel';

    // ── Final sign-off: one person, one terminal decision ────────────────
    if (stage === 'final') {
        if (!isFinalApprover(approval, viewer)) {
            return outcome(403, { error: 'The panel has decided — this approval is waiting for its final approver.' });
        }
        const vote = await automationStore.castApprovalVote({
            approvalId: approval.id, stage: 'final', seatIndex: null,
            voterId: deciderId, voterName, decision,
            reason: trimmedReason || null, answers: coercedAnswers,
        });
        if (!vote) return outcome(409, { error: 'You already decided this approval.' });
        await automationStore.appendApprovalAudit({
            approvalId: approval.id, runId: approval.runId, stepId: approval.stepId,
            decidedBy: deciderId,
            decision: decision === 'approve' ? 'vote_approved' : 'vote_rejected',
            comment: trimmedReason || null, source,
        }).catch((e) => bestEffort('automation/approvalVotes:castPanelVote#2', e));
        const allVotes = [...votes, vote];
        return finalizeDecision({
            approval, run, deciderId, decision, trimmedReason,
            coercedAnswers: decision === 'approve'
                ? { ...(mergeVoteAnswers(allVotes) || {}), ...(coercedAnswers || {}) }
                : coercedAnswers,
            source, votes: allVotes,
        });
    }

    // ── Panel stage ──────────────────────────────────────────────────────
    const panelVotes = votes.filter(v => v.stage === 'panel');
    const seatIdx = seatIndexFor(approval.approvers, panelVotes, viewer);
    if (seatIdx < 0) {
        const already = panelVotes.some(v => v.voterId === deciderId);
        return outcome(409, {
            error: already
                ? 'You already voted on this approval.'
                : 'Your seat on this panel has already been decided by a colleague.',
        });
    }
    const vote = await automationStore.castApprovalVote({
        approvalId: approval.id, stage: 'panel', seatIndex: seatIdx,
        voterId: deciderId, voterName, decision,
        reason: trimmedReason || null, answers: coercedAnswers,
    });
    if (!vote) {
        // A concurrent vote won the seat (or this person double-clicked) —
        // the unique indexes make the loser explicit instead of double-counted.
        return outcome(409, { error: 'Someone beat you to this vote — refresh to see the current state.' });
    }
    await automationStore.appendApprovalAudit({
        approvalId: approval.id, runId: approval.runId, stepId: approval.stepId,
        decidedBy: deciderId,
        decision: decision === 'approve' ? 'vote_approved' : 'vote_rejected',
        comment: trimmedReason || null, source,
    }).catch((e) => bestEffort('automation/approvalVotes:castPanelVote#3', e));

    const allPanelVotes = [...panelVotes, vote];
    const allVotes = [...votes, vote];
    const verdict = evaluatePanel(approval, allPanelVotes);

    if (verdict === 'rejected') {
        return finalizeDecision({ approval, run, deciderId, decision: 'reject', trimmedReason, coercedAnswers: null, source, votes: allVotes });
    }
    if (verdict === 'passed') {
        if (approval.finalApproverUserId || approval.finalApproverGroupId) {
            // Conditional flip: of two votes that each complete the quorum,
            // exactly one advances the stage and bells the final approver.
            const advanced = await automationStore.advanceApprovalStage(approval.id, { from: 'panel', to: 'final' });
            if (advanced) {
                await automationStore.appendApprovalAudit({
                    approvalId: approval.id, runId: approval.runId, stepId: approval.stepId,
                    decidedBy: null, decision: 'panel_approved', source,
                }).catch((e) => bestEffort('automation/approvalVotes:castPanelVote#4', e));
                await notifyFinalApprover(advanced).catch((e) => bestEffort('automation/approvalVotes:castPanelVote#5', e));
            }
            const fresh = advanced || await automationStore.getApproval(approval.id);
            return outcome(200, {
                accepted: true, decision: 'vote_recorded', stage: 'final',
                approval: fresh, votes: allVotes.map(voteSummary),
                progress: panelProgress(fresh, allVotes),
            });
        }
        return finalizeDecision({
            approval, run, deciderId, decision: 'approve', trimmedReason,
            coercedAnswers: mergeVoteAnswers(allPanelVotes),
            source, votes: allVotes,
        });
    }

    // Still open — the vote stands, the row stays pending.
    const fresh = await automationStore.getApproval(approval.id);
    return outcome(200, {
        accepted: true, decision: 'vote_recorded',
        approval: fresh || approval, votes: allVotes.map(voteSummary),
        progress: panelProgress(fresh || approval, allVotes),
    });
}

/** The final approver's "it is your turn" bell — person, or group capped. */
async function notifyFinalApprover(approval) {
    const recipients = new Set();
    if (approval.finalApproverUserId) recipients.add(approval.finalApproverUserId);
    else if (approval.finalApproverGroupId) {
        const { groupMemberIds } = require('../core/automationRunner/approvalLifecycle');
        for (const id of (await groupMemberIds(approval.finalApproverGroupId)).ids) recipients.add(id);
    }
    // The final approver has not been asked before — a fresh request, card on.
    const { notifyApproval, automationForApproval } = require('./approvalNotify');
    await notifyApproval({
        approval,
        automation: await automationForApproval(approval),
        recipientIds: [...recipients],
        category: 'heads_up',
        title: `🖋️ Final sign-off needed: ${approval.automationTitle || 'approval'}`,
        message: `${approval.prompt || 'An approval'} — the panel approved; your decision is the final word.`,
    }).catch((e) => bestEffort('automation/approvalVotes:notifyFinalApprover', e));
}

module.exports = { castStageVote, castPanelVote, nextStageRemindAt };
