// @typecheck
/**
 * The end of a run (moved verbatim out of execution.js's executeAutomation).
 *
 * finalizeRun turns how the run ended into its stored record and its effects:
 * the error class and remediation, the summary (reuse notes and binding
 * misses included), the approval token, the token vault flush, the terminal
 * row, the approval record, the outcome sentence, the onRunFinished hook and
 * the lifecycle event, the marker release with a secondary schedule's
 * advancement, the notifications, and the primary schedule's advancement.
 * writeRunOutcome and withLastOutput are shared with the early exits.
 *
 * Collaborators that sit inside the server's large import cycle (the
 * automation store, the engine, safety, cancellation, ...) are not required
 * here: execution.js hands them in as `deps` (its RUN_DEPS), so this module
 * stays outside that cycle (lint:scc-ratchet).
 */

const crypto = require('crypto');
const { sanitizeError } = require('../privacy/errorSanitizer');
const { classifyUnknownError, remediationFor } = require('../automationErrors');
const { bindingMissSummary } = require('./bindingMisses');
// What this module needs from automation/ (a feature) comes through ./featurePorts.js.
const { runnerPort } = require('./featurePorts');
const holidays = require('../scheduling/holidays');
const log = require('../../telemetry/log');

/**
 * @param {object} deps  execution.js's RUN_DEPS
 * @param {object} outcome  what raceRunDag answered
 * @returns {Promise<object>} the run row, with `lastOutput` attached
 */
async function finalizeRun(deps, {
    automation, run, ctx, runState, tokenVault, startedAt, firstRunNeedsConfirm,
    outcome: { runResult, runErrorObj, runErrorMsg, runStatus },
    ownsMarker, schedule, rootStepId, triggerKind, effectiveMode, testRun,
    onRunFinished, emitLifecycle,
}) {
    const { automationStore, notifyRunEvent, loadApprovalLifecycle } = deps;
    const { ApprovalRequiredError } = deps.engine;

    // Sanitized error fields for any persisted message visible to users.
    // The raw error stays in the run row's `error` column for diagnostics
    // (server-only); user-facing notifications get the redacted line.
    const sanitized = runErrorObj ? sanitizeError(runErrorObj) : null;
    const userSafeError = sanitized
        ? (sanitized.error_first_line || `Failed (${sanitized.error_code})`)
        : runErrorMsg;

    // Stable, queryable class for the run (lights up the run-facets dashboard).
    const runErrorClass = (runStatus === 'error' && runErrorObj)
        ? (runErrorObj.errorClass || classifyUnknownError(runErrorObj))
        : null;
    // Nextcloud errors already embed "<cause> — <remediation>" in their text;
    // for other errors append a generic remediation so we never double it.
    const runRemediation = (runStatus === 'error' && !runErrorObj?.ncError && runErrorClass)
        ? remediationFor(runErrorClass)
        : null;

    const finishedAt = new Date().toISOString();
    // §WS4: failures absorbed by on_error branches. The run still reports
    // 'success', but the summary + handled_error_count make the recoveries
    // visible in the run history.
    const handledErrorCount = Array.isArray(runState._handledErrors) ? runState._handledErrors.length : 0;
    const memoStats = (() => {
        try { return ctx._toolMemo?.stats?.() || {}; } catch (_) { return {}; }
    })();
    const memoHits = memoStats.hits || 0;
    const durableHits = memoStats.durableHits || 0;
    const memoRefused = memoStats.refused || 0;
    // Counters only, never a key or a value (toolMemo.stats() cannot return
    // either). Reuse that is invisible is reuse nobody can audit: this is the
    // one place a person looking at a finished run can see that an answer was
    // used again instead of being asked for.
    //
    // The three are named separately because they are different facts: one
    // says "we asked once instead of two hundred times", the next says "we did
    // not contact this app at all" — the only one that explains a run holding
    // yesterday's data — and the last says the reuse was asked for and did
    // nothing, which must never be indistinguishable from never asking.
    const reuseNotes = [];
    if (memoHits > 0) reuseNotes.push(`${memoHits} look-up(s) answered from earlier in the run`);
    if (durableHits > 0) reuseNotes.push(`${durableHits} answered from an earlier run`);
    if (memoRefused > 0) reuseNotes.push(`${memoRefused} answer(s) too big to reuse, so they were asked again`);
    // Appended to every TERMINAL summary — success and failure alike. The
    // pause lines below stay clean on purpose: a paused run is not finished,
    // and "Waiting for approval." is the sentence the run list reads.
    const withReuse = (text) => (reuseNotes.length ? `${text} — ${reuseNotes.join(', ')}` : text);
    const summary = (() => {
        if (firstRunNeedsConfirm) return 'Awaiting first-run confirmation. Review the dry-run output and approve to run live.';
        // A pause is not a failure. Without this, a run waiting on a person
        // reads as "Failed: Approval required at step s3" in the run list.
        if (runStatus === 'awaiting_approval') return 'Waiting for approval.';
        if (runStatus === 'awaiting_form') return 'Waiting for the visitor to fill in the next form page.';
        // The reuse notes ride on the FAILURE line too. They used to live only
        // in the success path, so a run that fetched from an earlier run and
        // then blew up at step 9 reported neither counter — deleting the
        // evidence from exactly the runs someone opens asking "why did this
        // act on yesterday's data and then fail?".
        // Mappings that found nothing ride on both lines too: on a failure
        // they are often WHY ("to is required" because its mapping was empty).
        const misses = bindingMissSummary(ctx._bindingMisses);
        if (runErrorMsg) return withReuse(`${runRemediation ? `Failed: ${userSafeError}. ${runRemediation}` : `Failed: ${userSafeError}`}${misses}`);
        const base = runnerPort('summarise').summariseDefinition(automation.definition || {}).summary;
        const withErrors = handledErrorCount > 0
            ? `${base} — ${handledErrorCount} step error(s) handled by error branch`
            : base;
        return withReuse(`${withErrors}${misses}`);
    })();

    // For awaiting_approval, persist the approval token + the step id so
    // the resume endpoint can validate and continue.
    let approvalToken = null;
    if (runStatus === 'awaiting_approval' && runErrorObj instanceof ApprovalRequiredError) {
        approvalToken = crypto.randomBytes(24).toString('hex');
    }

    // Persist the token vault before the run row goes terminal. This is the
    // hand-off point: an approval pause resumes in another process, and a
    // retry-from-step seeds its vault from this run — both need the map on disk.
    await tokenVault.flush();

    await automationStore.updateRun(run.id, {
        status: firstRunNeedsConfirm ? 'awaiting_confirm' : runStatus,
        finishedAt,
        durationMs: Date.now() - startedAt,
        error: runErrorMsg,
        ...(runErrorClass ? { errorClass: runErrorClass } : {}),
        summary,
        ...(handledErrorCount > 0 ? { handledErrorCount } : {}),
        ...(runStatus === 'awaiting_approval' || runStatus === 'awaiting_form'
            ? {
                awaitingStepId: runErrorObj?.stepId || null,
                // Only approvals mint a token; a form's credential is the
                // session id the visitor's browser already holds.
                approvalToken,
                // §WS2.2 — persist the deadline so the approve endpoint's 410
                // guard and the reaper's expiry pass actually fire. A form page
                // always has one: someone is sitting in front of it.
                awaitingStepExpiresAt: runErrorObj?.expiresAt || null,
            }
            : {}),
    });

    // The durable approval record — created only after updateRun has the
    // awaiting_* columns on disk, so the row never points at a run that could
    // still finalize differently. Best-effort by contract: the run's own
    // awaiting state is the engine's truth, and the list path backfills rows,
    // so a failure here degrades to "no rich card yet", never a stuck run.
    let approvalRow = null;
    if (!firstRunNeedsConfirm && runStatus === 'awaiting_approval' && runErrorObj instanceof ApprovalRequiredError) {
        const { createApprovalOnPause } = loadApprovalLifecycle();
        approvalRow = await createApprovalOnPause({ automation, run, err: runErrorObj });
    }

    // Stream the terminal state so the executions list + open execution flip
    // from running → final without a refresh.
    const finalStatus = firstRunNeedsConfirm ? 'awaiting_confirm' : runStatus;

    // Handoff 5: the run's one-sentence outcome ({ code, params, text }), read
    // off the rows it recorded. After the approval row exists, so a paused run
    // can say whom it waits on; before onRunFinished and the lifecycle event,
    // so whoever reacts to those reads a complete row.
    await writeRunOutcome(deps, {
        runId: run.id,
        status: finalStatus,
        definition: automation.definition,
        error: runErrorObj ? {
            message: runErrorMsg,
            errorClass: runErrorClass,
            ncCode: runErrorObj.ncError?.code || null,
        } : null,
        awaitingStepId: (runStatus === 'awaiting_approval' || runStatus === 'awaiting_form') ? (runErrorObj?.stepId || null) : null,
        approval: approvalRow,
        ownerId: automation.userId,
        handledErrorCount,
    });

    // The run row is TERMINAL (or paused) on disk now — the second moment a
    // caller can act on, mirroring onRunCreated. The public form uses it to
    // stamp "completed" on the answers row once the journey has no more pages
    // to ask. Best-effort by the same contract: bookkeeping never takes a
    // run down.
    if (typeof onRunFinished === 'function') {
        try { await onRunFinished(run, { status: finalStatus }); } catch (e) {
            log.warn(`[automationRunner] onRunFinished hook failed for run ${run.id}: ${e.message}`);
        }
    }
    if (runStatus === 'error') {
        emitLifecycle('run.failed', { status: 'error', errorClass: runErrorClass, error: userSafeError, durationMs: Date.now() - startedAt });
    } else {
        emitLifecycle('run.finished', { status: finalStatus, durationMs: Date.now() - startedAt, handledErrorCount });
    }

    // Release the running marker + update the automation's last-run state — but
    // ONLY for runs that own the marker (live runs). §WS2.4: a dry-run is a
    // preview that never marked the row running, so it must not release (which
    // would clear a concurrent live run's marker) nor overwrite lastStatus/
    // lastRunAt with preview results. Without releasing, a live row stays
    // `running` forever on a crash — the reaper still catches that; releasing
    // here is the fast path.
    if (ownsMarker) {
        try {
            await automationStore.updateAutomation(automation.id, {
                lastStatus: firstRunNeedsConfirm ? 'awaiting_confirm' : runStatus,
                lastRunAt: finishedAt,
            }, automation.userId);
            // A run entered through a SECONDARY schedule advances ITS OWN row
            // (automation_schedules), never the primary's columns — and does so
            // BEFORE the marker is released, so the row cannot be re-claimed in
            // the gap. A cron with no future match clears that one schedule and
            // says so; the automation's other entry points keep working.
            if (schedule?.id && typeof automationStore.advanceSchedule === 'function') {
                let next = null;
                // schedule.skipHolidays (handoff 5) is read from the definition this run executed.
                try { next = holidays.nextScheduledRunAt(schedule.cron, schedule.tz || 'Europe/Amsterdam', Date.now(), { skipHolidays: holidays.scheduleSkipsHolidays(automation.definition, rootStepId) }); } catch (_) { next = null; }
                await automationStore.advanceSchedule(schedule.id, { nextRunAt: next, lastRunAt: finishedAt, lastStatus: runStatus });
                if (!next) {
                    log.warn(`[AutomationRunner] Cron "${schedule.cron}" (${schedule.tz}) for ${automation.id} (trigger ${rootStepId || '?'}) has no future run — that schedule is now idle.`);
                    try {
                        await notifyRunEvent(automation, 'onError', {
                            code: 'automation.notify.schedule_idle',
                            title: `⏸️ A schedule went idle: ${automation.title}`,
                            message: `The extra schedule "${schedule.cron}" has no upcoming run time, so it will not fire again. Edit that trigger and save to re-arm it. The automation's other triggers are unaffected.`,
                        });
                    } catch (_) { /* notification failure is non-fatal */ }
                }
            }
            await automationStore.releaseAutomation(automation.id);
            if (runStatus === 'success') {
                await automationStore.resetAttempts(automation.id);
            }
        } catch (e) {
            log.warn(`[AutomationRunner] release/update failed for ${automation.id}: ${e.message}`);
        }
    }

    // Notifications — error path uses the sanitized message so we never
    // leak upstream API payloads or bearer tokens echoed in error bodies.
    // Each event consults the automation's notification policy (see
    // runNotifications.notifyRunEvent) so success-path noise can be silenced
    // by the user without losing failure / approval alerts.
    try {
        if (firstRunNeedsConfirm) {
            await notifyRunEvent(automation, 'onApproval', {
                title: `Confirm first real run of "${automation.title}"`,
                message: `Your automation produced a dry-run preview. Approve to run it live.`,
                link: require('../../utils/appPaths').automationRunPath(automation.id, run.id),
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
            // With an assignee, the REQUEST goes to them — the owner sees it
            // in the Approvals list and is notified of the outcome instead.
            // Without a row (creation failed), fall back to the run deep-link
            // the Executions view already understands.
            //
            // The policy decides the rest (runNotifications.notifyRunEvent):
            // the bell per approver, e-mail, and on Talk ONE reactable card in
            // the conversation, not one per person who can see it. Every
            // attempt lands in automation_notification_events; the Talk card
            // also in automation_approval_deliveries, which is what routes a
            // 👍 back to this row.
            const { approvalNotificationTargets } = loadApprovalLifecycle();
            const targets = await approvalNotificationTargets(approvalRow, automation);
            const link = targets.link
                || require('../../utils/appPaths').automationRunStepPath(automation.id, run.id, runErrorObj.stepId);
            await notifyRunEvent(automation, 'onApproval', {
                title: `🛂 Approval needed: ${automation.title}`,
                message: `${runErrorObj.prompt || 'Approval requested'} — open it to approve or reject.`,
                link,
                runId: run.id,
                code: 'automation.notify.approval_needed',
                approverIds: targets.userIds,
                approval: approvalRow || null,
            });
        }
        // No notification for cancelled runs — the user initiated the cancel
        // so they already know. The run history shows the status.
    } catch (_) { /* notification failure is non-fatal */ }

    // Schedule advancement (unless this was a manual run or first-run confirm).
    // Only the PRIMARY schedule lives on the automation row; a run that came in
    // through a secondary schedule (`schedule` set, advanced above) must not
    // move the primary's next_run_at.
    if (automation.triggerType === 'schedule'
        && !firstRunNeedsConfirm
        && !schedule
        && triggerKind !== 'manual'
        && triggerKind !== 'dry_run'
        && automation.scheduleCron) {
        try {
            const next = holidays.nextScheduledRunAt(automation.scheduleCron, automation.scheduleTz, Date.now(), { skipHolidays: holidays.scheduleSkipsHolidays(automation.definition, null) });
            if (next) {
                await automationStore.updateAutomation(automation.id, { nextRunAt: next }, automation.userId);
            } else {
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
            }
        } catch (e) {
            log.warn(`[AutomationRunner] Cron advance failed for ${automation.id}: ${e.message}`);
        }
    }

    return withLastOutput(await automationStore.getRun(run.id), runResult?.lastOutput ?? null);
}

/**
 * Write a run's outcome sentence (automation/runOutcome.js). Best-effort by
 * contract: a sentence that cannot be built or stored never fails the run.
 */
async function writeRunOutcome(deps, input) {
    const { automationStore, loadRunOutcome } = deps;
    try {
        const { resolveRunOutcome, storeOutcomeDeps } = loadRunOutcome();
        const outcome = await resolveRunOutcome(input, storeOutcomeDeps(automationStore));
        await automationStore.updateRun(input.runId, { outcome });
    } catch (e) {
        log.warn(`[AutomationRunner] could not write the outcome of run ${input.runId}: ${e.message}`);
    }
}

/**
 * Attach the run's final step output to the run row `executeAutomation`
 * returns.
 *
 * `lastOutput` is NOT a column — `rowToRun` (stores/automationStore/rowMappers.js)
 * never had it, and only `runDag` produces it (automationRunner/engine.js). But
 * three callers return an automation's result to an AI agent and read it straight
 * off this object, so all three silently answered `null` for every call:
 *   - runStepAsTool (below) — a Reusable Step used as a chat tool
 *   - automation/agentCallableTools.js — an agent-callable automation
 *   - routes/automation/webhooksAndRunOps.js — POST /:id/agent-invoke
 * The agent ran the automation and was told nothing came back.
 *
 * Attached in memory, never persisted: run rows stay the audit trail, and the
 * per-step outputs are already recorded (automation_run_steps). Every exit path
 * sets the key — `null` on the early ones — so no caller has to test for it.
 */
function withLastOutput(runRow, lastOutput) {
    return runRow ? { ...runRow, lastOutput: lastOutput ?? null } : runRow;
}

module.exports = { finalizeRun, writeRunOutcome, withLastOutput };
