/**
 * App Studio action executor — request_approval (extracted verbatim from
 * actionExecutor.js): the durable approval request an app raises without a run
 * behind it — licence gate, stage chain, clocks, attachments and the on_decided
 * snapshot.
 */

'use strict';

const { tryEvaluate } = require('../../automation/expr');
const {
    findTable, buildServerScope, resolveBinding, resolveValues, coerceRecordId, coerceText,
} = require('./shared');
const log = require('../../telemetry/log');

// ── request_approval — a durable approval request, no run behind it ──
// Creation acts as the app OWNER (the row's owner_id, its org anchor, the
// identity every run-sourced approval from this app would carry); the REAL
// viewer is recorded as requested_by — display and audit data, never rights.
// The decision happens later, in the Approvals inbox, by a signed-in human;
// the app reacts via the snapshotted on_decided record-write hook and the
// approval.decided trigger event.
const APP_APPROVAL_PENDING_CAP = 200;
const APP_APPROVAL_MAX_ATTACHMENTS = 5;

async function requestApprovalStep(app, model, step, ctx) {
    const automationStore = require('../../stores/automationStore');
    const scope = buildServerScope(ctx);

    const prompt = coerceText(resolveBinding(step.prompt, ctx, scope));
    if (!prompt || !prompt.trim()) return { ok: false, error: 'The approval needs a question to ask' };
    const details = step.details !== undefined && step.details !== null
        ? coerceText(resolveBinding(step.details, ctx, scope)) : null;

    // Approvals are an Enterprise capability. Resolved against the APP OWNER —
    // the identity the row is created as — not the viewer, so a public page's
    // anonymous visitor is judged by the licence the app runs on rather than
    // by having none of their own.
    //
    // Only CREATION is gated: an approval already pending keeps its detail
    // page, its decide route and its withdraw route, so a lapsed licence lets
    // the work already in flight finish instead of stranding it.
    {
        const { hasCapability } = require('../../core/entitlements/entitlements');
        const licensed = await hasCapability('approvals', { userId: app.userId, orgId: app.organizationId || null });
        if (!licensed) return { ok: false, error: 'Approvals are an Enterprise feature — this app cannot request one on the current plan' };
    }

    // Public pages can request (parity with public forms triggering automations
    // with approval steps) — so the pending pool is capped per app.
    const pending = await automationStore.countPendingApprovalsForApp(app.id).catch(() => 0);
    if (pending >= APP_APPROVAL_PENDING_CAP) {
        return { ok: false, error: 'This app has too many undecided approvals — decide or withdraw some first' };
    }

    // Org resolution mirrors the run path: the app's org, else the owner's,
    // stamped once and frozen (that is what an audit means).
    let orgId = app.organizationId || null;
    if (!orgId) {
        try {
            const userStore = require('../../stores/userStore');
            orgId = (await userStore.getUser(app.userId))?.organizationId || null;
        } catch { /* consumer account */ }
    }

    // Assignee / panel: runtime org-membership checks, invalid → dropped (the
    // same defence-in-depth fallback createApprovalOnPause applies). Panel
    // seats are the named users first, then the groups.
    const { validateAssignee, validatePanel, validateStages } = require('../../core/automationRunner/approvalLifecycle');
    const rawSeats = [
        ...(Array.isArray(step.approverUserIds) ? step.approverUserIds.map(id => ({ userId: id })) : []),
        ...(Array.isArray(step.approverGroupIds) ? step.approverGroupIds.map(id => ({ groupId: id })) : []),
    ];

    // ── The stage chain ──────────────────────────────────────────────────
    // Apps author exactly the shape automations do, and desugar through exactly
    // the same rulebook — an invoice app's "team lead → finance → director"
    // is the same object an automation's is, decided by the same code. Stage
    // names and descriptions are rendered against the action scope (an
    // approver must see the supplier the stage is about), and each stage's
    // `when` is evaluated ONCE here, at request time, so the chain shown to
    // the first approver is the chain that will actually run.
    const { desugarApprovalStages, firstStageKey, stageByKey, collectParticipants } = require('../../automation/approvalStages');
    // App Studio has no `{{…}}` templating — every dynamic value is an explicit
    // binding object — so a stage's name and description are resolved through
    // resolveBinding first and reach the rulebook as the plain strings it
    // expects. A plain string passes straight through, which is what a stage
    // called "Finance" wants.
    const renderStageText = (v) => (v && typeof v === 'object')
        ? coerceText(resolveBinding(v, ctx, scope))
        : (typeof v === 'string' ? v : null);
    const authoredStages = Array.isArray(step.stages)
        ? step.stages.map(st => (st && typeof st === 'object')
            ? { ...st, name: renderStageText(st.name), description: renderStageText(st.description) }
            : st)
        : step.stages;
    const resolvedStages = await validateStages(
        desugarApprovalStages(
            { stages: authoredStages, approvers: rawSeats, rule: step.rule, quorum: step.quorum,
              assignee: step.assigneeUserId ? { userId: step.assigneeUserId }
                  : (step.assigneeGroupId ? { groupId: step.assigneeGroupId } : null),
              finalApprover: step.finalApproverUserId ? { userId: step.finalApproverUserId }
                  : (step.finalApproverGroupId ? { groupId: step.finalApproverGroupId } : null) },
            { evaluateWhen: (expr) => !!tryEvaluate(expr, scope).value },
        ),
        orgId, app.userId,
    );
    const firstKey = resolvedStages ? firstStageKey(resolvedStages) : null;
    const firstStage = firstKey ? stageByKey(resolvedStages, firstKey) : null;

    let approvers = resolvedStages
        ? firstStage.approvers
        : (rawSeats.length ? await validatePanel(rawSeats, orgId) : null);
    const rawAssignee = step.assigneeUserId ? { userId: step.assigneeUserId }
        : (step.assigneeGroupId ? { groupId: step.assigneeGroupId } : null);
    let assignee = (!approvers && rawAssignee) ? await validateAssignee(rawAssignee, orgId) : null;
    const rawFinal = step.finalApproverUserId ? { userId: step.finalApproverUserId }
        : (step.finalApproverGroupId ? { groupId: step.finalApproverGroupId } : null);
    const finalApprover = resolvedStages ? null : (rawFinal ? await validateAssignee(rawFinal, orgId) : null);
    // Pre-chain definitions only — desugarApprovalStages now expresses
    // "one approver then a final sign-off" as two real stages.
    if (finalApprover && !approvers) {
        approvers = [assignee || { userId: app.userId }];
        assignee = null;
    }

    // Deadline: absent or 0 = no deadline (an app approval often waits on a
    // weekly review); 1..720h otherwise. The reaper sweeps overdue rows.
    const hours = Number.isInteger(step.expiresInHours) ? Math.min(Math.max(step.expiresInHours, 0), 720) : 0;
    const expiresAt = hours > 0 ? new Date(Date.now() + hours * 3_600_000).toISOString() : null;

    // Reminder + escalation clocks — same rules as the run path (a clock at
    // or past the deadline is dropped; the escalation target passes the org
    // gate or the escalation is dropped whole).
    const { approvalClocks } = require('../../core/automationRunner/approvalLifecycle');
    const clocks = approvalClocks({
        remindAfterHours: step.remindAfterHours,
        escalateAfterHours: step.escalateAfterHours,
        expiresAt,
    });
    const rawEscalate = step.escalateToUserId ? { userId: step.escalateToUserId }
        : (step.escalateToGroupId ? { groupId: step.escalateToGroupId } : null);
    const escalateTo = (rawEscalate && clocks.escalateAt) ? await validateAssignee(rawEscalate, orgId) : null;

    // Attachments: studio_attachment descriptors only, each re-verified in the
    // app's OWN owner-scoped ledger (an id is never a capability) and clean.
    let attachments = null;
    if (step.attachments !== undefined && step.attachments !== null) {
        const resolved = resolveBinding(step.attachments, ctx, scope);
        const list = (Array.isArray(resolved) ? resolved : [resolved]).filter(Boolean);
        const studioAppDataStore = require('../../stores/studioAppDataStore');
        const out = [];
        for (const d of list.slice(0, APP_APPROVAL_MAX_ATTACHMENTS)) {
            if (!d || typeof d !== 'object' || d.kind !== 'studio_attachment' || typeof d.fileId !== 'string') continue;
            const row = await studioAppDataStore.getAttachment(d.fileId, app.id, app.userId).catch(() => null);
            if (!row || row.quarantined || !row.scanned) {
                log.warn(`[ActionExecutor] request_approval attachment ${d.fileId} is not a clean file of app ${app.id} — dropped`);
                continue;
            }
            out.push({
                fileId: row.id,
                filename: coerceText(d.name) || 'document',
                mimeType: row.mimeType || 'application/octet-stream',
                size: row.size || 0,
                label: coerceText(d.label) || null,
                store: 'app',           // tells the download route which ledger to ask
            });
        }
        attachments = out.length ? out : null;
    }

    // Questions: canonicalize already enforced shape/caps; keep the defensive
    // filter so a raw-API definition cannot smuggle an object in.
    const questions = Array.isArray(step.fields)
        ? step.fields.filter((q) => q && typeof q === 'object' && typeof q.name === 'string' && q.name).slice(0, 20)
        : null;

    // Context: resolved to VALUES now — the hook templates and the trigger
    // event echo what was true at request time.
    const context = step.context ? resolveValues(step.context, ctx, scope) : null;

    // on_decided: snapshotted with recordId RESOLVED — the row it flips is
    // known now; resolving at decide time against a changed app would flip
    // the wrong row. Column-level validity is writeRecord's job at decision
    // time (failures are audited, never block the decision).
    let onDecided = null;
    if (step.onDecided && typeof step.onDecided === 'object') {
        const table = findTable(model, step.onDecided.tableId);
        if (!table) return { ok: false, error: 'The onDecided hook points at a table this app does not have' };
        const recordId = coerceRecordId(resolveBinding(step.onDecided.recordId, ctx, scope));
        if (!recordId) return { ok: false, error: 'The onDecided hook could not work out which record to update' };
        onDecided = { tableId: table.id, recordId, set: step.onDecided.set || {} };
    }

    // Frozen at INSERT: which Solution this decision was made inside. An
    // app-sourced approval takes it from the app, there being no run.
    const project = await require('../../automation/approvalProject').projectStamp(app.projectId);

    const approval = await automationStore.createApproval({
        organizationId: orgId,
        automationId: null,
        // The display title every list shows — for an app-sourced approval
        // that is the APP's name, not an automation's.
        automationTitle: app.name || 'App',
        ...project,
        runId: null, rootRunId: null, stepId: null,
        ownerId: app.userId,
        assigneeUserId: assignee?.userId || null,
        assigneeGroupId: assignee?.groupId || null,
        prompt: prompt.slice(0, 2000),
        detailsMd: details ? String(details).slice(0, 20_000) : null,
        fields: questions,
        attachments,
        expiresAt,
        source: 'app',
        requestedBy: ctx.viewerId != null ? String(ctx.viewerId) : null,
        studioAppId: app.id,
        actionId: typeof ctx.actionId === 'string' ? ctx.actionId : null,
        context: context && Object.keys(context).length ? context : null,
        onDecided,
        remindAt: clocks.remindAt,
        // A panel's takeover mechanism is its final approver — escalation
        // stays a single-assignee feature, exactly as on the run path.
        escalateAt: (!approvers && escalateTo) ? clocks.escalateAt : null,
        escalateToUserId: !approvers ? (escalateTo?.userId || null) : null,
        escalateToGroupId: !approvers ? (escalateTo?.groupId || null) : null,
        approvers,
        approvalRule: resolvedStages
            ? (firstStage.rule || 'all')
            : (approvers ? (['all', 'first', 'quorum'].includes(step.rule) ? step.rule : 'all') : null),
        quorumCount: resolvedStages
            ? (Number.isFinite(firstStage.quorum) ? firstStage.quorum : null)
            : (approvers && step.rule === 'quorum'
                ? Math.min(Math.max(Math.round(Number(step.quorumCount)) || 1, 1), approvers.length)
                : null),
        finalApproverUserId: finalApprover?.userId || null,
        finalApproverGroupId: finalApprover?.groupId || null,
        stages: resolvedStages,
        stageParticipants: resolvedStages ? collectParticipants(resolvedStages) : null,
        stageKey: firstKey,
    });
    if (!approval) return { ok: false, error: 'The approval could not be created' };

    await automationStore.appendApprovalAudit({
        approvalId: approval.id, runId: null, stepId: null,
        decidedBy: ctx.viewerId != null ? String(ctx.viewerId) : null,
        decision: 'requested', source: 'app',
    }).catch(() => {});
    require('../../automation/approvalEvents').dispatchApprovalRequested(approval);

    // Bell the deciders — assignee/group, else the owner (same fan-out shape
    // as a paused run's request).
    try {
        const { approvalNotificationTargets } = require('../../core/automationRunner/approvalLifecycle');
        const notificationStore = require('../../stores/notificationStore');
        const targets = await approvalNotificationTargets(approval, { userId: app.userId });
        for (const userId of targets.userIds) {
            await notificationStore.createNotification({
                userId,
                category: 'heads_up',
                title: `🔔 Approval needed: ${app.name || 'App'}`,
                message: prompt.slice(0, 500),
                link: targets.link,
            }).catch(() => {});
        }
    } catch (e) {
        log.warn(`[ActionExecutor] request_approval notify failed: ${e.message}`);
    }

    return { ok: true, result: { approvalId: approval.id, status: 'pending', expiresAt } };
}

module.exports = { requestApprovalStep };
