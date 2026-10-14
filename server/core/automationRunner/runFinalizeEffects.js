// @typecheck
/**
 * The effects at the end of a run, after its row is terminal on disk
 * (./runFinalize.js decides what that row says): releasing the running
 * marker with a secondary schedule's advancement, the run notifications, and
 * the primary schedule's advancement.
 *
 * Collaborators come in as `deps` (execution.js's RUN_DEPS), as they do for
 * runFinalize.js, so this module stays outside the server's large import
 * cycle (lint:scc-ratchet).
 */

'use strict';

const holidays = require('../scheduling/holidays');
const { automationRunPath, automationRunStepPath } = require('../../utils/appPaths');
const log = require('../../telemetry/log');

/**
 * A run entered through a SECONDARY schedule advances ITS OWN row
 * (automation_schedules), never the primary's columns — and does so BEFORE
 * the marker is released, so the row cannot be re-claimed in the gap. A cron
 * with no future match clears that one schedule and says so; the
 * automation's other entry points keep working.
 */
async function advanceSecondarySchedule(deps, { automation, schedule, rootStepId, runStatus, finishedAt }) {
    const { automationStore, notifyRunEvent } = deps;
    if (!schedule?.id || typeof automationStore.advanceSchedule !== 'function') return;
    let next = null;
    // schedule.skipHolidays (handoff 5) is read from the definition this run executed.
    try { next = holidays.nextScheduledRunAt(schedule.cron, schedule.tz || 'Europe/Amsterdam', Date.now(), { skipHolidays: holidays.scheduleSkipsHolidays(automation.definition, rootStepId) }); } catch (_) { next = null; }
    await automationStore.advanceSchedule(schedule.id, { nextRunAt: next, lastRunAt: finishedAt, lastStatus: runStatus });
    if (next) return;
    log.warn(`[AutomationRunner] Cron "${schedule.cron}" (${schedule.tz}) for ${automation.id} (trigger ${rootStepId || '?'}) has no future run — that schedule is now idle.`);
    try {
        await notifyRunEvent(automation, 'onError', {
            code: 'automation.notify.schedule_idle',
            title: `⏸️ A schedule went idle: ${automation.title}`,
            message: `The extra schedule "${schedule.cron}" has no upcoming run time, so it will not fire again. Edit that trigger and save to re-arm it. The automation's other triggers are unaffected.`,
        });
    } catch (_) { /* notification failure is non-fatal */ }
}

/**
 * Release the running marker + update the automation's last-run state — but
 * ONLY for runs that own the marker (live runs). §WS2.4: a dry-run is a
 * preview that never marked the row running, so it must not release (which
 * would clear a concurrent live run's marker) nor overwrite lastStatus/
 * lastRunAt with preview results. Without releasing, a live row stays
 * `running` forever on a crash — the reaper still catches that; releasing
 * here is the fast path.
 */
async function releaseMarker(deps, { automation, firstRunNeedsConfirm, runStatus, finishedAt, schedule, rootStepId }) {
    const { automationStore } = deps;
    try {
        await automationStore.updateAutomation(automation.id, {
            lastStatus: firstRunNeedsConfirm ? 'awaiting_confirm' : runStatus,
            lastRunAt: finishedAt,
        }, automation.userId);
        await advanceSecondarySchedule(deps, { automation, schedule, rootStepId, runStatus, finishedAt });
        await automationStore.releaseAutomation(automation.id);
        if (runStatus === 'success') {
            await automationStore.resetAttempts(automation.id);
        }
    } catch (e) {
        log.warn(`[AutomationRunner] release/update failed for ${automation.id}: ${e.message}`);
    }
}

/**
 * The approval request. With an assignee, the REQUEST goes to them — the owner
 * sees it in the Approvals list and is notified of the outcome instead.
 * Without a row (creation failed), fall back to the run deep-link the
 * Executions view already understands.
 *
 * The policy decides the rest (runNotifications.notifyRunEvent): the bell per
 * approver, e-mail, and on Talk ONE reactable card in the conversation, not
 * one per person who can see it. Every attempt lands in
 * automation_notification_events; the Talk card also in
 * automation_approval_deliveries, which is what routes a 👍 back to this row.
 */
async function notifyApprovalNeeded(deps, { automation, run, runErrorObj, approvalRow }) {
    const { approvalNotificationTargets } = deps.loadApprovalLifecycle();
    const targets = await approvalNotificationTargets(approvalRow, automation);
    const link = targets.link || automationRunStepPath(automation.id, run.id, runErrorObj.stepId);
    await deps.notifyRunEvent(automation, 'onApproval', {
        title: `🛂 Approval needed: ${automation.title}`,
        message: `${runErrorObj.prompt || 'Approval requested'} — open it to approve or reject.`,
        link,
        runId: run.id,
        code: 'automation.notify.approval_needed',
        approverIds: targets.userIds,
        approval: approvalRow || null,
    });
}

/**
 * Notifications — error path uses the sanitized message so we never leak
 * upstream API payloads or bearer tokens echoed in error bodies. Each event
 * consults the automation's notification policy (see
 * runNotifications.notifyRunEvent) so success-path noise can be silenced by
 * the user without losing failure / approval alerts.
 */
async function notifyRunEnd(deps, end) {
    const { notifyRunEvent } = deps;
    const { ApprovalRequiredError } = deps.engine;
    const { automation, run, firstRunNeedsConfirm, runStatus, runErrorObj, summary, userSafeError, triggerKind, effectiveMode, testRun } = end;
    try {
        if (firstRunNeedsConfirm) {
            await notifyRunEvent(automation, 'onApproval', {
                title: `Confirm first real run of "${automation.title}"`,
                message: `Your automation produced a dry-run preview. Approve to run it live.`,
                link: automationRunPath(automation.id, run.id),
                runId: run.id,
                code: 'automation.notify.first_run_confirm',
            });
        } else if (runStatus === 'success' && triggerKind !== 'dry_run' && effectiveMode === 'live' && !testRun) {
            // A test run is watched by whoever started it: no notification.
            await notifyRunEvent(automation, 'onSuccess', {
                title: `🤖 ${automation.title}`,
                message: summary,
                runId: run.id,
            });
        } else if (runStatus === 'error' && !testRun) {
            await notifyRunEvent(automation, 'onError', {
                title: `⚠️ Automation failed: ${automation.title}`,
                message: userSafeError || 'Unknown error',
                runId: run.id,
            });
        } else if (runStatus === 'awaiting_approval' && runErrorObj instanceof ApprovalRequiredError) {
            await notifyApprovalNeeded(deps, end);
        }
        // No notification for cancelled runs — the user initiated the cancel
        // so they already know. The run history shows the status.
    } catch (_) { /* notification failure is non-fatal */ }
}

/**
 * Schedule advancement (unless this was a manual run or first-run confirm).
 * Only the PRIMARY schedule lives on the automation row; a run that came in
 * through a secondary schedule (`schedule` set, advanced by releaseMarker)
 * must not move the primary's next_run_at.
 */
async function advancePrimarySchedule(deps, { automation, firstRunNeedsConfirm, schedule, triggerKind }) {
    const { automationStore, notifyRunEvent } = deps;
    if (automation.triggerType !== 'schedule'
        || firstRunNeedsConfirm
        || schedule
        || triggerKind === 'manual'
        || triggerKind === 'dry_run'
        || !automation.scheduleCron) return;
    try {
        const next = holidays.nextScheduledRunAt(automation.scheduleCron, automation.scheduleTz, Date.now(), { skipHolidays: holidays.scheduleSkipsHolidays(automation.definition, null) });
        if (next) {
            await automationStore.updateAutomation(automation.id, { nextRunAt: next }, automation.userId);
            return;
        }
        // cron.nextRunAt returned null → this cron has no reachable
        // future match (e.g. "31 2 *" — Feb 31). Leaving next_run_at
        // at its stale past value would re-qualify the row for
        // claimDueAutomations EVERY tick — an infinite ~60s refire
        // loop. Clear next_run_at (so it can't be re-claimed) and
        // deactivate the schedule, then tell the user why.
        log.warn(`[AutomationRunner] Cron "${automation.scheduleCron}" (${automation.scheduleTz}) for ${automation.id} has no future run — disabling schedule.`);
        await automationStore.updateAutomation(automation.id, { nextRunAt: null, isActive: false }, automation.userId);
        try {
            await notifyRunEvent(automation, 'onError', {
                code: 'automation.notify.schedule_disabled',
                title: `⏸️ Schedule disabled: ${automation.title}`,
                message: `The schedule "${automation.scheduleCron}" has no upcoming run time, so the automation was paused. Edit the schedule and re-activate it.`,
            });
        } catch (_) { /* notification failure is non-fatal */ }
    } catch (e) {
        log.warn(`[AutomationRunner] Cron advance failed for ${automation.id}: ${e.message}`);
    }
}

module.exports = { releaseMarker, notifyRunEnd, advancePrimarySchedule };
