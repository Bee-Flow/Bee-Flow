// @typecheck
/**
 * The end of a run (moved verbatim out of execution.js's executeAutomation).
 *
 * finalizeRun turns how the run ended into its stored record and its effects:
 * the error class and remediation, the summary (reuse notes and binding
 * misses included), the approval token, the token vault flush, the terminal
 * row, the approval record, the outcome sentence, the onRunFinished hook and
 * the lifecycle event, then (./runFinalizeEffects.js) the marker release with
 * a secondary schedule's advancement, the notifications, and the primary
 * schedule's advancement. writeRunOutcome and withLastOutput are shared with
 * the early exits.
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
const { truncationSummary } = require('./truncations');
// What this module needs from automation/ (a feature) comes through ./featurePorts.js.
const { runnerPort } = require('./featurePorts');
const { releaseMarker, notifyRunEnd, advancePrimarySchedule } = require('./runFinalizeEffects');
const log = require('../../telemetry/log');

/**
 * The error as a user may see it, its stable class, and the remediation.
 * The raw error stays in the run row's `error` column for diagnostics
 * (server-only); user-facing notifications get the redacted line.
 */
function describeRunError({ runErrorObj, runErrorMsg, runStatus }) {
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
    return { userSafeError, runErrorClass, runRemediation };
}

/**
 * Counters only, never a key or a value (toolMemo.stats() cannot return
 * either). Reuse that is invisible is reuse nobody can audit: this is the one
 * place a person looking at a finished run can see that an answer was used
 * again instead of being asked for.
 *
 * The three are named separately because they are different facts: one says
 * "we asked once instead of two hundred times", the next says "we did not
 * contact this app at all" — the only one that explains a run holding
 * yesterday's data — and the last says the reuse was asked for and did
 * nothing, which must never be indistinguishable from never asking.
 */
function reuseNotesOf(ctx) {
    const memoStats = (() => {
        try { return ctx._toolMemo?.stats?.() || {}; } catch (_) { return {}; }
    })();
    const memoHits = memoStats.hits || 0;
    const durableHits = memoStats.durableHits || 0;
    const memoRefused = memoStats.refused || 0;
    const reuseNotes = [];
    if (memoHits > 0) reuseNotes.push(`${memoHits} look-up(s) answered from earlier in the run`);
    if (durableHits > 0) reuseNotes.push(`${durableHits} answered from an earlier run`);
    if (memoRefused > 0) reuseNotes.push(`${memoRefused} answer(s) too big to reuse, so they were asked again`);
    return reuseNotes;
}

/** The run's summary line. */
function runSummary({ automation, ctx, firstRunNeedsConfirm, runStatus, runErrorMsg, userSafeError, runRemediation, handledErrorCount }) {
    if (firstRunNeedsConfirm) return 'Awaiting first-run confirmation. Review the dry-run output and approve to run live.';
    // A pause is not a failure. Without this, a run waiting on a person
    // reads as "Failed: Approval required at step s3" in the run list.
    if (runStatus === 'awaiting_approval') return 'Waiting for approval.';
    if (runStatus === 'awaiting_form') return 'Waiting for the visitor to fill in the next form page.';
    // Appended to every TERMINAL summary — success and failure alike. The
    // pause lines above stay clean on purpose: a paused run is not finished,
    // and "Waiting for approval." is the sentence the run list reads.
    const reuseNotes = reuseNotesOf(ctx);
    const withReuse = (text) => (reuseNotes.length ? `${text} — ${reuseNotes.join(', ')}` : text);
    // The reuse notes ride on the FAILURE line too. They used to live only
    // in the success path, so a run that fetched from an earlier run and
    // then blew up at step 9 reported neither counter — deleting the
    // evidence from exactly the runs someone opens asking "why did this
    // act on yesterday's data and then fail?".
    // Mappings that found nothing ride on both lines too: on a failure
    // they are often WHY ("to is required" because its mapping was empty).
    const misses = bindingMissSummary(ctx._bindingMisses) + truncationSummary(ctx._truncations);
    if (runErrorMsg) return withReuse(`${runRemediation ? `Failed: ${userSafeError}. ${runRemediation}` : `Failed: ${userSafeError}`}${misses}`);
    const base = runnerPort('summarise').summariseDefinition(automation.definition || {}).summary;
    const withErrors = handledErrorCount > 0
        ? `${base} — ${handledErrorCount} step error(s) handled by error branch`
        : base;
    return withReuse(`${withErrors}${misses}`);
}

/** The terminal (or paused) run row. */
async function writeTerminalRow(deps, { run, firstRunNeedsConfirm, runStatus, finishedAt, startedAt, runErrorMsg, runErrorObj, runErrorClass, summary, handledErrorCount, approvalToken }) {
    await deps.automationStore.updateRun(run.id, {
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
}

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
    const { automationStore, loadApprovalLifecycle } = deps;
    const { ApprovalRequiredError } = deps.engine;
    const { userSafeError, runErrorClass, runRemediation } = describeRunError({ runErrorObj, runErrorMsg, runStatus });

    const finishedAt = new Date().toISOString();
    // §WS4: failures absorbed by on_error branches. The run still reports
    // 'success', but the summary + handled_error_count make the recoveries
    // visible in the run history.
    const handledErrorCount = Array.isArray(runState._handledErrors) ? runState._handledErrors.length : 0;
    const summary = runSummary({ automation, ctx, firstRunNeedsConfirm, runStatus, runErrorMsg, userSafeError, runRemediation, handledErrorCount });
    const isApprovalPause = runStatus === 'awaiting_approval' && runErrorObj instanceof ApprovalRequiredError;

    // For awaiting_approval, persist the approval token + the step id so
    // the resume endpoint can validate and continue.
    const approvalToken = isApprovalPause ? crypto.randomBytes(24).toString('hex') : null;

    // Persist the token vault before the run row goes terminal. This is the
    // hand-off point: an approval pause resumes in another process, and a
    // retry-from-step seeds its vault from this run — both need the map on disk.
    await tokenVault.flush();
    await writeTerminalRow(deps, { run, firstRunNeedsConfirm, runStatus, finishedAt, startedAt, runErrorMsg, runErrorObj, runErrorClass, summary, handledErrorCount, approvalToken });

    // The durable approval record — created only after updateRun has the
    // awaiting_* columns on disk, so the row never points at a run that could
    // still finalize differently. Best-effort by contract: the run's own
    // awaiting state is the engine's truth, and the list path backfills rows,
    // so a failure here degrades to "no rich card yet", never a stuck run.
    let approvalRow = null;
    if (!firstRunNeedsConfirm && isApprovalPause) {
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
    const paused = runStatus === 'awaiting_approval' || runStatus === 'awaiting_form';
    await writeRunOutcome(deps, {
        runId: run.id,
        status: finalStatus,
        definition: automation.definition,
        error: runErrorObj ? {
            message: runErrorMsg,
            errorClass: runErrorClass,
            ncCode: runErrorObj.ncError?.code || null,
        } : null,
        awaitingStepId: paused ? (runErrorObj?.stepId || null) : null,
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

    if (ownsMarker) await releaseMarker(deps, { automation, firstRunNeedsConfirm, runStatus, finishedAt, schedule, rootStepId });
    await notifyRunEnd(deps, { automation, run, firstRunNeedsConfirm, runStatus, runErrorObj, summary, userSafeError, triggerKind, effectiveMode, testRun, approvalRow });
    await advancePrimarySchedule(deps, { automation, firstRunNeedsConfirm, schedule, triggerKind });

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

module.exports = { finalizeRun, writeRunOutcome, withLastOutput, runSummary };
