/**
 * Live dispatch of one step for the DAG walker (runDag.js): the 'running'
 * row, the call into dispatchStep, native error-edge routing of a failure,
 * and storing + recording the result. Returns what the walker needs to route
 * onward; the walk itself (queue, fan-in, replay) stays in runDag.js.
 */

const automationStore = require('../../stores/automationStore');
const { classifyUnknownError } = require('../automationErrors');
const safety = require('./safety');
const {
    cloneRunValue, secretValuesFor, effectiveEdgeLabel, nextEdgesFor,
    BRANCHER_TYPES, TERMINAL_STEP_TYPES, PII_RESCAN_EXEMPT_TYPES,
} = require('./shared');
const { isRunPause } = require('./execApproval');
const { notePublicValues, publicValuesFor } = require('./publicValues');
const { toolIdentity } = require('./toolIdentity');
const { bestEffort, fallback } = require('../../utils/bestEffort');

/** Whether this walk writes run-step rows (re-read at every use, as ctx may change). */
function isRecording(recordSteps, ctx) {
    return !!(recordSteps && ctx.runId && !ctx.stepRecord?.suppress);
}

const recordedStepId = (ctx, step) => (ctx.stepRecord?.prefix || '') + step.id;

async function recordStepStarted(step, ctx, branchIndex) {
    const recordedId = recordedStepId(ctx, step);
    ctx.emitLifecycle?.('step.started', { stepId: recordedId, stepType: step.type });
    // A row for the step that is RUNNING, not only for the ones
    // that finished. Until now a step in flight left no trace at
    // all, so anything asking "where is this run right now" — a
    // public form page sitting on a spinner while the automation
    // works — had nothing to answer with. Upserted on
    // (run_id, step_id, attempts), so the real row replaces this
    // one the moment the step lands; a retry's attempts=1 'error'
    // row replaces it the same way. Awaited rather than
    // fire-and-forget: a step that finishes in under a
    // round-trip would otherwise land BEFORE its own start row
    // and leave a 'running' row behind it forever.
    await automationStore.recordRunStep({
        runId: ctx.runId,
        stepId: recordedId,
        parentStepId: ctx.stepRecord?.parentStepId || null,
        stepType: step.type,
        attempts: 1,
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        input: null,
        output: null,
        error: null,
        branchIndex,
    }).catch((e) => bestEffort('core/automationRunner/runDagRecord:recordStepStarted', e));
}

/**
 * §19: native error-edge routing. If the step has an explicit 'on_error'
 * outgoing edge, treat the failure as a recoverable branch — record the
 * failed step, route execution along on_error, and keep walking. Otherwise
 * bubble up (preserve legacy fail-the-run behavior). Returns the edges the
 * walk takes next; throws when the failure is not handled.
 *
 * Carve-outs (correctness-critical): a run PAUSE (approval, or a form page
 * waiting on the visitor) and a cancellation are NOT step failures —
 * swallowing them into an error branch would auto-"handle" a
 * human-in-the-loop gate or keep a cancelled run walking. Both re-throw
 * unconditionally. GuardrailBlockError intentionally REMAINS routable: a
 * policy block is a real step failure the flow may want to recover from
 * (e.g. notify-and-continue).
 */
async function handleStepFailure(stepErr, step, w) {
    const { ctx, runState, adj, recordSteps } = w;
    const id = step.id;
    if (isRunPause(stepErr)) throw stepErr;
    if (stepErr.message === 'Run cancelled') throw stepErr;
    const allOut = adj.get(id) || [];
    const hasErrorBranch = allOut.some(e => effectiveEdgeLabel(e) === 'on_error');
    // runPolicy.retry.then === 'continue' (handoff 5): with no
    // error branch wired, a step that failed for good is recorded
    // as handled and the run carries on down its NORMAL path, with
    // the step's output empty. Never for a brancher: an If/Switch/
    // Guard that failed chose no branch, so there is no normal path
    // to take and walking all of them would run both sides. Nor for
    // a terminal step (Stop with error): stopping IS what it is for.
    const continuePast = !hasErrorBranch
        && ctx.runPolicy?.retry?.then === 'continue'
        && !BRANCHER_TYPES.has(step.type)
        && !TERMINAL_STEP_TYPES.has(step.type);
    if (!hasErrorBranch && !continuePast) throw stepErr;
    const errorClass = stepErr.errorClass || classifyUnknownError(stepErr);
    runState.steps = runState.steps || {};
    // Handled-error payload: downstream branch steps bind
    // steps.<id>.error.message / .errorClass / .stepId via the
    // normal walkPath resolution — zero bind.js changes.
    runState.steps[step.id] = {
        output: null,
        status: 'handled_error',
        error: { message: stepErr.message, errorClass, stepId: step.id },
    };
    // Run-level tally — shared by REFERENCE across layer/loop/
    // parallel sub-states so executeAutomation can report
    // "N step error(s) handled" + persist handled_error_count.
    if (Array.isArray(runState._handledErrors)) {
        runState._handledErrors.push({ stepId: step.id, message: stepErr.message, errorClass });
    }
    if (isRecording(recordSteps, ctx)) await recordHandledError(stepErr, errorClass, step, w);
    return continuePast ? nextEdgesFor(id, adj, 'on_success') : nextEdgesFor(id, adj, 'on_error');
}

async function recordHandledError(stepErr, errorClass, step, { ctx, runState, branchIndex }) {
    try {
        // Flip the FINAL attempt row (recorded as 'error' by
        // dispatchStep's catch / retry loop) to handled_error
        // via the (run_id, step_id, attempts) PK upsert —
        // intermediate attempt rows keep their 'error' status
        // so the audit trail still shows the retries.
        await automationStore.recordRunStep({
            runId: ctx.runId,
            stepId: recordedStepId(ctx, step),
            parentStepId: ctx.stepRecord?.parentStepId || null,
            stepType: step.type,
            attempts: stepErr.finalAttempt || 1,
            status: 'handled_error',
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            input: null,
            output: null,
            error: stepErr.message,
            errorClass,
            branchIndex,
            secretValues: secretValuesFor(runState),
        });
    } catch (err) { bestEffort('core/automationRunner/runDagRecord:recordHandledError', err); /* best-effort log */ }
    ctx.emitLifecycle?.('step.finished', {
        stepId: recordedStepId(ctx, step), status: 'handled_error',
    });
}

/**
 * Save into runState. Clone the output so downstream steps that mutate it
 * can't corrupt the cached binding source. Returns the recorded status.
 */
function storeStepOutput(step, dispatched, runState, mode) {
    runState.steps = runState.steps || {};
    const recordedStatus = dispatched.skippedReason === 'pinned' ? 'pinned'
        : dispatched.skippedReason ? 'skipped' : 'success';
    runState.steps[step.id] = {
        output: cloneRunValue(dispatched.output),
        status: recordedStatus,
        // Dry-run taint: downstream reads that bind this step's output
        // must synthesize instead of dispatching fake data live.
        // Bindings only descend `output.*`, so the extra key is
        // invisible to them.
        ...(mode === 'dry_run' && dispatched.dryRunSynthesised ? { synthesised: true } : {}),
    };
    notePublicValues(runState, step, dispatched.output);
    return recordedStatus;
}

/**
 * @param {string} recordedStatus
 */
async function recordStepFinished(step, dispatched, recordedStatus, { ctx, runState, mode, branchIndex }) {
    // In dry-run, annotate the RECORDED output (only) so the UI can
    // tell a synthesized preview from ground truth. Underscore-prefixed
    // meta keys, dry_run only — the binding source (runState.steps) is
    // left untouched so downstream resolves stay clean.
    let recordedOutput = dispatched.output ?? null;
    if (mode === 'dry_run' && dispatched.dryRunSynthesised
        && recordedOutput && typeof recordedOutput === 'object' && !Array.isArray(recordedOutput)) {
        recordedOutput = { ...recordedOutput, _dryRunSynthesised: true, _dryRunFallback: dispatched.dryRunFallback || null };
    }
    const piiSummary = await piiSummaryFor(step, dispatched, recordedStatus, ctx);
    // When dispatchStep returns from a retry-success path, it
    // tags the result with `attempt` + `attemptStartedAt` so
    // this row lands on attempts=N rather than overwriting the
    // attempts=1 'error' row recorded inside the catch.
    await automationStore.recordRunStep({
        runId: ctx.runId,
        stepId: recordedStepId(ctx, step),
        parentStepId: ctx.stepRecord?.parentStepId || null,
        stepType: step.type,
        toolName: step.tool || null,
        attempts: dispatched.attempt || 1,
        status: recordedStatus,
        startedAt: dispatched.attemptStartedAt || dispatched.startedAt,
        finishedAt: new Date().toISOString(),
        input: dispatched.inputSnapshot ?? null,
        output: recordedOutput,
        error: null,
        branchIndex,
        // Whose connection an integration step used (a user id, nothing else).
        identityUserId: step.type === 'integration_action' ? toolIdentity(ctx).userId || null : null,
        piiSummary,
        secretValues: secretValuesFor(runState),
        publicValues: publicValuesFor(runState),
        // Tools an AI step was not given, each with its reason
        // ('permission' | 'confirm' | 'unavailable'), for the
        // Runs tab (handoff 5). Null for every other step.
        // Mappings that found nothing while the step ran
        // (execution.js dispatchStep, bindingMisses.js).
        bindingWarnings: Array.isArray(dispatched.bindingWarnings) && dispatched.bindingWarnings.length
            ? dispatched.bindingWarnings : null,
        toolsWithheld: Array.isArray(dispatched.toolsWithheld) && dispatched.toolsWithheld.length
            ? [...new Set(dispatched.toolsWithheld)].map((name) => ({
                name, reason: dispatched.toolsWithheldReasons?.[name] || 'unavailable',
            }))
            : null,
    });
    ctx.emitLifecycle?.('step.finished', {
        stepId: recordedStepId(ctx, step), status: recordedStatus,
    });
}

/**
 * PII metadata for the canvas's "colour lines by PII" mode.
 * Guard-derived summaries (integration/ai steps) ride in on
 * the dispatch result for free; other step types get a scan
 * ONLY in builder-initiated runs (dry-run / ▶ Execute) — the
 * owner's decision: production runs never pay for extra
 * scanning. scanOutputForPiiSummary itself gates on the org
 * shield ("Apply to automations") and PII detection being on.
 * Pure transformation steps are exempt (BFSF-359): their output
 * is a SUBSET of upstream data that was already scanned when
 * the step that produced it was recorded, so re-scanning buys
 * no new finding and costs single-digit seconds on an 8k-row
 * window — which is most of what made ▶ Execute feel broken on
 * a Limit node.
 * @param {string} recordedStatus
 */
async function piiSummaryFor(step, dispatched, recordedStatus, ctx) {
    let piiSummary = dispatched.piiSummary || null;
    if (!piiSummary && ctx.builderRun && recordedStatus === 'success' && dispatched.output != null
        && !PII_RESCAN_EXEMPT_TYPES.has(step.type)) {
        try { piiSummary = await safety.scanOutputForPiiSummary(dispatched.output, ctx); } catch (err) { fallback('core/automationRunner/runDagRecord:piiSummaryFor', err); /* never fail a run on it */ }
    }
    return piiSummary;
}

/**
 * Dispatch `step` live and record it. `w` carries the walk's
 * { ctx, runState, mode, dispatchStep, adj, recordSteps, branchIndex }.
 *
 * Returns either `{ handledEdges }` — the step failed into an error branch
 * (or past it, runPolicy 'continue') and the walk takes these edges next —
 * or `{ dispatched, nextLabel, branchOutput }` for a step that ran.
 */
async function dispatchLiveStep(step, w) {
    const { ctx, runState, mode, dispatchStep, recordSteps, branchIndex } = w;
    if (isRecording(recordSteps, ctx)) await recordStepStarted(step, ctx, branchIndex);
    let dispatched;
    try {
        dispatched = await dispatchStep(step, ctx, runState, mode);
    } catch (stepErr) {
        return { handledEdges: await handleStepFailure(stepErr, step, w) };
    }
    const recordedStatus = storeStepOutput(step, dispatched, runState, mode);
    if (isRecording(recordSteps, ctx)) await recordStepFinished(step, dispatched, recordedStatus, w);
    // Branchers route by the label their executor returns: then/else
    // for condition + guard ("did this contain personal data"),
    // case:<name> / case:default for switch. Driven off the shared
    // BRANCHER_TYPES set so buildLinearEdges and this block can never
    // disagree about what counts as a brancher.
    const nextLabel = (BRANCHER_TYPES.has(step.type) && dispatched.output?.branch) ? dispatched.output.branch : null;
    return { dispatched, nextLabel, branchOutput: dispatched.output || null };
}

module.exports = { dispatchLiveStep };

/** @typedef {import('./runDagGraph').EdgeMap} EdgeMap */

/**
 * A step of the definition as the walker sees it.
 * @typedef {{ id?: string, type?: string, tool?: string, defaultBranch?: string, [key: string]: unknown }} DagStep
 */

/**
 * One step's entry in runState.steps.
 * @typedef {{ output: unknown, status: string, synthesised?: boolean,
 *   error?: { message: string, errorClass: string | null, stepId: string } }} DagStepEntry
 */

/**
 * @typedef {import('../automationModel/bind').BindRunState & { steps?: Record<string, DagStepEntry>,
 *   secrets?: Record<string, unknown>,
 *   _handledErrors?: Array<{ stepId: string, message: string, errorClass?: string | null }> }} DagRunState
 */

/**
 * A step output, as far as routing reads it (the brancher fields).
 * @typedef {{ branch?: string, branches?: string[], viaDefault?: boolean, matched?: unknown, [key: string]: unknown }} StepOutput
 */

/**
 * What dispatchStep returns for a step that ran.
 * @typedef {{ output?: StepOutput | null, skippedReason?: string, dryRunSynthesised?: boolean, dryRunFallback?: unknown,
 *   attempt?: number, attemptStartedAt?: string, startedAt?: string, inputSnapshot?: unknown, piiSummary?: unknown,
 *   bindingWarnings?: unknown[], toolsWithheld?: string[], toolsWithheldReasons?: Record<string, string> }} Dispatched
 */

/** @typedef {(step: DagStep, ctx: DagCtx, runState: DagRunState, mode: string) => Promise<Dispatched>} DispatchStep */

/**
 * The walk state dispatchLiveStep needs.
 * @typedef {{ ctx: DagCtx, runState: DagRunState, mode: string, dispatchStep: DispatchStep, adj: EdgeMap,
 *   recordSteps: boolean, branchIndex: number | null }} LiveWalk
 */

/** @typedef {Error & { errorClass?: string, finalAttempt?: number }} StepError */
