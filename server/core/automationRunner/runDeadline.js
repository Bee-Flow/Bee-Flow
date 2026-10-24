// @typecheck
/**
 * The run's DAG raced against its time budget and its cancel signal (moved
 * verbatim out of execution.js's executeAutomation).
 *
 * raceRunDag starts runDag, arms the re-armable deadline (Wait steps extend
 * it) and the cancel guard, waits for whichever settles first, unwinds an
 * in-flight DAG on a timeout or cancel, and re-checks a cancel that landed
 * during the final step. It answers how the run ended; finalising the row is
 * runFinalize.js's job.
 *
 * Collaborators that sit inside the server's large import cycle (the
 * automation store, the engine, safety, cancellation, ...) are not required
 * here: execution.js hands them in as `deps` (its RUN_DEPS), so this module
 * stays outside that cycle (lint:scc-ratchet).
 */

const { runTimeoutMsFor } = require('./runPolicy');
const { fallback, bestEffort } = require('../../utils/bestEffort');

/**
 * @returns {Promise<{ runResult, runErrorObj, runErrorMsg, runStatus, wasCancelled }>}
 */
async function raceRunDag(deps, {
    automation, ctx, runState, effectiveMode, dispatchStep, runPolicy, run,
    cancelController, cancelSignal, heartbeatTimer, touchRunMarker,
    skipUntilStepId, onlyStepId, fromStepId, untilStepId, rootStepId, replayGaps,
}) {
    const { isCancelRequested, clearRunCancellation } = deps;
    const { clampRunTimeout, runDag, ApprovalRequiredError, FormInputRequiredError } = deps.engine;

    let runResult;
    let runErrorObj = null;
    let runErrorMsg = null;
    let runStatus = 'success';
    let wasCancelled = false;

    // runPolicy.maxDurationMin (handoff 5) sets the budget when the automation
    // has one; else the row's run_timeout_ms, else the platform default.
    // Waiting (Wait steps, approvals, form pages) still does not count: the
    // deadline below is extended for those.
    const effectiveTimeoutMs = clampRunTimeout({ runTimeoutMs: runTimeoutMsFor(runPolicy) ?? automation.runTimeoutMs });
    let timeoutTimer = null;
    // Re-armable deadline (A8): Wait steps EXTEND it by their planned sleep,
    // so "Wait up to 24 hours" (the documented contract, validate.js 1..86400)
    // stops guaranteeing a "Run hard timeout" the moment the wait exceeds the
    // ~5-minute run budget. Sleep time no longer counts against the budget;
    // actual WORK time still does. Cumulative extension is capped at 24h.
    let deadlineAt = Date.now() + effectiveTimeoutMs;
    let extendedTotalMs = 0;
    ctx.extendRunDeadline = (ms) => {
        const grant = Math.max(0, Math.min(Number(ms) || 0, 86_400_000 - extendedTotalMs));
        extendedTotalMs += grant;
        deadlineAt += grant;
        // The step that just told us it will be alive far longer than its
        // budget is exactly the step whose sleep would otherwise outlive the
        // reaper's window on the automations row — so refresh that marker here
        // too, not only on the next 15s heartbeat tick (W5-16).
        touchRunMarker();
    };
    // Cancellable-sleep hook for execWait: chunked sleeps poll this signal so
    // a cancel lands within seconds instead of after the full wait.
    ctx.cancelSignal = cancelSignal;
    // §WS2.1 — the DAG promise. We keep a handle so that on a timeout/cancel we
    // can abort the controller and AWAIT runDag's unwind before finalizing —
    // otherwise Promise.race only stops *waiting* for runDag; runDag itself keeps
    // dispatching steps (real side effects + recordRunStep writes) against a run
    // row we've already marked terminal. `dagDone` lets the finally skip the
    // abort on the normal success/approval path (runDag already settled there).
    let dagDone = false;
    const dagPromise = runDag(automation.definition || {}, ctx, runState, effectiveMode, dispatchStep, { recordSteps: true, skipUntilStepId, onlyStepId, fromStepId, untilStepId, rootStepId, replayGaps });
    dagPromise.then(() => { dagDone = true; }, () => { dagDone = true; });
    const dagSettled = dagPromise.catch((e) => fallback('core/automationRunner/runDeadline:raceRunDag', e)); // swallow the late rejection once the race has already taken it
    const guard = new Promise((_, reject) => {
        const arm = () => {
            const ms = deadlineAt - Date.now();
            if (ms <= 0) return reject(new Error('Run hard timeout'));
            // Short re-arm interval so a deadline extension granted mid-wait
            // is picked up without bookkeeping on the extension side.
            timeoutTimer = setTimeout(arm, Math.min(ms, 30_000));
            if (timeoutTimer.unref) timeoutTimer.unref();
        };
        arm();
    });
    guard.catch((e) => bestEffort('core/automationRunner/runDeadline:raceRunDag#2', e)); // never an unhandled rejection
    // Abort signal also rejects the race, so the cancel endpoint can stop
    // the run even when the runDag promise is awaiting a long upstream call.
    const cancelGuard = new Promise((_, reject) => {
        const onAbort = () => reject(new Error('Run cancelled'));
        if (cancelSignal.aborted) onAbort();
        else cancelSignal.addEventListener('abort', onAbort, { once: true });
    });
    cancelGuard.catch((e) => bestEffort('core/automationRunner/runDeadline:raceRunDag#3', e)); // finally may abort() and reject this with no live race handler

    try {
        runResult = await Promise.race([dagPromise, guard, cancelGuard]);
    } catch (e) {
        runErrorObj = e;
        runErrorMsg = e.message || String(e);
        wasCancelled = cancelSignal.aborted || e.message === 'Run cancelled';
        if (e instanceof ApprovalRequiredError) {
            runStatus = 'awaiting_approval';
        } else if (e instanceof FormInputRequiredError) {
            // Distinct from awaiting_approval on purpose: the approvals UI must
            // not offer an Approve/Reject bar for a visitor's half-filled form.
            runStatus = 'awaiting_form';
        } else if (wasCancelled) {
            runStatus = 'cancelled';
        } else {
            runStatus = 'error';
        }
    } finally {
        // §WS2.1 — if the race ended via timeout or cancel while runDag is still
        // in flight, abort the controller so dispatchStep's between-step check
        // short-circuits it, then wait for it to unwind so no further step runs
        // against this finalized run. On success/approval runDag already settled
        // (dagDone), so we must NOT abort — that would falsely trip the §WS2.3
        // cancel re-check below.
        if (!dagDone) {
            try { cancelController.abort(); } catch (err) { bestEffort('core/automationRunner/runDeadline:raceRunDag#4', err); /* noop */ }
            await dagSettled;
        }
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        clearRunCancellation(run.id);
    }

    // §WS2.3 — a cancel requested while the FINAL step was executing is otherwise
    // lost: runDag returns normally (cancel is only checked at the START of each
    // step) and we'd record 'success'. Re-check the cancel authority — the
    // in-process signal OR the cross-pod cancel_requested DB flag — and downgrade
    // to 'cancelled' so the success notification + resetAttempts are skipped.
    if (runStatus === 'success' && (cancelSignal.aborted || await isCancelRequested(run.id).catch(() => false))) {
        runStatus = 'cancelled';
        wasCancelled = true;
        runErrorMsg = runErrorMsg || 'Run cancelled';
    }

    return { runResult, runErrorObj, runErrorMsg, runStatus, wasCancelled };
}

module.exports = { raceRunDag };
