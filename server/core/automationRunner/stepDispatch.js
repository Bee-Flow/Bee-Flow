// @typecheck
/**
 * Step dispatch for one run (moved verbatim out of execution.js's
 * executeAutomation).
 *
 * makeStepDispatcher builds the `dispatchStep` closure runDag calls for every
 * step: the leaf switch by step type (./stepLeaf.js), per-item iteration (forEach), pinned and
 * disabled steps, the cancellation check between steps, the initial-failure
 * and retry rows, and the pause rows of an approval or a form page.
 *
 * Collaborators that sit inside the server's large import cycle (the
 * automation store, the engine, safety, cancellation, ...) are not required
 * here: execution.js hands them in as `deps` (its RUN_DEPS), so this module
 * stays outside that cycle (lint:scc-ratchet).
 */

const { classifyUnknownError } = require('../automationErrors');
const { safeDescribeStepError } = require('../../utils/stepErrorInfo');
const { resolveDeep, withBindingLog } = require('../automationModel/bind');
const { noteStepBindingMisses } = require('./bindingMisses');
const log = require('../../telemetry/log');
const { stepRetryFor } = require('./runPolicy');
const { makeLeafRunner } = require('./stepLeaf');

/**
 * The branch label a DISABLED brancher routes on, or null for a plain step.
 *
 * A disabled step returns `{disabled: true}` and nothing else, so runDag found
 * no `branch` on it and fell back to 'on_success' — which matches none of an
 * If/Switch/Guard's then/else/case:* edges. Disabling one of those therefore
 * ended the whole run right there, status success, no warning: everything after
 * the node silently stopped existing (W4-11).
 *
 * The semantic chosen here is "a disabled node is not there": it passes through
 * on its CONTINUE port — `then` for condition/guard (the same port
 * buildLinearEdges uses to continue a linear body past a brancher), and the
 * configured `defaultBranch` (else the default port) for a switch. Passing
 * through EVERY outgoing branch edge was the alternative and was rejected: it
 * would run both sides of an If at once and duplicate whatever side effects
 * hang off them, which is a worse surprise than the one being fixed.
 *
 * If that port has no edge, runDag's default-port rescue and its dead-end
 * breadcrumb take it from there — the run says so instead of ending silently.
 */
function disabledPassThroughBranch(step) {
    if (step.type === 'condition' || step.type === 'guard') return 'then';
    if (step.type === 'switch') return `case:${step.defaultBranch || 'default'}`;
    return null;
}

/** The input snapshot a step row records: resolved without secrets. */
function inputSnapshotOf(step, state_) {
    return step.inputs ? resolveDeep(step.inputs, state_, { allowSecrets: false }) : null;
}

/**
 * A step that does not run: pinned (n8n-style data pinning) or disabled. Its
 * result, or null for a step that runs.
 */
function pinnedOrDisabled(step, state_, stepStartedAt) {
    // When a step has `pinnedOutput` we skip the real handler and emit the
    // pinned value verbatim — saves upstream API/model calls during iterative
    // debugging. Pinned steps record as 'success' with source='pinned' so
    // audit trails distinguish synthetic outputs from live ones.
    if (step.pinnedOutput !== undefined && step.pinnedOutput !== null) {
        return {
            output: step.pinnedOutput,
            startedAt: stepStartedAt,
            inputSnapshot: inputSnapshotOf(step, state_),
            pinned: true,
            // 'pinned' status threads through runDag's recordedStatus
            // mapper so audit rows can distinguish synthetic from live
            // outputs without having to inspect the output JSON itself.
            skippedReason: 'pinned',
        };
    }
    // n8n-style "disable this node" toggle. Disabled steps pass their
    // resolved input through as `{ disabled: true, input }` so downstream
    // bindings don't crash on undefined, and never call into integrations /
    // models / notifications.
    if (step.disabled) {
        const passThrough = disabledPassThroughBranch(step);
        return {
            output: { disabled: true, ...(passThrough ? { branch: passThrough } : {}) },
            startedAt: stepStartedAt,
            inputSnapshot: inputSnapshotOf(step, state_),
            skippedReason: 'disabled',
        };
    }
    return null;
}

/**
 * Where a failure row goes. Sub-step recording: namespace ids under the
 * calling call_layer step (ctx_.stepRecord.prefix) and suppress entirely
 * inside unrecorded loop bodies — mirrors the runDag record sites.
 */
function recordSlot(step, ctx_) {
    return {
        recStepId: (ctx_.stepRecord?.prefix || '') + step.id,
        recParentStepId: ctx_.stepRecord?.parentStepId || null,
        recSuppressed: !!ctx_.stepRecord?.suppress,
    };
}

/**
 * Retry a failed step per its config; the result of the first attempt that
 * succeeds, or undefined when every retry failed. Every retry attempt is
 * recorded — not just the last. The audit trail otherwise has no rows for
 * intermediate failures, hiding flaky-tool patterns from users.
 */
async function retryStep(deps, retry, { step, ctx_, state_, mode_, stepStartedAt, inputForRecord, slot, executeStepWithIteration }) {
    for (let i = 1; i <= retry.max; i++) {
        if (retry.backoffMs) await new Promise(r => setTimeout(r, retry.backoffMs));
        const attemptStartedAt = new Date().toISOString();
        try {
            // Route retries through the same wrapper as the initial
            // dispatch so per-item iteration (forEach) composes with
            // retry. Approval throws on every call to pause; the
            // enclosing executeAutomation handles the pause path
            // before any retry kicks in (this block only fires for
            // actual errors).
            const retryLog = [];
            const retryResult = await withBindingLog(retryLog, () => executeStepWithIteration(step, ctx_, state_, mode_));
            retryResult.startedAt = stepStartedAt;
            retryResult.inputSnapshot = inputForRecord;
            const retryMisses = noteStepBindingMisses({ step, entries: retryLog, ctx: ctx_, runState: state_ });
            if (retryMisses) retryResult.bindingWarnings = retryMisses;
            // Tell runDag to record the final outcome at the
            // correct `attempts` slot rather than overwriting
            // attempts=1 (the initial-fail row).
            retryResult.attempt = i + 1;
            retryResult.attemptStartedAt = attemptStartedAt;
            return retryResult;
        } catch (retryErr) {
            if (!slot.recSuppressed) {
                await deps.automationStore.recordRunStep({
                    runId: ctx_.runId, stepId: slot.recStepId, parentStepId: slot.recParentStepId,
                    stepType: step.type, attempts: i + 1,
                    status: 'error', startedAt: attemptStartedAt, finishedAt: new Date().toISOString(),
                    input: inputForRecord,
                    output: null, error: retryErr.message,
                    errorClass: retryErr.errorClass || classifyUnknownError(retryErr),
                    errorInfo: safeDescribeStepError(retryErr, { step, inputs: inputForRecord }),
                    // Retries may have pulled new secrets into state_
                    // via bridges — recompute rather than reuse.
                    secretValues: deps.engine.secretValuesFor(state_),
                });
            }
        }
    }
    return undefined;
}

/**
 * A step threw. A pause (approval, form page) is recorded as awaiting_* and
 * rethrown; an error is recorded as the initial failed attempt, retried per
 * the step's (or the run policy's) retry, and rethrown when every retry failed.
 */
async function handleStepFailure(deps, err, f) {
    const { automationStore } = deps;
    const { ApprovalRequiredError, FormInputRequiredError, secretValuesFor } = deps.engine;
    const { step, ctx_, state_, stepStartedAt, bindingLog, runPolicy } = f;
    const bindingWarnings = noteStepBindingMisses({ step, entries: bindingLog, ctx: ctx_, runState: state_ });
    const inputForRecord = inputSnapshotOf(step, state_);
    const secretValues = secretValuesFor(state_);
    const slot = recordSlot(step, ctx_);
    const row = { runId: ctx_.runId, stepId: slot.recStepId, parentStepId: slot.recParentStepId, stepType: step.type, attempts: 1 };
    // Pauses are not errors — record the step as awaiting_* so run
    // history shows the pause point and the resume path can find it.
    // The recorded OUTPUT is what the resumer reads: an approval shows
    // its prompt, a form page serves its rendered config to the
    // waiting visitor (it cannot be re-derived later — the run state
    // its templates referenced is gone by then).
    if (err instanceof ApprovalRequiredError || err instanceof FormInputRequiredError) {
        const isForm = err instanceof FormInputRequiredError;
        if (!slot.recSuppressed) {
            await automationStore.recordRunStep({
                ...row,
                status: isForm ? 'awaiting_form' : 'awaiting_approval',
                startedAt: stepStartedAt, finishedAt: new Date().toISOString(),
                input: inputForRecord,
                output: isForm ? { form: err.form } : { prompt: err.prompt }, error: null,
                secretValues,
                bindingWarnings,
            });
        }
        throw err;
    }
    // Record the initial failed attempt up-front. Without this, an
    // initial fail followed by a successful retry would erase the
    // original error from the audit trail (runDag would overwrite
    // attempts=1 from 'error' to 'success'). Subsequent retries are
    // recorded as attempts=i+1 by retryStep.
    if (!slot.recSuppressed) {
        await automationStore.recordRunStep({
            ...row,
            status: 'error', startedAt: stepStartedAt, finishedAt: new Date().toISOString(),
            input: inputForRecord,
            output: null, error: err.message,
            errorClass: err.errorClass || classifyUnknownError(err),
            // Handoff 5: the plain-language card (title, cause, the
            // setting that fixes it, fix buttons) for the step drawer.
            errorInfo: safeDescribeStepError(err, { step, inputs: inputForRecord }),
            secretValues,
            // Often the reason it failed: "to is required" because the
            // mapping for `to` found nothing.
            bindingWarnings,
        });
    }
    // Attempt retry per step config. §WS2.5: a forEach that already did
    // per-item retry and threw all-failed (err.foreachHandled) must NOT
    // be retried whole here — that would re-run the entire fan-out.
    // A step's own retry wins; without one the automation's
    // runPolicy.retry.max is the default (handoff 5).
    // A mapping that read nothing reads nothing again: no retry for it.
    const retry = err.errorClass === 'binding_unresolved' ? null : stepRetryFor(step, runPolicy);
    if (retry && retry.max && retry.max > 0 && !err.foreachHandled) {
        const retried = await retryStep(deps, retry, { ...f, inputForRecord, slot });
        if (retried !== undefined) return retried;
    }
    // §WS4: retries are structural — they all ran above, so the
    // error escaping here IS final. Stamp which attempts slot holds
    // the last recorded 'error' row so runDag's on_error catch can
    // flip exactly that row to 'handled_error' (PK upsert) instead
    // of fabricating a duplicate attempts=1 row.
    err.finalAttempt = (retry && retry.max > 0 && !err.foreachHandled) ? retry.max + 1 : 1;
    throw err;
}

/**
 * The `dispatchStep` of one run: what runDag (and every container step that
 * recurses through it) calls to execute a single step.
 *
 * @param {any} deps  execution.js's RUN_DEPS
 * @param {object} args
 * @param {any} args.run   the run row (its id addresses the cancel flag)
 * @param {AbortSignal} args.cancelSignal  the run's in-process cancel signal
 * @param {any} args.runPolicy  the automation's run policy (default retry)
 */
function makeStepDispatcher(deps, { run, cancelSignal, runPolicy }) {
    const { isCancelRequested } = deps;
    const { execForEachStep } = deps.engine;

    // Dispatch a single step by type — no iteration (./stepLeaf.js). Container/
    // control steps (loop, parallel, call_layer) recurse via the `dispatchStep`
    // closure below, handed over as a getter: it's only *called* at run time,
    // by when the const is assigned.
    const runStepLeaf = makeLeafRunner(deps, () => dispatchStep);

    // Wrap a leaf step with optional per-item iteration. When `step.forEach`
    // is set the step runs once per array element (see execForEachStep);
    // otherwise it runs once. Both the initial dispatch and the retry path
    // route through here so iteration composes with retry / on_error.
    const executeStepWithIteration = async (step, ctx_, state_, mode_) => {
        if (step.forEach && step.forEach.overRef) {
            // Same cancellation contract as dispatchStep, checked between
            // every iterated item (both the in-process signal and the
            // cross-process DB flag).
            const checkCancel = async () => {
                if (cancelSignal.aborted) throw new Error('Run cancelled');
                if (await isCancelRequested(run.id)) throw new Error('Run cancelled');
            };
            return execForEachStep(step, ctx_, state_, mode_, runStepLeaf, checkCancel);
        }
        return runStepLeaf(step, ctx_, state_, mode_);
    };

    const dispatchStep = async (step, ctx_, state_, mode_) => {
        // Cancellation is checked between every step. We honour both the
        // in-process AbortSignal (fast path for local cancels) and the
        // cross-process DB flag (handles cancels issued against a different
        // runner pod).
        if (cancelSignal.aborted) throw new Error('Run cancelled');
        if (await isCancelRequested(run.id)) throw new Error('Run cancelled');

        const stepStartedAt = new Date().toISOString();
        // Defensive: a step missing `id` would crash recordRunStep
        // (step_id is NOT NULL). Synthesize one so we never write null
        // and so retries / errors still get a unique row.
        if (!step.id) {
            step.id = `unknown_${Math.random().toString(36).slice(2, 8)}`;
            log.warn(`[AutomationRunner] Step missing id; synthesized ${step.id}`);
        }
        const notRun = pinnedOrDisabled(step, state_, stepStartedAt);
        if (notRun) return notRun;

        // A mapping that finds nothing while the step runs is written down
        // (bind.js withBindingLog) and reported on the step row, the run's
        // warnings and its summary (bindingMisses.js): an empty value with a
        // green run would be all anyone sees. The input snapshot below is
        // resolved outside the log, so it does not count twice.
        const bindingLog = [];
        try {
            const result = await withBindingLog(bindingLog, () => executeStepWithIteration(step, ctx_, state_, mode_));
            result.startedAt = stepStartedAt;
            result.inputSnapshot = inputSnapshotOf(step, state_);
            const misses = noteStepBindingMisses({ step, entries: bindingLog, ctx: ctx_, runState: state_ });
            if (misses) result.bindingWarnings = misses;
            return result;
        } catch (err) {
            return handleStepFailure(deps, err, {
                step, ctx_, state_, mode_, stepStartedAt, bindingLog, runPolicy, executeStepWithIteration,
            });
        }
    };

    return dispatchStep;
}

module.exports = { disabledPassThroughBranch, makeStepDispatcher };

/**
 * A step definition, as far as dispatch reads it.
 * @typedef {{ id?: string, type: string, inputs?: Record<string, unknown>, defaultBranch?: string,
 *   pinnedOutput?: unknown, disabled?: boolean, forEach?: { overRef?: string }, retry?: { max?: number } }} DispatchStep
 */

/**
 * The run context a step is dispatched with, as far as dispatch reads it.
 * @typedef {{ runId?: string, stepRecord?: { prefix?: string, parentStepId?: string|null, suppress?: boolean },
 *   _bindingMisses?: import('./bindingMisses').RunBindingMiss[] }} DispatchCtx
 */

/** @typedef {import('../automationModel/bind').BindRunState} BindRunState */

/** @typedef {import('../automationModel/bind').BindingMiss} BindingMiss */

/** @typedef {(step: DispatchStep, ctx_: DispatchCtx, state_: BindRunState, mode_?: string) => Promise<any>} StepRunner */
