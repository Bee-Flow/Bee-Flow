// @typecheck
/**
 * The approval rulebook: pure decisions about who may see, vote on or decide
 * an approval, and how a panel or a stage chain counts its votes. No store
 * access; ./approvalService.js (decide, withdraw) and ./approvalVotes.js act
 * on what these say. Re-exported by approvalService.js under its old names.
 */

'use strict';

/**
 * Run-less: the row has no run to resume or fail — the decision IS the
 * outcome. 'app' (an App Studio request) and 'deployment' (a Solution's PRD
 * deploy gate) both are; only 'run' carries a run.
 */
function isRunless(approval) {
    return (approval?.source || 'run') !== 'run';
}

/**
 * Four-eyes for a deployment gate: whoever requested the deploy never
 * decides it, in any shape (single, panel, stage chain). A row without a
 * recorded requester falls back to its owner (the Solution owner, who is the
 * requester in v1), so a missing column fails closed.
 * @param {string} userId
 */
function isOwnDeploymentRequest(approval, userId) {
    if (!userId) return false;
    return deploymentRequesterId(approval) === userId;
}

/** The requester four-eyes bars on a deployment gate, else null. */
function deploymentRequesterId(approval) {
    if (approval?.source !== 'deployment') return null;
    return approval.requestedBy || approval.ownerId || null;
}

/**
 * The seats that can actually vote. On a deployment gate the requester's
 * personal seat is dead (four-eyes), so it does not count toward 'all' or a
 * quorum: otherwise an 'all' stage that seats the requester could never
 * pass. A group seat stays (another member can fill it). Never below 1: a
 * stage seating only the requester stays open (and expires) rather than
 * passing on zero votes.
 */
function votableSeatCount(approvers, requesterId) {
    const seats = Array.isArray(approvers) ? approvers : [];
    if (!requesterId) return seats.length;
    return Math.max(1, seats.filter(s => !(s?.userId && s.userId === requesterId)).length);
}

// ── Panel helpers (pure — the vote engine's rulebook) ────────────────────

function hasPanel(approval) {
    return Array.isArray(approval?.approvers) && approval.approvers.length > 0;
}

/** Any seat this viewer could ever fill (vote state ignored) — view/eligibility. */
function isSeatedOnPanel(approval, viewer) {
    if (!hasPanel(approval) || !viewer?.userId) return false;
    const gs = (Array.isArray(viewer.groupIds) ? viewer.groupIds : []).map(String);
    return approval.approvers.some(s => s && (
        (s.userId && s.userId === viewer.userId)
        || (s.groupId && gs.includes(String(s.groupId)))));
}

function isFinalApprover(approval, viewer) {
    if (!approval || !viewer?.userId) return false;
    if (approval.finalApproverUserId && approval.finalApproverUserId === viewer.userId) return true;
    return !!(approval.finalApproverGroupId
        && Array.isArray(viewer.groupIds)
        && viewer.groupIds.map(String).includes(String(approval.finalApproverGroupId)));
}

// ── The stage chain ──────────────────────────────────────────────────────
// A staged approval asks its stages IN ORDER; only the current stage's people
// may act. Legacy panel rows carry no chain and keep the panel/final code
// path below, so nothing authored before the stage chain existed changes behaviour.

function hasStages(approval) {
    return Array.isArray(approval?.stages) && approval.stages.length > 0;
}

/** The stage a row is on right now. */
function currentStage(approval) {
    if (!hasStages(approval)) return null;
    const { stageByKey, firstStageKey } = require('./approvalStages');
    return stageByKey(approval.stages, approval.stage)
        || stageByKey(approval.stages, firstStageKey(approval.stages));
}

/** Does this viewer hold a seat in the given stage? */
function isSeatedInStage(stage, viewer) {
    if (!stage || !viewer?.userId) return false;
    const gs = (Array.isArray(viewer.groupIds) ? viewer.groupIds : []).map(String);
    return (stage.approvers || []).some(seat => seat && (
        (seat.userId && seat.userId === viewer.userId)
        || (seat.groupId && gs.includes(String(seat.groupId)))));
}

/** Any seat anywhere in the chain — the WATCH set, not the decide set. */
function isChainParticipant(approval, viewer) {
    if (!hasStages(approval) || !viewer?.userId) return false;
    return approval.stages.some(stage => isSeatedInStage(stage, viewer));
}

/**
 * A stage's verdict from its own votes. Deliberately the same arithmetic
 * evaluatePanel applies — a stage IS a panel, just one of several — so the
 * rules cannot drift between a one-stage approval and stage 3 of five.
 */
function evaluateStage(stage, stageVotes, requesterId = null) {
    return evaluatePanel(
        { approvers: stage.approvers || [], approvalRule: stage.rule, quorumCount: stage.quorum },
        stageVotes,
        requesterId,
    );
}

/**
 * Which seat this vote fills, or -1. One vote per PERSON whatever their
 * seats; personal seats are claimed BEFORE group seats — a member who also
 * holds a named seat must not spend their one vote on a group seat and
 * deadlock their own (an 'all' panel would then never complete).
 */
function seatIndexFor(approvers, panelVotes, viewer) {
    if (!viewer?.userId) return -1;
    if (panelVotes.some(v => v.voterId === viewer.userId)) return -1;
    const filled = new Set(panelVotes.map(v => v.seatIndex));
    const gs = (Array.isArray(viewer.groupIds) ? viewer.groupIds : []).map(String);
    for (let i = 0; i < approvers.length; i++) {
        if (filled.has(i)) continue;
        if (approvers[i]?.userId && approvers[i].userId === viewer.userId) return i;
    }
    for (let i = 0; i < approvers.length; i++) {
        if (filled.has(i)) continue;
        if (approvers[i]?.groupId && gs.includes(String(approvers[i].groupId))) return i;
    }
    return -1;
}

/**
 * The rule, applied to the panel-stage votes.
 *   'first'  — the earliest vote decides for everyone.
 *   'quorum' — passed at N approvals; rejected the moment N is unreachable.
 *   'all'    — every seat must approve; ONE reject declines immediately
 *              (the requester hears fast, the rest are stood down). Also the
 *              fail-safe for an unknown rule — the strictest reading.
 */
function evaluatePanel(approval, panelVotes, requesterId = deploymentRequesterId(approval)) {
    const seatCount = votableSeatCount(approval.approvers, requesterId);
    const approvals = panelVotes.filter(v => v.decision === 'approve').length;
    const rejects = panelVotes.filter(v => v.decision === 'reject').length;
    const rule = approval.approvalRule || 'all';
    if (rule === 'first') {
        if (!panelVotes.length) return 'open';
        return panelVotes[0].decision === 'approve' ? 'passed' : 'rejected';
    }
    if (rule === 'quorum') {
        const n = Math.min(Math.max(Number(approval.quorumCount) || 1, 1), seatCount);
        if (approvals >= n) return 'passed';
        if (seatCount - rejects < n) return 'rejected';
        return 'open';
    }
    if (rejects > 0) return 'rejected';
    if (approvals >= seatCount) return 'passed';
    return 'open';
}

/** Approve-votes' answers in cast order, later votes overriding earlier. */
function mergeVoteAnswers(votes) {
    const merged = {};
    for (const v of votes) {
        if (v.decision !== 'approve' || !v.answers || typeof v.answers !== 'object') continue;
        Object.assign(merged, v.answers);
    }
    return Object.keys(merged).length ? merged : null;
}

/** The compact shape votes take in outputs, events and responses. */
function voteSummary(v) {
    return { by: v.voterId, name: v.voterName || null, decision: v.decision, reason: v.reason || null, stage: v.stage, at: v.createdAt };
}

/**
 * What the detail view renders. For a staged approval this is the whole
 * TIMELINE — every stage with its name, description, rule, its own tally and
 * its own state (done / current / waiting / skipped) — because "where is this
 * and who is it on" is the question the surface exists to answer.
 */
/**
 * Approvals a rule needs over `seats` votable seats (the evaluatePanel arithmetic).
 * @param {number} seats
 */
function neededVotes(rule, quorum, seats) {
    if (rule === 'quorum') return Math.min(Math.max(Number(quorum) || 1, 1), seats);
    return rule === 'first' ? 1 : seats;
}

function panelProgress(approval, votes) {
    if (hasStages(approval)) {
        const { activeStages, stagePosition } = require('./approvalStages');
        const cur = currentStage(approval);
        const order = activeStages(approval.stages).map(st => st.key);
        const curIdx = cur ? order.indexOf(cur.key) : -1;
        const terminal = approval.status && approval.status !== 'pending';
        const requesterId = deploymentRequesterId(approval);
        return {
            kind: 'stages',
            stage: cur?.key || null,
            position: cur ? stagePosition(approval.stages, cur.key) : null,
            stages: approval.stages.map((st) => {
                const stageVotes = (votes || []).filter(v => v.stage === st.key);
                const approvals = stageVotes.filter(v => v.decision === 'approve').length;
                const seatCount = (st.approvers || []).length;
                const idx = order.indexOf(st.key);
                /** @type {string} */
                let state;
                if (st.skipped) state = 'skipped';
                else if (terminal) state = stageVotes.length ? 'done' : 'never_reached';
                else if (idx === curIdx) state = 'current';
                else if (idx >= 0 && curIdx >= 0 && idx < curIdx) state = 'done';
                else state = 'waiting';
                return {
                    key: st.key, name: st.name, description: st.description || null,
                    rule: st.rule, seatCount, approvals,
                    rejects: stageVotes.filter(v => v.decision === 'reject').length,
                    needed: neededVotes(st.rule, st.quorum, votableSeatCount(st.approvers, requesterId)),
                    state,
                    votes: stageVotes.map(voteSummary),
                };
            }),
        };
    }
    if (!hasPanel(approval)) return null;
    const panelVotes = votes.filter(v => v.stage === 'panel');
    const approvals = panelVotes.filter(v => v.decision === 'approve').length;
    const seatCount = approval.approvers.length;
    const rule = approval.approvalRule || 'all';
    return {
        rule,
        stage: approval.stage || 'panel',
        seatCount,
        approvals,
        rejects: panelVotes.filter(v => v.decision === 'reject').length,
        needed: neededVotes(rule, approval.quorumCount,
            votableSeatCount(approval.approvers, deploymentRequesterId(approval))),
        hasFinalStage: !!(approval.finalApproverUserId || approval.finalApproverGroupId),
    };
}

function canDecide(approval, viewer) {
    if (!approval || !viewer?.userId) return false;
    // Four-eyes before every shape below: a deploy's requester holds no
    // decision on it, whatever seat, ownership or admin right they also hold.
    if (isOwnDeploymentRequest(approval, viewer.userId)) return false;
    // Staged rows: only the CURRENT stage's people may act. Someone seated in
    // stage 3 has no vote while stage 1 is running — being asked later is not
    // being asked now.
    if (hasStages(approval)) {
        return isSeatedInStage(currentStage(approval), viewer);
    }
    // Panel rows: the PANEL is the authority. Owner and org admin keep view
    // and withdraw rights, but cannot vote a seat they do not hold — an
    // "everyone must approve" that the owner can bypass is theatre.
    if (hasPanel(approval)) {
        if ((approval.stage || 'panel') === 'final') return isFinalApprover(approval, viewer);
        return isSeatedOnPanel(approval, viewer);
    }
    if (approval.ownerId === viewer.userId) return true;
    if (approval.assigneeUserId && approval.assigneeUserId === viewer.userId) return true;
    if (approval.assigneeGroupId
        && Array.isArray(viewer.groupIds)
        && viewer.groupIds.map(String).includes(String(approval.assigneeGroupId))) return true;
    // Escalation WIDENS the decider set: the target gains rights only once
    // the reaper stamped escalated_at — the stamp IS the grant. The original
    // assignee keeps theirs (no clause above is removed by escalating).
    if (approval.escalatedAt) {
        if (approval.escalateToUserId && approval.escalateToUserId === viewer.userId) return true;
        if (approval.escalateToGroupId
            && Array.isArray(viewer.groupIds)
            && viewer.groupIds.map(String).includes(String(approval.escalateToGroupId))) return true;
    }
    if (approval.organizationId && typeof viewer.isOrgAdminOfOrg === 'function'
        && viewer.isOrgAdminOfOrg(approval.organizationId)) return true;
    return false;
}

/**
 * Read-visibility: decide rights, PLUS the requester watching their own ask
 * (an app's request_approval records the real viewer as requestedBy — they
 * authored the request's contents, so seeing its fate leaks nothing). View
 * only: requestedBy never satisfies canDecide, and an `anon:` id never
 * reaches here with a session at all.
 */
function canView(approval, viewer) {
    if (!approval || !viewer?.userId) return false;
    if (canDecide(approval, viewer)) return true;
    if (approval.requestedBy && approval.requestedBy === viewer.userId) return true;
    // A staged approval is watchable by everyone it concerns for its whole
    // life — the owner, an org admin, and every seat in every stage, whether
    // their turn has come, passed, or was skipped.
    if (hasStages(approval)) {
        if (approval.ownerId === viewer.userId) return true;
        if (approval.organizationId && typeof viewer.isOrgAdminOfOrg === 'function'
            && viewer.isOrgAdminOfOrg(approval.organizationId)) return true;
        return isChainParticipant(approval, viewer);
    }
    // Panel rows narrow canDecide to the current stage — but the owner, the
    // org admin, every seat and the final approver may all WATCH throughout.
    if (hasPanel(approval)) {
        if (approval.ownerId === viewer.userId) return true;
        if (approval.organizationId && typeof viewer.isOrgAdminOfOrg === 'function'
            && viewer.isOrgAdminOfOrg(approval.organizationId)) return true;
        if (isSeatedOnPanel(approval, viewer) || isFinalApprover(approval, viewer)) return true;
    }
    return false;
}

module.exports = {
    isRunless, isOwnDeploymentRequest, deploymentRequesterId, votableSeatCount,
    hasPanel, isSeatedOnPanel, isFinalApprover,
    hasStages, currentStage, isSeatedInStage, isChainParticipant, evaluateStage, seatIndexFor,
    evaluatePanel, mergeVoteAnswers, voteSummary, neededVotes, panelProgress, canDecide, canView,
};

/** @typedef {{ userId?: string|null, groupId?: string|null }} ApprovalSeat  one seat of a panel or stage */

/**
 * @typedef {import('../core/automationModel/approvalStages').ApprovalStage & { remindAfterHours?: number }} ApprovalStage
 *   one stage of a chain: the stored shape is always cleanStages' output
 *   (key, name, description, approvers, rule, quorum, skipped)
 */

/**
 * @typedef {object} ApprovalViewer  who is asking
 * @property {string} [userId]
 * @property {string[]} [groupIds]
 * @property {(orgId: string) => boolean} [isOrgAdminOfOrg]
 */

/**
 * @typedef {object} ApprovalVote  one cast vote, as the store maps it (rowToVote)
 * @property {string} [id]
 * @property {string} [approvalId]
 * @property {string} [stage]
 * @property {number|null} [seatIndex]
 * @property {string} [voterId]
 * @property {string|null} [voterName]
 * @property {string} [decision]
 * @property {string|null} [reason]
 * @property {unknown} [answers]
 * @property {string|Date} [createdAt]
 */

/**
 * @typedef {object} ApprovalLike  the parts of an approval row this rulebook reads
 * @property {string|null} [source]
 * @property {string|null} [requestedBy]
 * @property {string|null} [ownerId]
 * @property {string|null} [organizationId]
 * @property {string|null} [status]
 * @property {string|null} [stage]
 * @property {ApprovalSeat[]|null} [approvers]
 * @property {ApprovalStage[]|null} [stages]
 * @property {string|null} [approvalRule]
 * @property {number|null} [quorumCount]
 * @property {string|null} [finalApproverUserId]
 * @property {string|null} [finalApproverGroupId]
 * @property {string|null} [assigneeUserId]
 * @property {string|null} [assigneeGroupId]
 * @property {string|Date|null} [escalatedAt]
 * @property {string|null} [escalateToUserId]
 * @property {string|null} [escalateToGroupId]
 */

/**
/** @typedef {{ set?: Record<string, Record<string, unknown>>, tableId?: string, recordId?: string }} OnDecidedHook  an app's on_decided hook */

/**
 * @typedef {Omit<NonNullable<ReturnType<typeof import('../stores/automationStore/approvals')._approvalsTest.rowToApproval>>,
 *   'approvers'|'stages'|'answers'|'context'|'onDecided'> & {
 *   approvers: ApprovalSeat[]|null, stages: ApprovalStage[]|null,
 *   answers: Record<string, unknown>|null, context: Record<string, unknown>|null, onDecided: OnDecidedHook|null }} Approval
 *   an approval as the store hands it over (rowToApproval), its jsonb columns typed
 */
