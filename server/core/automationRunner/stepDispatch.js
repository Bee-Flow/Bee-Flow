/**
 * Step dispatch for one run (moved verbatim out of execution.js's
 * executeAutomation).
 *
 * makeStepDispatcher builds the `dispatchStep` closure runDag calls for every
 * step: the leaf switch by step type, per-item iteration (forEach), pinned and
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

/**
 * The `dispatchStep` of one run: what runDag (and every container step that
 * recurses through it) calls to execute a single step.
 *
 * @param {object} deps  execution.js's RUN_DEPS
 * @param {object} run   the run row (its id addresses the cancel flag)
 * @param {AbortSignal} cancelSignal  the run's in-process cancel signal
 * @param {object} runPolicy  the automation's run policy (default retry)
 */
function makeStepDispatcher(deps, { run, cancelSignal, runPolicy }) {
    const { automationStore, isCancelRequested, execFlatten } = deps;
    const {
        secretValuesFor,
        execIntegrationAction, execAiStep, execCondition, execGuard, execTokenize, execUntokenize,
        execNotification, execCode, execHttpRequest, execGenerateDocument, execFillDocument,
        execSlide, execPresentation, ApprovalRequiredError, execApproval, FormInputRequiredError,
        execFormPage, execParallel, execLoop, execForEachStep, execCallLayer, execLayerOutput,
        execCallBlock, execSet, execParseJson, execDateTime, execWait, execStopError,
        execReturnToApp, execSwitch, execFilter, execLimit, execDedupe, execAggregate,
        execSummarize, execDatatable, execKnowledgeWrite, execDataExtraction,
    } = deps.engine;

    // Dispatch a single step by type — no iteration. Container/control
    // steps (loop, parallel, call_layer) recurse via the `dispatchStep`
    // closure below. Referencing `dispatchStep` here is safe: it's only
    // *called* at run time, by when the const is assigned.
    const runStepLeaf = async (step, ctx_, state_, mode_) => {
        switch (step.type) {
            case 'integration_action': return execIntegrationAction(step, ctx_, state_, mode_);
            case 'ai_step':            return execAiStep(step, ctx_, state_, mode_);
            case 'condition':          return execCondition(step, ctx_, state_);
            // Scans a value with the Privacy Shield's own detector and branches
            // on the answer (then = personal data, else = clean).
            case 'guard':              return execGuard(step, ctx_, state_, mode_);
            // Reversible placeholders minted into the run vault; the
            // runner's existing restore points put the real values back.
            case 'tokenize':           return execTokenize(step, ctx_, state_, mode_);
            // Put the real values back HERE. The runner restores automatically
            // wherever a value round-trips (AI reply, tool result); this is for
            // the values that never do.
            case 'untokenize':         return execUntokenize(step, ctx_, state_);
            case 'loop':               return execLoop(step, ctx_, state_, mode_, dispatchStep);
            case 'code':               return execCode(step, ctx_, state_, mode_);
            case 'notification':       return execNotification(step, ctx_, state_, mode_);
            case 'http_request':       return execHttpRequest(step, ctx_, state_, mode_);
            case 'generate_document':  return execGenerateDocument(step, ctx_, state_, mode_);
            // Fills a Document DESIGNED in Studio (an invoice, a quote, a
            // letter on letterhead) and keeps the PDF. generate_document above
            // is its sibling for the other direction: text in, standard layout.
            case 'fill_document':      return execFillDocument(step, ctx_, state_, mode_);
            // The presentation pair: a slide is an object (pure, forEach-able),
            // the deck is a kept file — same ledger as generate_document.
            case 'slide':              return execSlide(step, ctx_, state_, mode_);
            case 'presentation':       return execPresentation(step, ctx_, state_, mode_);
            case 'approval':           return execApproval(step, ctx_, state_, mode_);
            case 'form_page':          return execFormPage(step, ctx_, state_, mode_);
            case 'parallel':           return execParallel(step, ctx_, state_, mode_, dispatchStep);
            case 'call_layer':         return execCallLayer(step, ctx_, state_, mode_, dispatchStep);
            case 'call_block':         return execCallBlock(step, ctx_, state_, mode_, dispatchStep);
            case 'layer_output':       return execLayerOutput(step, ctx_, state_);
            // n8n-style utility nodes
            case 'set':                return execSet(step, ctx_, state_);
            case 'parse_json':         return execParseJson(step, ctx_, state_, mode_);
            case 'datetime':           return execDateTime(step, ctx_, state_);
            case 'wait':               return execWait(step, ctx_, state_, mode_);
            case 'stop_error':         return execStopError(step, ctx_, state_);
            // The other TERMINAL step. Unlike stop_error it does NOT throw —
            // it ends the run successfully and its output carries the
            // instructions the app applies (`_appEffects`). The walk stopping
            // afterwards is runDag's job, not this switch's.
            case 'return_to_app':      return execReturnToApp(step, ctx_, state_);
            case 'switch':             return execSwitch(step, ctx_, state_);
            case 'filter':             return execFilter(step, ctx_, state_);
            case 'limit':              return execLimit(step, ctx_, state_);
            case 'dedupe':             return execDedupe(step, ctx_, state_);
            case 'flatten':            return execFlatten(step, ctx_, state_);
            case 'aggregate':          return execAggregate(step, ctx_, state_);
            case 'summarize':          return execSummarize(step, ctx_, state_);
            // One of the two steps whose effect outlives the run: rows in an
            // organisation-scoped table, reached through the shared engine.
            case 'datatable':          return execDatatable(step, ctx_, state_, mode_);
            // The other one whose effect outlives the run — and the one whose
            // text an agent will later state as fact, which is why its
            // knowledge base is re-authorised at run time rather than trusted
            // from the definition.
            case 'knowledge_write':    return execKnowledgeWrite(step, ctx_, state_, mode_);
            // Named, typed fields out of a piece of text. Runs on the ONE
            // extraction model the admin configured, never the automation's
            // tier; a dry run synthesises typed samples and never calls it.
            case 'data_extraction':    return execDataExtraction(step, ctx_, state_, mode_);
            // A canvas annotation (BFSF-411) — never reachable in practice
            // (it carries no edges, so runDag never queues it; a nested one
            // is excluded from execFlow.js's buildLinearEdges the same way),
            // but the switch's OWN contract is "never throw for a persisted
            // note step", so this case stands as the second half of that
            // guarantee rather than relying on unreachability alone.
            case 'note':               return { output: null, skippedReason: 'note' };
            default: throw new Error(`Unknown step type: ${step.type}`);
        }
    };

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

        // n8n-style data pinning. When a step has `pinnedOutput` we skip
        // the real handler and emit the pinned value verbatim — saves
        // upstream API/model calls during iterative debugging. Pinned
        // steps record as 'success' with source='pinned' so audit trails
        // distinguish synthetic outputs from live ones.
        if (step.pinnedOutput !== undefined && step.pinnedOutput !== null) {
            return {
                output: step.pinnedOutput,
                startedAt: stepStartedAt,
                inputSnapshot: step.inputs ? resolveDeep(step.inputs, state_, { allowSecrets: false }) : null,
                pinned: true,
                // 'pinned' status threads through runDag's recordedStatus
                // mapper so audit rows can distinguish synthetic from live
                // outputs without having to inspect the output JSON itself.
                skippedReason: 'pinned',
            };
        }

        // n8n-style "disable this node" toggle. Disabled steps pass
        // their resolved input through as `{ disabled: true, input }`
        // so downstream bindings don't crash on undefined, and never
        // call into integrations / models / notifications.
        if (step.disabled) {
            const passThrough = disabledPassThroughBranch(step);
            return {
                output: { disabled: true, ...(passThrough ? { branch: passThrough } : {}) },
                startedAt: stepStartedAt,
                inputSnapshot: step.inputs ? resolveDeep(step.inputs, state_, { allowSecrets: false }) : null,
                skippedReason: 'disabled',
            };
        }

        let result;
        // A mapping that finds nothing while the step runs is written down
        // (bind.js withBindingLog) and reported on the step row, the run's
        // warnings and its summary (bindingMisses.js): an empty value with a
        // green run used to be all anyone saw. The input snapshot below is
        // resolved outside the log, so it does not count twice.
        const bindingLog = [];
        try {
            result = await withBindingLog(bindingLog, () => executeStepWithIteration(step, ctx_, state_, mode_));
            result.startedAt = stepStartedAt;
            result.inputSnapshot = step.inputs ? resolveDeep(step.inputs, state_, { allowSecrets: false }) : null;
            const misses = noteStepBindingMisses({ step, entries: bindingLog, ctx: ctx_, runState: state_ });
            if (misses) result.bindingWarnings = misses;
            return result;
        } catch (err) {
            const bindingWarnings = noteStepBindingMisses({ step, entries: bindingLog, ctx: ctx_, runState: state_ });
            const inputForRecord = step.inputs ? resolveDeep(step.inputs, state_, { allowSecrets: false }) : null;
            const secretValues = secretValuesFor(state_);
            // Sub-step recording: namespace ids under the calling call_layer
            // step (ctx_.stepRecord.prefix) and suppress entirely inside
            // unrecorded loop bodies — mirrors the runDag record sites.
            const recStepId = (ctx_.stepRecord?.prefix || '') + step.id;
            const recParentStepId = ctx_.stepRecord?.parentStepId || null;
            const recSuppressed = !!ctx_.stepRecord?.suppress;
            // Pauses are not errors — record the step as awaiting_* so run
            // history shows the pause point and the resume path can find it.
            // The recorded OUTPUT is what the resumer reads: an approval shows
            // its prompt, a form page serves its rendered config to the
            // waiting visitor (it cannot be re-derived later — the run state
            // its templates referenced is gone by then).
            if (err instanceof ApprovalRequiredError || err instanceof FormInputRequiredError) {
                const isForm = err instanceof FormInputRequiredError;
                if (!recSuppressed) {
                    await automationStore.recordRunStep({
                        runId: ctx_.runId, stepId: recStepId, parentStepId: recParentStepId,
                        stepType: step.type, attempts: 1,
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
            // recorded as attempts=i+1 by the retry loop below.
            if (!recSuppressed) {
                await automationStore.recordRunStep({
                    runId: ctx_.runId, stepId: recStepId, parentStepId: recParentStepId,
                    stepType: step.type, attempts: 1,
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
            const retry = stepRetryFor(step, runPolicy);
            if (retry && retry.max && retry.max > 0 && !err.foreachHandled) {
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
                        // attempts=1 (the initial-fail row above).
                        retryResult.attempt = i + 1;
                        retryResult.attemptStartedAt = attemptStartedAt;
                        return retryResult;
                    } catch (retryErr) {
                        // Record every retry attempt — not just the last. The
                        // audit trail otherwise has no rows for intermediate
                        // failures, hiding flaky-tool patterns from users.
                        if (!recSuppressed) {
                            await automationStore.recordRunStep({
                                runId: ctx_.runId, stepId: recStepId, parentStepId: recParentStepId,
                                stepType: step.type, attempts: i + 1,
                                status: 'error', startedAt: attemptStartedAt, finishedAt: new Date().toISOString(),
                                input: inputForRecord,
                                output: null, error: retryErr.message,
                                errorClass: retryErr.errorClass || classifyUnknownError(retryErr),
                                errorInfo: safeDescribeStepError(retryErr, { step, inputs: inputForRecord }),
                                // Retries may have pulled new secrets into state_
                                // via bridges — recompute rather than reuse.
                                secretValues: secretValuesFor(state_),
                            });
                        }
                    }
                }
            }
            // §WS4: retries are structural — they all ran above, so the
            // error escaping here IS final. Stamp which attempts slot holds
            // the last recorded 'error' row so runDag's on_error catch can
            // flip exactly that row to 'handled_error' (PK upsert) instead
            // of fabricating a duplicate attempts=1 row.
            err.finalAttempt = (retry && retry.max > 0 && !err.foreachHandled) ? retry.max + 1 : 1;
            throw err;
        }
    };

    return dispatchStep;
}

module.exports = { disabledPassThroughBranch, makeStepDispatcher };
