/**
 * approvalLifecycle.js — the durable half of an approval pause.
 *
 * executeAutomation's finalize path calls createApprovalOnPause once the run
 * row is safely in awaiting_approval; the reaper calls the expiry helpers.
 * Everything here is best-effort by contract: an approval ROW failing to
 * write must never fail the RUN — the run's own awaiting_* columns remain
 * the engine's source of truth, and the list path lazily backfills rows.
 *
 * Identity note, stated once and relied on everywhere: whoever ultimately
 * DECIDES an approval, the resumed run continues under the OWNER's identity,
 * credentials and quotas (resumeFromStep re-enters executeAutomation with the
 * automation row). The decider is recorded — approval.decided_by, the audit
 * event, and steps.<id>.output.by — never impersonated.
 */

const automationStore = require('../../stores/automationStore');
require('../../stores/notificationStore');
const { firstStageKey, stageByKey, collectParticipants } = require('../../automation/approvalStages');
const { approvalPath } = require('../../utils/appPaths');
const log = require('../../telemetry/log');

/** How many members of an assigned group get a bell before we stop. */
const GROUP_NOTIFY_CAP = 25;

/**
 * Resolve the org this approval belongs to. Stamped once at creation and
 * frozen: if the owner later changes org, historical approvals stay with the
 * org they were requested in — that is what an audit means.
 */
async function resolveOrgId(automation) {
    if (automation.organizationId) return automation.organizationId;
    try {
        const userStore = require('../../stores/userStore');
        const owner = await userStore.getUser(automation.userId);
        return owner?.organizationId || null;
    } catch { return null; }
}

/**
 * Validate the assignee against the owner's org. Defence in depth — save-time
 * validation exists, but definitions also arrive via import and raw API.
 * Invalid → null (owner-only), with a warn: silently assigning outside the
 * org would leak the approval's existence to a stranger.
 */
async function validateAssignee(assignee, orgId) {
    if (!assignee || !orgId) return assignee && !orgId ? null : assignee ?? null;
    try {
        const userStore = require('../../stores/userStore');
        if (assignee.userId) {
            const u = await userStore.getUser(assignee.userId);
            const { isMemberOfOrg } = require('../../auth/orgMembership');
            if (u && isMemberOfOrg(u, await userStore.getAllGroups(), orgId)) return { userId: assignee.userId };
            log.warn(`[ApprovalLifecycle] assignee user ${assignee.userId} is not in org ${orgId} — falling back to owner`);
            return null;
        }
        if (assignee.groupId) {
            const groups = await userStore.getAllGroups();
            const g = groups.find(x => String(x.id) === String(assignee.groupId));
            if (g && String(g.organizationId || '') === String(orgId)) return { groupId: assignee.groupId };
            log.warn(`[ApprovalLifecycle] assignee group ${assignee.groupId} is not in org ${orgId} — falling back to owner`);
            return null;
        }
    } catch (e) {
        log.warn(`[ApprovalLifecycle] assignee validation failed: ${e.message} — falling back to owner`);
    }
    return null;
}

/**
 * Turn the sentinel's resolved fileIds into a verified snapshot. Only files
 * the run's own journey produced qualify (the ledger's id-is-not-a-capability
 * rule), and each survivor's expiry is pushed out to the approval deadline so
 * an attachment cannot expire before the decision window closes.
 */
async function snapshotAttachments(run, attachmentFileIds, expiresAt) {
    if (!Array.isArray(attachmentFileIds) || !attachmentFileIds.length) return null;
    try {
        const chain = await automationStore.getRunsInChain(run.rootRunId || run.id);
        const runIds = chain.map(r => r.id);
        if (!runIds.includes(run.id)) runIds.push(run.id);
        const live = await automationStore.listGeneratedFilesForRuns(runIds);
        const byId = new Map(live.map(f => [f.id, f]));
        const out = [];
        for (const { fileId, label } of attachmentFileIds) {
            const f = byId.get(fileId);
            if (!f) {
                log.warn(`[ApprovalLifecycle] attachment ${fileId} is not a live file of run ${run.id}'s journey — dropped`);
                continue;
            }
            out.push({ fileId: f.id, filename: f.filename, mimeType: f.mimeType, size: f.size, label: label || null });
        }
        if (out.length && expiresAt) {
            await automationStore.extendGeneratedFileExpiry(out.map(a => a.fileId), expiresAt);
        }
        return out.length ? out : null;
    } catch (e) {
        log.warn(`[ApprovalLifecycle] attachment snapshot failed: ${e.message}`);
        return null;
    }
}

/**
 * Members of a group, capped. JS-side scan because users.groups is a JSON
 * TEXT column — there is no join to write. Stable user-id order so the same
 * 25 people are notified every time, not a lottery.
 */
async function groupMemberIds(groupId, cap = GROUP_NOTIFY_CAP) {
    const userStore = require('../../stores/userStore');
    const { parseGroupIds } = require('../../auth/orgMembership');
    const users = await userStore.getAllUsers();
    const members = users
        .filter(u => parseGroupIds(u).map(String).includes(String(groupId)))
        .map(u => u.id)
        .sort();
    if (members.length > cap) {
        log.warn(`[ApprovalLifecycle] group ${groupId} has ${members.length} members — notifying the first ${cap}`);
    }
    return { ids: members.slice(0, cap), total: members.length };
}

/**
 * Validate a PANEL: each seat through the same org gate as the assignee,
 * invalid seats dropped (never silently kept — a stranger's seat would leak
 * the approval), deduped, capped at 10. An empty result means no panel —
 * the caller falls back to single-assignee/owner semantics.
 */
async function validatePanel(approvers, orgId) {
    if (!Array.isArray(approvers) || !approvers.length) return null;
    const seen = new Set();
    const seats = [];
    for (const raw of approvers.slice(0, 10)) {
        const seat = await validateAssignee(raw, orgId);
        if (!seat) continue;
        const key = seat.userId ? `u:${seat.userId}` : `g:${seat.groupId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        seats.push(seat);
    }
    return seats.length ? seats : null;
}

/**
 * Validate a STAGE CHAIN: every seat of every stage through the same org gate
 * as the assignee. Two rules make the result trustworthy rather than merely
 * tidy:
 *
 *   1. An invalid seat is dropped — silently keeping a stranger's seat would
 *      leak the approval's existence and hand them a vote.
 *   2. A stage that loses ALL its seats falls back to the OWNER, it is never
 *      removed. Dropping it would silently delete a required approval — the
 *      invoice that was supposed to reach Finance would sail past it — and a
 *      chain that quietly got shorter is exactly the failure a stage chain
 *      exists to prevent. The owner can always legitimately decide, so the
 *      link stays in the chain and someone real is asked.
 *
 * Skipped stages (their `when` was false at request time) keep their seats as
 * authored: nobody is asked, and the record still answers "who would have
 * been?".
 */
async function validateStages(stages, orgId, ownerId) {
    if (!Array.isArray(stages) || !stages.length) return null;
    const out = [];
    for (const stage of stages) {
        if (!stage || typeof stage !== 'object') continue;
        if (stage.skipped) { out.push(stage); continue; }
        const seats = await validatePanel(stage.approvers, orgId);
        if (seats) {
            out.push({
                ...stage,
                approvers: seats,
                // Quorum is re-clamped: dropping an out-of-org seat from a
                // "3 of 4" stage must not leave a stage that needs 3 votes
                // from 2 people and can never pass.
                quorum: stage.rule === 'quorum'
                    ? Math.min(Math.max(Math.round(Number(stage.quorum)) || 1, 1), seats.length)
                    : null,
            });
        } else {
            log.warn(`[ApprovalLifecycle] stage "${stage.key}" has no approver inside org ${orgId} — falling back to the owner`);
            out.push({ ...stage, approvers: [{ userId: ownerId }], rule: 'first', quorum: null });
        }
    }
    return out.some(st => !st.skipped) ? out : null;
}

/**
 * Everyone a panel-stage notification reaches: each seat's person, or each
 * group seat's members — capped overall so a huge org group cannot turn one
 * request into a notification storm.
 */
async function panelRecipientIds(approvers, cap = GROUP_NOTIFY_CAP) {
    const out = new Set();
    for (const seat of Array.isArray(approvers) ? approvers : []) {
        if (out.size >= cap) break;
        if (seat?.userId) out.add(seat.userId);
        else if (seat?.groupId) {
            try {
                for (const id of (await groupMemberIds(seat.groupId, cap)).ids) {
                    if (out.size >= cap) break;
                    out.add(id);
                }
            } catch { /* the other seats still hear about it */ }
        }
    }
    return [...out];
}

/**
 * Hours-from-now → timestamps, with one rule: a clock that would fire AFTER
 * the deadline is dropped — reminding someone about an approval that already
 * expired is worse than silence.
 */
function approvalClocks({ remindAfterHours = null, escalateAfterHours = null, expiresAt = null }, now = Date.now()) {
    const deadline = expiresAt ? new Date(expiresAt).getTime() : null;
    const at = (hours) => {
        const h = Number(hours);
        if (!Number.isFinite(h) || h < 1) return null;
        const t = now + Math.min(Math.round(h), 720) * 3_600_000;
        if (deadline && t >= deadline) return null;
        return new Date(t).toISOString();
    };
    return { remindAt: at(remindAfterHours), escalateAt: at(escalateAfterHours) };
}

/**
 * The finalize hook: create the durable approval row for a freshly paused
 * run and return it (or null — never throws).
 */
async function createApprovalOnPause({ automation, run, err }) {
    try {
        const orgId = await resolveOrgId(automation);
        // The chain is the authority when the step has one. renderApprovalExtras
        // already resolved it against the paused run — names interpolated,
        // conditions decided — so all that is left here is the org gate the
        // single assignee has always passed through.
        const stages = await validateStages(err.stages || null, orgId, automation.userId);
        const firstKey = stages ? firstStageKey(stages) : null;
        const firstStage = firstKey ? stageByKey(stages, firstKey) : null;

        // Panel-era columns. With a chain they become MIRRORS of whichever
        // stage is waiting (advanceApprovalStage re-points them as the chain
        // moves), so every pre-stages reader — the request bell, the expiry
        // announcement — still addresses the right people. Without a chain
        // they are the record itself, exactly as before.
        let approvers = stages
            ? firstStage.approvers
            : await validatePanel(err.approvers || null, orgId);
        // With a panel, the single assignee is moot; without one, unchanged.
        let assignee = approvers ? null : await validateAssignee(err.assignee || null, orgId);
        const finalApprover = stages ? null : await validateAssignee(err.finalApprover || null, orgId);
        // Pre-chain rows only: a final sign-off needs stage machinery, so a
        // single approver plus a final approver became a one-seat 'first'
        // panel. desugarApprovalStages now expresses that as two real stages,
        // so this branch is only reachable for definitions that never went
        // through it.
        if (finalApprover && !approvers) {
            approvers = [assignee || { userId: automation.userId }];
            assignee = null;
        }
        const attachments = await snapshotAttachments(run, err.attachmentFileIds, err.expiresAt || null);
        const clocks = approvalClocks({
            remindAfterHours: err.remindAfterHours,
            escalateAfterHours: err.escalateAfterHours,
            expiresAt: err.expiresAt || null,
        });
        // The escalation target passes the same org gate as the assignee —
        // silently escalating to a stranger would leak the approval outright.
        const escalateTo = clocks.escalateAt ? await validateAssignee(err.escalateTo || null, orgId) : null;

        // Frozen at INSERT: which Solution this decision was made inside.
        const { projectStamp } = require('../../automation/approvalProject');
        const project = await projectStamp(automation.projectId);

        const approval = await automationStore.createApproval({
            organizationId: orgId,
            automationId: automation.id,
            automationTitle: automation.title || '',
            ...project,
            runId: run.id,
            rootRunId: run.rootRunId || run.id,
            stepId: err.stepId,
            ownerId: automation.userId,
            assigneeUserId: assignee?.userId || null,
            assigneeGroupId: assignee?.groupId || null,
            prompt: err.prompt || '',
            detailsMd: err.detailsMd || null,
            fields: err.fields || null,
            attachments,
            expiresAt: err.expiresAt || null,
            // App-started runs stamp their app id into the trigger payload
            // (_studioAppId), so "this app's approvals" catches run-sourced
            // rows too — the app that asked can list what it is waiting on.
            studioAppId: run.triggerPayload?._studioAppId || null,
            remindAt: clocks.remindAt,
            // Panels use the final approver as their takeover mechanism, so
            // escalation only applies to single-assignee rows.
            escalateAt: (!approvers && escalateTo) ? clocks.escalateAt : null,
            escalateToUserId: !approvers ? (escalateTo?.userId || null) : null,
            escalateToGroupId: !approvers ? (escalateTo?.groupId || null) : null,
            approvers,
            approvalRule: stages
                ? (firstStage.rule || 'all')
                : (approvers ? (['all', 'first', 'quorum'].includes(err.rule) ? err.rule : 'all') : null),
            quorumCount: stages
                ? (Number.isFinite(firstStage.quorum) ? firstStage.quorum : null)
                : (approvers && err.rule === 'quorum'
                    ? Math.min(Math.max(Math.round(Number(err.quorum)) || 1, 1), approvers.length)
                    : null),
            finalApproverUserId: finalApprover?.userId || null,
            finalApproverGroupId: finalApprover?.groupId || null,
            stages,
            stageParticipants: stages ? collectParticipants(stages) : null,
            stageKey: firstKey,
        });
        if (approval) {
            await automationStore.appendApprovalAudit({
                approvalId: approval.id, runId: run.id, stepId: err.stepId,
                decidedBy: null, decision: 'requested', source: 'runner',
            }).catch(() => {});
            require('../../automation/approvalEvents').dispatchApprovalRequested(approval);
        }
        return approval;
    } catch (e) {
        log.warn(`[ApprovalLifecycle] could not create approval row for run ${run.id}: ${e.message}`);
        return null;
    }
}

/**
 * Who gets the request bell, and where it points. With an assignee the
 * request goes to THEM (the owner sees it in the list and hears about the
 * outcome); unassigned goes to the owner as before.
 */
async function approvalNotificationTargets(approval, automation) {
    const link = approval ? approvalPath(approval.id) : null;
    // Panel rows: every seat hears about the request (group seats fan out to
    // their members, capped overall).
    if (Array.isArray(approval?.approvers) && approval.approvers.length) {
        try {
            const ids = await panelRecipientIds(approval.approvers);
            if (ids.length) return { link, userIds: ids };
        } catch (e) {
            log.warn(`[ApprovalLifecycle] panel recipient resolve failed: ${e.message}`);
        }
    }
    if (approval?.assigneeUserId) return { link, userIds: [approval.assigneeUserId] };
    if (approval?.assigneeGroupId) {
        try {
            const { ids } = await groupMemberIds(approval.assigneeGroupId);
            if (ids.length) return { link, userIds: ids };
        } catch (e) {
            log.warn(`[ApprovalLifecycle] group member resolve failed: ${e.message}`);
        }
    }
    return { link, userIds: [automation.userId] };
}

/**
 * One expired row's fallout: audit event, trigger event, urgent bells to the
 * owner + assignee(s) — an approval dying silently was the bug this whole
 * path fixes. Shared by the run reaper and the app-approval sweep.
 */
async function announceExpiredApproval(ap) {
    await automationStore.appendApprovalAudit({
        approvalId: ap.id, runId: ap.runId, stepId: ap.stepId,
        decidedBy: null, decision: 'expired', source: 'reaper',
    }).catch(() => {});
    require('../../automation/approvalEvents').dispatchApprovalDecided(ap);
    await require('../../automation/approvalHooks').runOnDecidedHook(ap);
    // Owner + whoever was asked (assignee, group, or every panel seat),
    // urgent — direct store writes (the reaper has no per-run notification
    // policy in hand, and expiry is never noise).
    const recipients = new Set([ap.ownerId]);
    if (Array.isArray(ap.approvers) && ap.approvers.length) {
        try { for (const id of await panelRecipientIds(ap.approvers)) recipients.add(id); }
        catch { /* owner alone still hears about it */ }
        if (ap.finalApproverUserId) recipients.add(ap.finalApproverUserId);
    } else if (ap.assigneeUserId) recipients.add(ap.assigneeUserId);
    else if (ap.assigneeGroupId) {
        try { for (const id of (await groupMemberIds(ap.assigneeGroupId)).ids) recipients.add(id); }
        catch { /* owner alone still hears about it */ }
    }
    const closed = ap.source === 'app'
        ? 'nobody decided before the deadline, so the request was closed.'
        : 'nobody decided before the deadline, so the run was closed.';
    // card:false — the window has closed; a card whose 👍 decides nothing
    // would only invite someone to try.
    const { notifyApproval, automationForApproval } = require('../../automation/approvalNotify');
    await notifyApproval({
        approval: ap,
        automation: await automationForApproval(ap),
        recipientIds: [...recipients],
        category: 'urgent',
        title: `⏰ Approval expired: ${ap.automationTitle || 'approval request'}`,
        message: `${ap.prompt || 'An approval'} — ${closed}`,
        card: false,
    }).catch(() => {});
}

/**
 * Reaper hook: flip rows for deadline-expired runs, log the event, and TELL
 * someone.
 */
async function expireApprovalsForReapedRuns(reapedRuns) {
    if (!Array.isArray(reapedRuns) || !reapedRuns.length) return;
    let expired = [];
    try {
        expired = await automationStore.expireApprovalsForRuns(reapedRuns.map(r => r.id));
    } catch (e) {
        log.warn(`[ApprovalLifecycle] expiry sweep failed: ${e.message}`);
        return;
    }
    for (const ap of expired) await announceExpiredApproval(ap);
}

/**
 * Who a reminder for this row reaches: the seats of the CURRENT stage that
 * have not voted yet (panels and chains), else the assignee or the assigned
 * group's members, else the owner. Shared by the reaper's scheduled reminder
 * and the "send reminder" button (POST /approvals/:id/remind), so the two
 * can never nudge different people.
 */
async function reminderRecipientIds(ap) {
    const recipients = new Set();
    if (Array.isArray(ap.approvers) && ap.approvers.length) {
        // Panel and staged rows: nudge only those still owing a decision
        // — someone who already voted must not read "still waiting on
        // you". Everything here keys off ap.stage, the row's CURRENT
        // stage, never off a literal: on a five-stage chain the waiting
        // stage is 's3' as readily as it is 'panel', and comparing votes
        // against the wrong stage would nudge people who have already
        // decided while missing the ones who have not.
        const stageKey = ap.stage || 'panel';
        try {
            const chainStage = Array.isArray(ap.stages)
                ? ap.stages.find(st => st && st.key === stageKey)
                : null;
            if (!chainStage && stageKey === 'final') {
                // Pre-chain two-stage row: the final approver is a column,
                // not a seat list.
                if (ap.finalApproverUserId) recipients.add(ap.finalApproverUserId);
                else if (ap.finalApproverGroupId) {
                    for (const id of (await groupMemberIds(ap.finalApproverGroupId)).ids) recipients.add(id);
                }
            } else {
                const seats = chainStage?.approvers || ap.approvers;
                const voted = new Set((await automationStore.getApprovalVotes(ap.id))
                    .filter(v => v.stage === stageKey).map(v => v.voterId));
                for (const id of await panelRecipientIds(seats)) {
                    if (!voted.has(id)) recipients.add(id);
                }
            }
        } catch { /* fall through to the owner */ }
    } else if (ap.assigneeUserId) recipients.add(ap.assigneeUserId);
    else if (ap.assigneeGroupId) {
        try { for (const id of (await groupMemberIds(ap.assigneeGroupId)).ids) recipients.add(id); }
        catch { /* fall through to the owner */ }
    }
    if (!recipients.size) recipients.add(ap.ownerId);
    return [...recipients];
}

/**
 * The Bee Flow bell body of a reminder: the prompt on its own line (when
 * there is one), then the nudge. No dash as punctuation.
 */
function reminderBellMessage(ap, deadline = '') {
    const prompt = String(ap?.prompt || '').trim();
    const nudge = `Nobody has decided yet.${deadline}`;
    return prompt ? `${prompt}\n${nudge}` : nudge;
}

/**
 * Send one "still waiting on you" reminder through the approval notification
 * path (bell plus the channels the routine's policy names). Returns the ids it
 * went to. Never throws: notifyApproval swallows its own failures.
 */
async function sendApprovalReminder(ap) {
    const { notifyApproval, automationForApproval } = require('../../automation/approvalNotify');
    const recipients = await reminderRecipientIds(ap);
    const deadline = ap.expiresAt ? ` It expires ${new Date(ap.expiresAt).toLocaleString()}.` : '';
    // The request is still live, so the nudge goes out on every channel
    // the policy names — a reminder that only reaches a bell the org
    // stopped watching is the bug this dispatcher exists to fix.
    // `message` is the Bee Flow bell's body and may quote the prompt; the
    // Talk card is rendered from the allow-listed announcement instead
    // (automation/approvalAnnouncement.js), so the prompt stays in Bee Flow.
    await notifyApproval({
        approval: ap,
        automation: await automationForApproval(ap),
        recipientIds: recipients,
        category: 'heads_up',
        title: `⏳ Still waiting on you: ${ap.automationTitle || 'approval'}`,
        message: reminderBellMessage(ap, deadline),
    }).catch(() => {});
    return recipients;
}

/**
 * Reaper pass: reminders + escalations. Both are conditional UPDATEs in the
 * store (the stamp is claimed exactly once across pods); this side turns each
 * claimed row into bells and — for escalations — an audit event. Escalation
 * WIDENS the decider set: canDecide and the list scope admit the target the
 * moment escalated_at is stamped; nobody loses rights.
 */
async function remindAndEscalateDueApprovals() {
    const { notifyApproval, automationForApproval } = require('../../automation/approvalNotify');
    let due = [];
    try { due = await automationStore.markDueApprovalReminders(); }
    catch (e) { log.warn(`[ApprovalLifecycle] reminder sweep failed: ${e.message}`); }
    for (const ap of due) {
        await sendApprovalReminder(ap).catch(() => {});
    }

    let escalated = [];
    try { escalated = await automationStore.markDueApprovalEscalations(); }
    catch (e) { log.warn(`[ApprovalLifecycle] escalation sweep failed: ${e.message}`); }
    for (const ap of escalated) {
        await automationStore.appendApprovalAudit({
            approvalId: ap.id, runId: ap.runId, stepId: ap.stepId,
            decidedBy: null, decision: 'escalated', source: 'reaper',
        }).catch(() => {});
        const targets = new Set();
        if (ap.escalateToUserId) targets.add(ap.escalateToUserId);
        else if (ap.escalateToGroupId) {
            try { for (const id of (await groupMemberIds(ap.escalateToGroupId)).ids) targets.add(id); }
            catch { /* owner hears below */ }
        }
        targets.add(ap.ownerId);
        // The escalation target has never been asked — a fresh request to
        // them, card included.
        await notifyApproval({
            approval: ap,
            automation: await automationForApproval(ap),
            recipientIds: [...targets],
            category: 'urgent',
            title: `⚠️ Escalated to you: ${ap.automationTitle || 'approval'}`,
            message: `${ap.prompt || 'An approval'} — the original approver did not decide in time. You can now decide it.`,
        }).catch(() => {});
    }
}

/**
 * Reaper hook for APP-sourced approvals: they have no run for the run reaper
 * to notice, so their deadline gets its own conditional-UPDATE sweep.
 */
async function expireOverdueAppApprovals() {
    let expired = [];
    try {
        expired = await automationStore.expireOverduePendingApprovals();
    } catch (e) {
        log.warn(`[ApprovalLifecycle] app-approval expiry sweep failed: ${e.message}`);
        return;
    }
    for (const ap of expired) await announceExpiredApproval(ap);
}

module.exports = {
    createApprovalOnPause,
    reminderRecipientIds,
    sendApprovalReminder,
    approvalNotificationTargets,
    expireApprovalsForReapedRuns,
    expireOverdueAppApprovals,
    remindAndEscalateDueApprovals,
    approvalClocks,
    groupMemberIds,
    panelRecipientIds,
    validateAssignee,
    validatePanel,
    validateStages,
    GROUP_NOTIFY_CAP,
    _approvalLifecycleTest: { resolveOrgId, validateAssignee, snapshotAttachments, groupMemberIds, reminderBellMessage },
};
