// @typecheck
/**
 * approvals.js — durable approval decision records.
 *
 * The run is the MECHANISM of an approval (awaiting_step_id, the token, the
 * resume); the row here is the PRODUCT and the AUDIT. It outlives the run
 * (run_id ON DELETE SET NULL, automation_id has no FK), carries the rendered
 * snapshot of what the approver saw at pause time, and is the only table an
 * approvals list ever queries — run scoping stays exactly as user-private as
 * it always was.
 *
 * Two invariants:
 *
 *   • ONE pending row per (run_id, step_id) — enforced by a partial unique
 *     index, which is what lets the pause path and the lazy backfill race
 *     safely (both INSERT ... ON CONFLICT DO NOTHING).
 *   • A decision happens exactly once: decideApproval is a conditional
 *     UPDATE ... WHERE status='pending' RETURNING * — the loser of a race
 *     gets zero rows back, never a second resume.
 *
 * Visibility scoping lives in the WHERE builders here, not in routes: the
 * viewer object carries what the route has already proven about the caller
 * (their id, their group ids, whether they are an org admin of `orgId`), and
 * the SQL only ever narrows.
 */

const crypto = require('crypto');
const { run, getOne, getAll } = require('./core');
const { fromJsonb } = require('./rowMappers');
const { buildUpdate } = require('../lib/sqlBuilder');

const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'expired', 'cancelled'];

function rowToApproval(r) {
    if (!r) return null;
    return {
        id: r.id,
        organizationId: r.organization_id ?? null,
        // Which Solution this decision was made inside. Frozen at INSERT and
        // never cleared, so it still reads after the project (or the
        // automation) is gone — see approvals-project-id-2026-09.
        projectId: r.project_id ?? null,
        projectTitle: r.project_title || '',
        automationId: r.automation_id ?? null,
        automationTitle: r.automation_title || '',
        runId: r.run_id ?? null,
        rootRunId: r.root_run_id ?? null,
        stepId: r.step_id ?? null,
        // Where the row came from. 'run' — a paused automation, approve
        // resumes it. 'app' — an App Studio request_approval action; there is
        // no run, the decision IS the outcome (on_decided + trigger event).
        // 'deployment' — a Solution's PRD deployment gate; no run either, the
        // decision moves the deployment (solutionStageStore).
        source: r.source || 'run',
        deploymentId: r.deployment_id ?? null,
        requestedBy: r.requested_by ?? null,
        studioAppId: r.studio_app_id ?? null,
        actionId: r.action_id ?? null,
        context: fromJsonb(r.context),
        onDecided: fromJsonb(r.on_decided),
        remindAt: r.remind_at ?? null,
        reminderSentAt: r.reminder_sent_at ?? null,
        escalateAt: r.escalate_at ?? null,
        escalatedAt: r.escalated_at ?? null,
        escalateToUserId: r.escalate_to_user_id ?? null,
        escalateToGroupId: r.escalate_to_group_id ?? null,
        ownerId: r.owner_id,
        assigneeUserId: r.assignee_user_id ?? null,
        assigneeGroupId: r.assignee_group_id ?? null,
        // Panel columns (NULL everywhere = the single-assignee behaviour).
        approvers: fromJsonb(r.approvers),
        approvalRule: r.approval_rule ?? null,
        quorumCount: r.quorum_count ?? null,
        // The stage CHAIN (ordered, 1..5). The five columns above are the
        // panel-era mirrors kept write-through for un-migrated readers.
        stages: fromJsonb(r.approval_stages),
        stageParticipants: fromJsonb(r.stage_participants),
        stageEnteredAt: r.stage_entered_at ?? null,
        stage: r.stage ?? null,
        finalApproverUserId: r.final_approver_user_id ?? null,
        finalApproverGroupId: r.final_approver_group_id ?? null,
        status: r.status,
        prompt: r.prompt || '',
        detailsMd: r.details_md ?? null,
        fields: fromJsonb(r.fields),
        attachments: fromJsonb(r.attachments),
        answers: fromJsonb(r.answers),
        decidedBy: r.decided_by ?? null,
        decidedByName: r.decided_by_name ?? null,
        decisionReason: r.decision_reason ?? null,
        decidedAt: r.decided_at ?? null,
        expiresAt: r.expires_at ?? null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}

function newApprovalId() {
    return 'apr_' + crypto.randomBytes(18).toString('hex');
}

/**
 * Insert the pending row for a paused step. ON CONFLICT on the pending-unique
 * index makes this idempotent against the backfill racing the pause path; the
 * winner's row is returned either way.
 */
async function createApproval({
    organizationId = null, automationId = null, automationTitle = '',
    projectId = null, projectTitle = '',
    runId = null, rootRunId = null, stepId = null, ownerId,
    assigneeUserId = null, assigneeGroupId = null,
    prompt = '', detailsMd = null, fields = null, attachments = null,
    expiresAt = null,
    // v2 — source-agnostic extras. Run-sourced callers omit all of these.
    source = 'run', requestedBy = null, studioAppId = null, actionId = null,
    context = null, onDecided = null, remindAt = null, escalateAt = null,
    escalateToUserId = null, escalateToGroupId = null,
    // Panel — approvers implies stage 'panel'; NULLs everywhere = legacy.
    approvers = null, approvalRule = null, quorumCount = null,
    finalApproverUserId = null, finalApproverGroupId = null,
    // The stage chain. When present it is the authority; the five panel-era
    // arguments above are derived from it by the caller and written through
    // as legacy mirrors.
    stages = null, stageParticipants = null, stageKey = null,
    // source='deployment': the solution_deployments row this gate guards.
    deploymentId = null,
}) {
    const id = newApprovalId();
    const hasStages = Array.isArray(stages) && stages.length > 0;
    const hasPanel = hasStages || (Array.isArray(approvers) && approvers.length > 0);
    await run(
        `INSERT INTO automation_approvals
            (id, organization_id, automation_id, automation_title, project_id, project_title,
             run_id, root_run_id, step_id,
             owner_id, assignee_user_id, assignee_group_id, status, prompt, details_md,
             fields, attachments, expires_at,
             source, requested_by, studio_app_id, action_id, context, on_decided, remind_at, escalate_at,
             escalate_to_user_id, escalate_to_group_id,
             approvers, approval_rule, quorum_count, stage, final_approver_user_id, final_approver_group_id,
             approval_stages, stage_participants, stage_entered_at, deployment_id)
         VALUES ($1,$2,$3,$4,$34,$35,$5,$6,$7,$8,$9,$10,'pending',$11,$12,$13,$14,$15,
                 $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,
                 $26,$27,$28,$29,$30,$31,
                 $32,$33, CASE WHEN $32::jsonb IS NULL THEN NULL ELSE NOW() END, $36)
         ON CONFLICT (run_id, step_id) WHERE status = 'pending' DO NOTHING`,
        [id, organizationId, automationId, automationTitle, runId, rootRunId, stepId,
         ownerId, assigneeUserId, assigneeGroupId, prompt, detailsMd,
         fields ? JSON.stringify(fields) : null,
         attachments ? JSON.stringify(attachments) : null,
         expiresAt,
         source, requestedBy, studioAppId, actionId,
         context ? JSON.stringify(context) : null,
         onDecided ? JSON.stringify(onDecided) : null,
         remindAt, escalateAt, escalateToUserId, escalateToGroupId,
         hasPanel && Array.isArray(approvers) && approvers.length ? JSON.stringify(approvers) : null,
         hasPanel ? (approvalRule || 'all') : null,
         hasPanel ? quorumCount : null,
         // The row's CURRENT stage key: the chain's first stage when there is
         // a chain, else the panel-era literal.
         hasStages ? (stageKey || null) : (hasPanel ? 'panel' : null),
         finalApproverUserId, finalApproverGroupId,
         hasStages ? JSON.stringify(stages) : null,
         hasStages && stageParticipants ? JSON.stringify(stageParticipants) : null,
         // $34/$35 — appended, like the stage columns above, so that adding a
         // column never shifts an existing placeholder index.
         projectId, projectTitle,
         // $36 — appended for the same reason.
         deploymentId],
    );
    // On conflict the insert wrote nothing — hand back whichever row won.
    // App-sourced rows (run_id NULL) can never conflict: NULLs are distinct
    // in the pending-unique index, so the insert always lands.
    if (!runId) return getApproval(id);
    return getApprovalForRunStep(runId, stepId, { pendingOnly: true }) || getApproval(id);
}

async function getApproval(id) {
    const r = await getOne(`SELECT * FROM automation_approvals WHERE id = $1`, [id]);
    return rowToApproval(r);
}

async function getApprovalForRunStep(runId, stepId, { pendingOnly = false } = {}) {
    const r = await getOne(
        `SELECT * FROM automation_approvals
          WHERE run_id = $1 AND step_id = $2 ${pendingOnly ? `AND status = 'pending'` : ''}
          ORDER BY created_at DESC LIMIT 1`,
        [runId, stepId],
    );
    return rowToApproval(r);
}

/**
 * The scope WHERE. `viewer` is what the route proved about the caller:
 *   { userId, groupIds: [] }              — the 'mine' scope: rows they own,
 *                                           are assigned, or can decide via a group
 *   { orgId }                             — the 'org' scope: the route has
 *                                           already established org-admin rights
 * Exactly one of the two shapes is passed; both present is a caller bug.
 */
function buildApprovalWhere({ viewer = null, org = null, status = [], cursor = null,
    appId = null, automationId = null, projectId = null, q = null }, params) {
    const conds = [];
    const add = (sql, v) => { params.push(v); conds.push(sql.replace('$$', `$${params.length}`)); };

    if (org && org.orgId) {
        add('organization_id = $$', org.orgId);
    } else if (viewer && viewer.userId) {
        const groupIds = Array.isArray(viewer.groupIds) ? viewer.groupIds.filter(Boolean) : [];
        params.push(viewer.userId);
        const uIdx = params.length;
        // requested_by: someone who ASKED (an app's request_approval) may watch
        // their own request — they authored its contents. View only; decide
        // rights stay with canDecide. The escalation clause mirrors canDecide:
        // the escalation target joins the decider set only once escalated_at
        // is stamped — before that the row is not theirs to see.
        if (groupIds.length) {
            params.push(groupIds);
            const gIdx = params.length;
            conds.push(`(owner_id = $${uIdx} OR assignee_user_id = $${uIdx} OR requested_by = $${uIdx} OR assignee_group_id = ANY($${gIdx})`
                + ` OR (escalated_at IS NOT NULL AND (escalate_to_user_id = $${uIdx} OR escalate_to_group_id = ANY($${gIdx})))`
                + ` OR final_approver_user_id = $${uIdx} OR final_approver_group_id = ANY($${gIdx})`
                + ` OR (approvers IS NOT NULL AND EXISTS (SELECT 1 FROM jsonb_array_elements(approvers) seat`
                + ` WHERE seat->>'userId' = $${uIdx} OR seat->>'groupId' = ANY($${gIdx})))`
                // The stage chain's flat participant index — ONE indexable
                // scan (GIN). Nesting stages × seats here would be correct and
                // unservable by any index, which is why the index exists.
                + ` OR (stage_participants IS NOT NULL AND EXISTS (`
                + ` SELECT 1 FROM jsonb_array_elements(stage_participants) seat`
                + ` WHERE seat->>'userId' = $${uIdx} OR seat->>'groupId' = ANY($${gIdx}))))`);
        } else {
            conds.push(`(owner_id = $${uIdx} OR assignee_user_id = $${uIdx} OR requested_by = $${uIdx}`
                + ` OR (escalated_at IS NOT NULL AND escalate_to_user_id = $${uIdx})`
                + ` OR final_approver_user_id = $${uIdx}`
                + ` OR (approvers IS NOT NULL AND EXISTS (SELECT 1 FROM jsonb_array_elements(approvers) seat`
                + ` WHERE seat->>'userId' = $${uIdx}))`
                + ` OR (stage_participants IS NOT NULL AND EXISTS (`
                + ` SELECT 1 FROM jsonb_array_elements(stage_participants) seat`
                + ` WHERE seat->>'userId' = $${uIdx})))`);
        }
    } else {
        // Fail CLOSED: a filter that scopes to nobody returns nothing rather
        // than everything.
        conds.push('FALSE');
    }

    const statuses = (Array.isArray(status) ? status : [status]).filter(s => APPROVAL_STATUSES.includes(s));
    if (statuses.length) { params.push(statuses); conds.push(`status = ANY($${params.length})`); }

    // Narrowing filters — always intersected with the scope above, so a
    // filter can only ever shrink what the viewer may already see.
    if (appId) add('studio_app_id = $$', String(appId));
    if (automationId) add('automation_id = $$', String(automationId));
    if (projectId) add('project_id = $$', String(projectId));
    if (q && String(q).trim()) {
        params.push(`%${String(q).trim().replace(/[%_\\]/g, '\\$&')}%`);
        conds.push(`(prompt ILIKE $${params.length} OR automation_title ILIKE $${params.length})`);
    }

    if (cursor && cursor.createdAt && cursor.id) {
        params.push(cursor.createdAt); const cIdx = params.length;
        params.push(cursor.id);
        conds.push(`(created_at, id) < ($${cIdx}, $${params.length})`);
    }
    return conds.join(' AND ');
}

function encodeApprovalCursor(row) {
    return Buffer.from(JSON.stringify({ c: row.createdAt, i: row.id }), 'utf8').toString('base64url');
}
function decodeApprovalCursor(s) {
    try {
        const { c, i } = JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8'));
        return (c && i) ? { createdAt: c, id: i } : null;
    } catch { return null; }
}

async function listApprovals({ viewer = null, org = null, status = [], cursor = null, limit = 50,
    appId = null, automationId = null, projectId = null, q = null } = {}) {
    const lim = Math.max(1, Math.min(100, Number(limit) || 50));
    const params = [];
    const where = buildApprovalWhere({ viewer, org, status, appId, automationId, projectId, q,
        cursor: cursor ? decodeApprovalCursor(cursor) : null }, params);
    params.push(lim + 1);
    const rows = await getAll(
        `SELECT * FROM automation_approvals WHERE ${where}
          ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
        params,
    );
    const page = rows.slice(0, lim).map(rowToApproval);
    const nextCursor = rows.length > lim ? encodeApprovalCursor(page[page.length - 1]) : null;
    return { approvals: page, nextCursor };
}

async function getApprovalFacets({ viewer = null, org = null, appId = null } = {}) {
    const params = [];
    const where = buildApprovalWhere({ viewer, org, appId }, params);
    const rows = await getAll(
        `SELECT status, COUNT(*)::int AS n FROM automation_approvals WHERE ${where} GROUP BY status`,
        params,
    );
    const status = {};
    for (const r of rows) status[r.status] = r.n;
    return { status };
}

// ── Panel votes ──────────────────────────────────────────────────────────

function rowToVote(r) {
    if (!r) return null;
    return {
        id: r.id, approvalId: r.approval_id, stage: r.stage,
        seatIndex: r.seat_index ?? null, voterId: r.voter_id,
        voterName: r.voter_name ?? null, decision: r.decision,
        reason: r.reason ?? null, answers: fromJsonb(r.answers),
        createdAt: r.created_at,
    };
}

/**
 * Record one vote. The two partial-unique indexes are the race guards: a
 * second vote for the same SEAT (two group members racing) or the same
 * PERSON returns null — the caller 409s, nothing double-counts. Evidence,
 * not verdict: the approval row's status is untouched here.
 */
async function castApprovalVote({ approvalId, stage = 'panel', seatIndex = null, voterId, voterName = null, decision, reason = null, answers = null }) {
    const r = await getOne(
        `INSERT INTO automation_approval_votes
            (id, approval_id, stage, seat_index, voter_id, voter_name, decision, reason, answers)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        ['vote_' + crypto.randomBytes(12).toString('hex'), approvalId, stage, seatIndex,
         voterId, voterName, decision, reason, answers ? JSON.stringify(answers) : null],
    );
    return rowToVote(r);
}

async function getApprovalVotes(approvalId) {
    const rows = await getAll(
        `SELECT * FROM automation_approval_votes WHERE approval_id = $1 ORDER BY created_at ASC, id ASC`,
        [approvalId],
    );
    return rows.map(rowToVote);
}

const STAGE_COLUMNS = {
    stage: 'stage',
    remindAt: 'remind_at',
    reminderSentAt: 'reminder_sent_at',
    approvers: 'approvers',
    approvalRule: 'approval_rule',
    quorumCount: 'quorum_count',
};

/**
 * Panel passed → final sign-off. Conditional on the FROM stage while still
 * pending, so of two votes that each complete the quorum exactly one
 * advances the stage (and sends the final approver exactly one bell).
 */
async function advanceApprovalStage(id, { from = 'panel', to = 'final', remindAt = undefined, mirror = null } = {}) {
    // stage_entered_at restarts the per-stage clock: the people asked in
    // stage 3 get their full window from the moment stage 3 begins, not from
    // when the whole request was raised. `remindAt` is re-armed (and its
    // sent-marker cleared) so the next stage's own reminder can fire — a
    // reminder already spent on stage 1 must not silence stage 2.
    //
    // `mirror` re-points the panel-era columns (approvers / approval_rule /
    // quorum_count) at the stage that is NOW waiting. Those columns are what
    // every pre-stages reader still consults — who gets the request bell, who
    // hears that the approval expired — so leaving them frozen on stage 1
    // would keep telling stage 1's people about a decision that moved past
    // them three stages ago. The chain in approval_stages stays the
    // authority; this only keeps the shorthand honest.
    const updates = { stage: to };
    if (remindAt !== undefined) {
        updates.remindAt = remindAt;
        // Re-arming the clock and clearing its sent-marker are one act: a
        // reminder already spent on stage 1 must not silence stage 2.
        updates.reminderSentAt = null;
    }
    if (mirror) {
        updates.approvers = mirror.approvers ? JSON.stringify(mirror.approvers) : null;
        updates.approvalRule = mirror.rule || 'all';
        updates.quorumCount = Number.isFinite(mirror.quorum) ? mirror.quorum : null;
    }
    // `stage` is always mapped, so the builder never comes back empty here and
    // the two NOW() stamps always fire — exactly as when the SET was literal.
    const built = buildUpdate({
        table: 'automation_approvals',
        updates,
        columnMap: STAGE_COLUMNS,
        extraSet: ['stage_entered_at = NOW()', 'updated_at = NOW()'],
        where: [{ col: 'id', value: id }, { col: 'stage', value: from }, { col: 'status', value: 'pending' }],
        returning: '*',
    });
    const r = await getOne(built.sql, built.params);
    return rowToApproval(r);
}

/**
 * The single decision write. Conditional on status='pending', so of two
 * concurrent deciders exactly one gets the row back; the other gets null and
 * must 409, never resume.
 */
async function decideApproval(id, { status, decidedBy, decidedByName = null, reason = null, answers = null }) {
    if (!['approved', 'rejected', 'expired', 'cancelled'].includes(status)) {
        throw new Error(`decideApproval: invalid status "${status}"`);
    }
    const r = await getOne(
        `UPDATE automation_approvals
            SET status = $2, decided_by = $3, decided_by_name = $4, decision_reason = $5,
                answers = $6, decided_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND status = 'pending'
          RETURNING *`,
        [id, status, decidedBy || null, decidedByName, reason,
         answers ? JSON.stringify(answers) : null],
    );
    return rowToApproval(r);
}

/** Reaper: flip the pending rows for runs whose approval deadline passed. */
async function expireApprovalsForRuns(runIds) {
    if (!Array.isArray(runIds) || !runIds.length) return [];
    const rows = await getAll(
        `UPDATE automation_approvals
            SET status = 'expired', decided_at = NOW(), updated_at = NOW()
          WHERE run_id = ANY($1) AND status = 'pending'
          RETURNING *`,
        [runIds],
    );
    return rows.map(rowToApproval);
}

/**
 * Reaper: stamp due reminders. Conditional on reminder_sent_at IS NULL, so of
 * N pods sweeping concurrently exactly one gets each row back — the reminder
 * bell rings once. Fires only while pending: a decided row needs no nudge.
 */
async function markDueApprovalReminders() {
    const rows = await getAll(
        `UPDATE automation_approvals
            SET reminder_sent_at = NOW(), updated_at = NOW()
          WHERE status = 'pending' AND remind_at IS NOT NULL
            AND remind_at <= NOW() AND reminder_sent_at IS NULL
          RETURNING *`,
        [],
    );
    return rows.map(rowToApproval);
}

/**
 * Reaper: stamp due escalations. The stamp IS the grant — canDecide and the
 * viewer WHERE both admit escalate_to_* only once escalated_at is set. Same
 * conditional-UPDATE idempotence as the reminder pass.
 */
async function markDueApprovalEscalations() {
    const rows = await getAll(
        `UPDATE automation_approvals
            SET escalated_at = NOW(), updated_at = NOW()
          WHERE status = 'pending' AND escalate_at IS NOT NULL
            AND escalate_at <= NOW() AND escalated_at IS NULL
            AND (escalate_to_user_id IS NOT NULL OR escalate_to_group_id IS NOT NULL)
          RETURNING *`,
        [],
    );
    return rows.map(rowToApproval);
}

/** Cheap guard for the per-app pending cap (public pages can request). */
async function countPendingApprovalsForApp(studioAppId) {
    const r = await getOne(
        `SELECT COUNT(*)::int AS n FROM automation_approvals
          WHERE studio_app_id = $1 AND status = 'pending'`,
        [studioAppId],
    );
    return r?.n || 0;
}

/**
 * Reaper: flip overdue RUN-LESS pending rows (source 'app' and 'deployment').
 * Run-sourced rows expire via the run reaper (expireApprovalsForRuns) — a
 * run-less approval has no run, so its deadline needs its own sweep.
 * `source <> 'run'` rather than a list, so a future run-less source is swept
 * too instead of silently never expiring. Conditional UPDATE = multi-pod safe.
 */
async function expireOverduePendingApprovals() {
    const rows = await getAll(
        `UPDATE automation_approvals
            SET status = 'expired', decided_at = NOW(), updated_at = NOW()
          WHERE status = 'pending' AND source <> 'run'
            AND expires_at IS NOT NULL AND expires_at <= NOW()
          RETURNING *`,
        [],
    );
    return rows.map(rowToApproval);
}

/**
 * Reconciliation: a pending RUN-sourced approval whose run is gone, or whose
 * run is no longer awaiting_approval (cancelled, definition changed, decided
 * through a path that predates this table), can never be decided — close it
 * as cancelled so it doesn't sit in "waiting" forever.
 *
 * source='run' is load-bearing: an APP-sourced approval has no run by
 * design (run_id NULL is its normal pending state), so it must never be
 * swept as an orphan — it closes only by decision, withdrawal or expiry.
 */
async function cancelOrphanedPendingApprovals() {
    const rows = await getAll(
        `UPDATE automation_approvals ap
            SET status = 'cancelled', decided_at = NOW(), updated_at = NOW(),
                decision_reason = COALESCE(ap.decision_reason, 'The run is no longer waiting for this approval.')
          WHERE ap.status = 'pending'
            AND ap.source = 'run'
            AND (ap.run_id IS NULL
                 OR NOT EXISTS (SELECT 1 FROM automation_runs r
                                 WHERE r.id = ap.run_id AND r.status = 'awaiting_approval'))
          RETURNING *`,
        [],
    );
    return rows.map(rowToApproval);
}

/** Append-only event log (requested/approved/rejected/expired/cancelled). */
async function appendApprovalAudit({ approvalId, runId = null, stepId = null, decidedBy = null, decision, comment = null, source = null }) {
    await run(
        `INSERT INTO automation_approval_audit (id, approval_id, run_id, step_id, decided_by, decision, comment, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [crypto.randomUUID(), approvalId, runId, stepId, decidedBy, decision, comment, source],
    );
}

async function getApprovalAudit(approvalId) {
    const rows = await getAll(
        `SELECT id, approval_id, run_id, step_id, decided_by, decision, comment, source, ts
           FROM automation_approval_audit WHERE approval_id = $1 ORDER BY ts ASC`,
        [approvalId],
    );
    return rows.map(r => ({
        id: r.id, approvalId: r.approval_id, runId: r.run_id, stepId: r.step_id,
        decidedBy: r.decided_by, decision: r.decision, comment: r.comment,
        source: r.source, ts: r.ts,
    }));
}

/**
 * Org admins of `orgId` (user ids), capped. The fallback audience for a
 * deployment gate's reminder when four-eyes leaves nobody else to nudge:
 * on an unstaged row an org admin may decide (approvalService.canDecide).
 */
async function listOrgAdminIds(orgId, cap = 25) {
    if (!orgId) return [];
    const rows = await getAll(
        `SELECT id FROM users WHERE "organizationId" = $1 AND (role = 'admin' OR "orgRole" IN ('org_admin', 'admin')) ORDER BY id LIMIT $2`,
        [orgId, cap],
    );
    return rows.map(r => r.id);
}

module.exports = {
    listOrgAdminIds,
    APPROVAL_STATUSES,
    createApproval,
    getApproval,
    getApprovalForRunStep,
    listApprovals,
    getApprovalFacets,
    decideApproval,
    castApprovalVote,
    getApprovalVotes,
    advanceApprovalStage,
    countPendingApprovalsForApp,
    markDueApprovalReminders,
    markDueApprovalEscalations,
    expireApprovalsForRuns,
    expireOverduePendingApprovals,
    cancelOrphanedPendingApprovals,
    appendApprovalAudit,
    getApprovalAudit,
    // For tests.
    _approvalsTest: { buildApprovalWhere, rowToApproval, encodeApprovalCursor, decodeApprovalCursor },
};
