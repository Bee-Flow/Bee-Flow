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
 * approving a colleague's routine is authorising the owner's own automation
 * to continue, not running anything as themselves.
 */

const automationStore = require('../stores/automationStore');
const log = require('../telemetry/log');

/** Small typed outcome so routes stay one-line thin. */
function outcome(code, body) { return { code, body }; }

async function deciderName(userId) {
    try {
        const userStore = require('../stores/userStore');
        const u = await userStore.getUser(userId);
        return u?.name || u?.email || null;
    } catch { return null; }
}

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
    } catch { /* plain row without the question beats no row */ }
    let organizationId = automation?.organizationId || null;
    if (!organizationId) {
        try {
            const userStore = require('../stores/userStore');
            organizationId = (await userStore.getUser(run.userId))?.organizationId || null;
        } catch { /* consumer account */ }
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
        }).catch(() => {});
    }
    return row;
}

/**
 * Can `viewer` decide this approval? Owner, the assignee, a member of the
 * assigned group, or an org admin of the approval's org. `viewer` is what the
 * route already proved: { userId, groupIds: [String], isOrgAdminOfOrg(orgId) }.
 */
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
// path below, so nothing authored before this release changes behaviour.

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
function evaluateStage(stage, stageVotes) {
    return evaluatePanel(
        { approvers: stage.approvers || [], approvalRule: stage.rule, quorumCount: stage.quorum },
        stageVotes,
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
function evaluatePanel(approval, panelVotes) {
    const seatCount = approval.approvers.length;
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
function panelProgress(approval, votes) {
    if (hasStages(approval)) {
        const { activeStages, stagePosition } = require('./approvalStages');
        const cur = currentStage(approval);
        const order = activeStages(approval.stages).map(st => st.key);
        const curIdx = cur ? order.indexOf(cur.key) : -1;
        const terminal = approval.status && approval.status !== 'pending';
        return {
            kind: 'stages',
            stage: cur?.key || null,
            position: cur ? stagePosition(approval.stages, cur.key) : null,
            stages: approval.stages.map((st) => {
                const stageVotes = (votes || []).filter(v => v.stage === st.key);
                const approvals = stageVotes.filter(v => v.decision === 'approve').length;
                const seatCount = (st.approvers || []).length;
                const idx = order.indexOf(st.key);
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
                    needed: st.rule === 'quorum'
                        ? Math.min(Math.max(Number(st.quorum) || 1, 1), seatCount)
                        : (st.rule === 'first' ? 1 : seatCount),
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
        needed: rule === 'quorum'
            ? Math.min(Math.max(Number(approval.quorumCount) || 1, 1), seatCount)
            : (rule === 'first' ? 1 : seatCount),
        hasFinalStage: !!(approval.finalApproverUserId || approval.finalApproverGroupId),
    };
}

function canDecide(approval, viewer) {
    if (!approval || !viewer?.userId) return false;
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
    // Deadline: expired approvals refuse the decision and flip the row so the
    // list agrees with the refusal the caller just saw.
    if (approval.expiresAt && new Date(approval.expiresAt).getTime() < Date.now()) {
        const flipped = await automationStore.decideApproval(approval.id, { status: 'expired', decidedBy: null });
        await automationStore.appendApprovalAudit({
            approvalId: approval.id, runId: approval.runId, stepId: approval.stepId,
            decidedBy: null, decision: 'expired', source,
        }).catch(() => {});
        if (flipped) {
            require('./approvalEvents').dispatchApprovalDecided(flipped);
            await require('./approvalHooks').runOnDecidedHook(flipped);
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

    // Run guard — for RUN-sourced approvals only. An app-sourced approval has
    // no run by design: the decision itself is the outcome (recorded on the
    // row, delivered via the on_decided hook and the approval.decided event).
    const isAppSourced = approval.source === 'app';
    if (!isAppSourced && (!run || run.status !== 'awaiting_approval' || !run.awaitingStepId)) {
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
 * The TERMINAL machinery, shared by the single-assignee path and a panel
 * whose rule just resolved: the conditional decision write, audit, the
 * approval.decided event, the on_decided hook, the owner bell, and — for
 * run-sourced rows — failing or resuming the run. `votes` (panel rows)
 * travels into the resume decision object and the response, so downstream
 * steps can read steps.<id>.output.votes.
 */
async function finalizeDecision({ approval, run, deciderId, decision, trimmedReason, coercedAnswers, source, votes = null }) {
    const isAppSourced = approval.source === 'app';
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

    // Tell the owner when someone else decided their routine's approval.
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

    // App-sourced: there is no run to resume or fail — the decided row IS the
    // outcome. The app learns of it via its own refetch, the on_decided
    // record-write hook (phase 3) and the approval.decided event above.
    if (isAppSourced) {
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
        return outcome(200, { accepted: true, decision: 'reject', approval: decided, run: fresh });
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
    return outcome(200, { accepted: true, decision: 'approve', approval: decided, run: newRun });
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
        voterName = u?.name || u?.email || null;
        groupIds = u ? parseGroupIds(u).map(String) : [];
    } catch { /* seat matching falls back to personal seats only */ }
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
    }).catch(() => {});

    const allVotes = [...votes, vote];
    const verdict = evaluateStage(stage, [...stageVotes, vote]);

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
                }).catch(() => {});
                await notifyStageApprovers(advanced, next).catch(() => {});
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

/** The next stage's reminder deadline, or undefined to leave the clock alone. */
function nextStageRemindAt(approval, stage) {
    const hours = Number(stage?.remindAfterHours);
    if (!Number.isFinite(hours) || hours < 1) return undefined;
    const { approvalClocks } = require('../core/automationRunner/approvalLifecycle');
    return approvalClocks({ remindAfterHours: hours, expiresAt: approval.expiresAt || null }).remindAt;
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
        recipientIds: await panelRecipientIds(stage.approvers),
        category: 'heads_up',
        title: `🔔 Your approval is needed: ${stage.name}`,
        message: `${approval.prompt || 'An approval'}${where}${stage.description ? ` — ${stage.description}` : ''}`,
    }).catch(() => {});
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
        voterName = u?.name || u?.email || null;
        groupIds = u ? parseGroupIds(u).map(String) : [];
    } catch { /* seat matching falls back to personal seats only */ }
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
        }).catch(() => {});
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
    }).catch(() => {});

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
                }).catch(() => {});
                await notifyFinalApprover(advanced).catch(() => {});
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
    }).catch(() => {});
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
    }).catch(() => {});
    require('./approvalEvents').dispatchApprovalDecided(cancelled);
    await require('./approvalHooks').runOnDecidedHook(cancelled);

    // Close the paused run — it is the withdrawn question's mechanism.
    if (approval.runId) {
        const run = await automationStore.getRun(approval.runId).catch(() => null);
        if (run && run.status === 'awaiting_approval' && run.awaitingStepId === approval.stepId) {
            await automationStore.updateRun(run.id, {
                status: 'cancelled',
                summary: 'Approval withdrawn — the run was closed without a decision.',
                finishedAt: new Date().toISOString(),
                awaitingStepId: null,
                approvalToken: null,
            }).catch(() => {});
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
        }).catch(() => {});
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
    const owner = await userStore.getUser(ownerId).catch(() => null);
    const orgId = owner?.organizationId || null;
    const groups = await userStore.getAllGroups().catch(() => []);
    const errors = [];
    for (const s of steps) {
        const a = s.approval.assignee;
        if (a.userId) {
            const u = await userStore.getUser(a.userId).catch(() => null);
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
    // Panel machinery — the routes render progress; tests pin the rulebook.
    hasPanel, panelProgress, voteSummary, seatIndexFor,
    // Stage machinery — the routes need to know whose turn it is.
    hasStages, currentStage, isSeatedInStage, isChainParticipant,
    _panelTest: { evaluatePanel, mergeVoteAnswers, isSeatedOnPanel, isFinalApprover },
    _stageTest: { evaluateStage, nextStageRemindAt },
};
