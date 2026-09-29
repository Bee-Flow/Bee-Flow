/**
 * approvalEvents — the one place approval trigger events are assembled and
 * dispatched, so the payload cannot drift between the four emitters
 * (request, decide, withdraw, reaper expiry).
 *
 * Scope routing mirrors the row's own tenancy: rows with an organisation
 * dispatch org-scoped (any subscriber in the org may react — the same
 * visibility the org admin list has); rows without one (consumer accounts)
 * fall back to a user-scoped dispatch addressed to the OWNER — the only
 * person who can even see the approval.
 *
 * Fire-and-forget by contract: an event fan-out failure must never fail the
 * decision (or the pause) that produced it. Callers do not await this.
 *
 * Two fan-outs, one assembly point. Alongside the trigger dispatch (which is
 * what lets an automation subscribe to `approval.decided`), each event is also
 * written into the feed of the project the approval was stamped with, so a
 * decision shows up live on the project page. The two are independent by
 * design: the trigger bus is an automation-facing integration surface, the
 * project feed is a human-facing one, and neither failing may affect the other
 * or the decision that produced them.
 */

/**
 * The chain, flattened for a subscriber. Votes already carry a stage KEY, but
 * a key is an internal handle — a routine writing "approved by Finance" needs
 * the name, the rule and whether the stage ran at all. Kept small on purpose:
 * seats are the row's business, not the event's.
 */
const log = require('../telemetry/log');
function stagesPayload(approval) {
    if (!Array.isArray(approval.stages) || !approval.stages.length) return null;
    return approval.stages.map(st => ({
        key: st.key,
        name: st.name || st.key,
        description: st.description || null,
        rule: st.rule || 'all',
        skipped: st.skipped === true,
    }));
}

/** Fields shared by every approval event, straight off the row. */
function basePayload(approval) {
    return {
        approvalId: approval.id,
        source: approval.source || 'run',
        prompt: approval.prompt || '',
        automationId: approval.automationId || null,
        runId: approval.runId || null,
        studioAppId: approval.studioAppId || null,
        requestedBy: approval.requestedBy || null,
        assigneeUserId: approval.assigneeUserId || null,
        assigneeGroupId: approval.assigneeGroupId || null,
        context: approval.context || null,
        // The chain, when the approval has one — null for single-approver and
        // panel rows, so a subscriber can branch on its presence.
        stages: stagesPayload(approval),
        // The stage the row is ON: the one waiting on `approval.requested`,
        // the one it finished at on `approval.decided`.
        stage: approval.stage || null,
    };
}

function dispatch(event, payload, approval) {
    try {
        const { dispatchEvent, dispatchOrgScopedEvent } = require('./triggerBus/dispatch');
        const p = approval.organizationId
            ? dispatchOrgScopedEvent('approvals', event, payload, approval.organizationId)
            : dispatchEvent({ provider: 'approvals', event, payload, userId: approval.ownerId });
        Promise.resolve(p).catch(e => log.warn(`[ApprovalEvents] ${event} dispatch failed: ${e.message}`));
    } catch (e) {
        log.warn(`[ApprovalEvents] ${event} dispatch failed: ${e.message}`);
    }
}

/**
 * Mirror the event into the project feed.
 *
 * ── What must NOT travel, and why ───────────────────────────────────────────
 *
 * The approvals LISTING is viewer-scoped on purpose: `projectId` narrows the
 * scope that owner/assignee/requester/panel-seat/escalation-target already
 * defines, so a project member sees the approvals here that are theirs to see
 * and not every approval in the project. The project feed has no such scope —
 * it is broadcast to every member over SSE and replayed from project_events.
 *
 * So the feed carries the FACT and not the CONTENT: no `prompt`, no
 * `detailsMd`, no `fields`, no `answers`, no `attachments`, no `context`, and
 * no assignee identities. "An approval was raised on Release, and Bob approved
 * it" is the ambient awareness the project page wants; the question itself
 * stays behind the listing that scopes it. Anyone entitled to the detail opens
 * the approval and gets it there.
 *
 * No-op for an approval with no project — which is most of them. Nothing is
 * awaited: this sits behind the same fire-and-forget contract as dispatch().
 */
function feed(kind, approval, extra = {}) {
    if (!approval?.projectId) return;
    try {
        const { emitProjectEvent } = require('../core/projectFeed');
        Promise.resolve(emitProjectEvent(approval.projectId, {
            kind,
            // The decider for a decision, nobody for a request: a run pausing
            // is the system asking, not a person acting.
            actorId: approval.decidedBy || null,
            targetType: 'approval',
            targetId: approval.id,
            payload: {
                approvalId: approval.id,
                source: approval.source || 'run',
                // The automation's own name, which every member can already see
                // in the project's contents — unlike the question it asks.
                automationId: approval.automationId || null,
                automationTitle: approval.automationTitle || '',
                studioAppId: approval.studioAppId || null,
                ...extra,
            },
        }, { label: 'ApprovalEvents' })).catch(e =>
            log.warn(`[ApprovalEvents] ${kind} feed failed: ${e.message}`));
    } catch (e) {
        log.warn(`[ApprovalEvents] ${kind} feed failed: ${e.message}`);
    }
}

/** A fresh pending row exists — from a paused run or an app request. */
function dispatchApprovalRequested(approval) {
    if (!approval) return;
    dispatch('approval.requested', {
        ...basePayload(approval),
        expiresAt: approval.expiresAt || null,
    }, approval);
    feed('approval.requested', approval, { expiresAt: approval.expiresAt || null });
}

/**
 * The row reached a final status. `decision` is that status —
 * approved | rejected | expired | cancelled — so one subscription can route
 * all four outcomes with a filter. Pass the DECIDED row (post-update), so
 * decidedBy/reason/answers are the recorded facts, not the request's claim.
 */
function dispatchApprovalDecided(approval, { votes = null } = {}) {
    if (!approval || approval.status === 'pending') return;
    // Emitted once, here, rather than on each of the two dispatch exits below:
    // the project feed shows THAT it was decided and by whom, and does not
    // wait on the per-seat vote evidence that only subscribers need.
    feed('approval.decided', approval, {
        decision: approval.status,
        decidedByName: approval.decidedByName || null,
    });
    const payload = {
        ...basePayload(approval),
        decision: approval.status,
        reason: approval.decisionReason || null,
        answers: approval.answers || null,
        decidedBy: approval.decidedBy || null,
        decidedByName: approval.decidedByName || null,
        votes: Array.isArray(votes)
            ? votes.map(v => ({ by: v.by ?? v.voterId, name: v.name ?? v.voterName ?? null, decision: v.decision, reason: v.reason ?? null, stage: v.stage }))
            : null,
    };
    // A panel row reaching a final status through a path that has no votes in
    // hand (reaper expiry, orphan close) still owes subscribers the evidence —
    // fetched inside the fire-and-forget, never on the caller's clock.
    if (payload.votes === null && Array.isArray(approval.approvers) && approval.approvers.length) {
        Promise.resolve()
            .then(async () => {
                const automationStore = require('../stores/automationStore');
                const rows = await automationStore.getApprovalVotes(approval.id).catch(() => []);
                payload.votes = rows.map(v => ({ by: v.voterId, name: v.voterName || null, decision: v.decision, reason: v.reason || null, stage: v.stage }));
                dispatch('approval.decided', payload, approval);
            })
            .catch(e => log.warn(`[ApprovalEvents] decided dispatch failed: ${e.message}`));
        return;
    }
    dispatch('approval.decided', payload, approval);
}

module.exports = { dispatchApprovalRequested, dispatchApprovalDecided };
