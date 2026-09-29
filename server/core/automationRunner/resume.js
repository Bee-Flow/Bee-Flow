/**
 * Resuming a paused run (extracted verbatim from automationRunner.js).
 *
 * A run that stopped on an approval or a form page continues here: the ancestor
 * chain is replayed into runState, the awaited decision is injected as the
 * boundary step's output, and executeAutomation re-enters the DAG past it.
 */

const automationStore = require('../../stores/automationStore');
const { isTruncatedOutput } = require('../../automation/payloadTruncation');
const { replayEntryFromRow, withFullOutput } = require('./replaySeeding');
const { gapsReadAfterPause } = require('./replayGaps');
const { executeAutomation } = require('./execution');
const { automationForRun, withWorkingSettings } = require('./definitionForRun');

/**
 * Continue a paused run from its awaiting step.
 *
 * `rootStepId` defaults to the one the paused run recorded (`root_step_id`,
 * automation-multi-trigger-2026-09): a routine entered through a SECONDARY
 * trigger used to resume from the primary one — the approval decision then
 * re-entered a DAG with no replay data on the primary path and drained to
 * "success" having dispatched nothing. A caller that knows better (the public
 * form resume reads it off the form session) may still pass it explicitly.
 * `triggerHeaders` do not survive on the row, so `trigger.headers.*` bindings
 * resolve to nothing after a pause unless the caller passes them back in.
 */
/**
 * The statuses that mean "this run is mid-journey, waiting on a human".
 * Resuming one of those CONTINUES that journey; resuming anything else (a
 * failed run, a finished one) is a fresh attempt that deserves its own line in
 * the history. See resumeFromStep's rootRunId below.
 */
const PAUSED_STATUSES = new Set(['awaiting_form', 'awaiting_approval', 'awaiting_confirm']);

async function resumeFromStep(runId, fromStepId, { decision = null, userId = null, rootStepId = null, triggerHeaders = null, onRunCreated = null, onRunFinished = null } = {}) {
    const original = await automationStore.getRun(runId);
    if (!original) throw new Error(`Run ${runId} not found`);
    const stored = await automationStore.getAutomation(original.automationId);
    if (!stored) throw new Error(`Automation ${original.automationId} not found`);
    // A resumed run finishes on the definition of the version it STARTED on
    // (handoff 5). Since the live split, the stored row can hold two copies,
    // and either may have moved on while the run waited for an approver or a
    // visitor: a publish in between must not graft the rest of a new flow
    // onto the first half of the old one. The snapshot of that version is the
    // truth; a legacy run whose version was never snapshotted falls back to
    // the copy a run of this kind would execute today.
    const pinned = typeof automationStore.getVersionDefinition === 'function'
        ? await Promise.resolve().then(() => automationStore.getVersionDefinition(stored.id, original.version)).catch(() => null)
        : null;
    const fallback = automationForRun(stored, { mode: 'live', triggerKind: original.triggerKind, isTest: !!original.isTest });
    // Spread, then pin: the spread drops the row's non-enumerable live copy,
    // so executeAutomation runs exactly this definition. The pinned steps keep
    // the working copy's SETTINGS (notifications, run policy, app buttons):
    // those apply at once, also to a run that was waiting (definitionForRun.js).
    const automation = {
        ...fallback,
        definition: pinned ? withWorkingSettings(pinned, stored.definition) : fallback.definition,
        version: pinned ? original.version : fallback.version,
    };

    // Replay state from previously-recorded step rows so binding
    // expressions like {{steps.stepX.output.field}} resolve to what they
    // resolved to in the original run.
    //
    // Walk the WHOLE ancestor chain, oldest first. runDag does not re-record
    // the steps it replays, so a run that was itself resumed only has rows for
    // the steps it dispatched live. Reading just this run would silently drop
    // everything produced before the previous pause — which is the normal case
    // for a three-page form (page 1's answers live on the first run's rows).
    // Later runs are merged last so a step re-executed live wins over its
    // cached ancestor.
    const chain = [];
    for (let cur = original, guard = 0; cur && guard < 50; guard++) {
        chain.unshift(cur);
        cur = cur.parentRunId ? await automationStore.getRun(cur.parentRunId).catch(() => null) : null;
    }
    const previousSteps = [];
    for (const r of chain) {
        previousSteps.push(...await automationStore.getRunSteps(r.id));
    }
    const replayedStepState = {};
    // Steps whose only row is the truncation sentinel with no full copy kept
    // (BFSF-435): stepId → original size. See replayGaps.js.
    const gaps = new Map();
    for (const row of previousSteps) {
        if (!row.stepId || row.status === 'awaiting_approval' || row.status === 'awaiting_form') continue;
        // Layer sub-steps (parent_step_id set, ids like 'cl1/out') are not
        // nodes of the parent graph — replaying them would pollute
        // runState.steps with ids no binding can reference. Retry-from-step
        // granularity stays parent-graph: re-running a call_layer step
        // re-executes the WHOLE layer.
        if (row.parentStepId) continue;
        // An output over the run history's cap was persisted as a sentinel.
        // It is not the output, and this resume will not run the step again
        // to get it: swap in the full copy the store kept beside the row.
        const s = await withFullOutput(row);
        // acceptSynthetic: 'pinned' and 'skipped' rows carry a real recorded
        // output and the resume never dispatches those steps again — dropping
        // them made them vanish from runState entirely, which for a PINNED
        // BRANCHER threw "Replay missing branch label" and left the approval
        // impossible to complete (W5-14). Rows are ordered by attempts ASC, so
        // a final handled_error still wins over the earlier 'error' attempts.
        const entry = replayEntryFromRow(s, s.stepId, { acceptSynthetic: true });
        if (entry) {
            replayedStepState[s.stepId] = entry;
            gaps.delete(s.stepId);
        } else if (isTruncatedOutput(s.output)) {
            gaps.set(s.stepId, Number(s.output.originalBytes) || null);
        }
    }
    // Definition-level pins win over history, exactly as they do for a partial
    // run — a step pinned since the pause must serve its pin on the resume too,
    // and a pinned step that never got as far as recording a row would
    // otherwise be a hole in the replay.
    for (const s of (automation.definition?.steps || [])) {
        if (s?.pinnedOutput !== undefined && s?.pinnedOutput !== null) {
            replayedStepState[s.id] = { output: s.pinnedOutput, status: 'success' };
        }
    }
    // Inject the synthetic decision output for the resumption-boundary step.
    if (fromStepId) {
        replayedStepState[fromStepId] = {
            output: decision || { approved: true, resumedAt: new Date().toISOString(), by: userId },
            status: 'success',
        };
    }

    return await executeAutomation({
        ...automation,
    }, {
        triggerKind: original.triggerKind || 'manual',
        triggerPayload: original.triggerPayload || null,
        triggerHeaders,
        mode: 'live',
        parentRunId: runId,
        // Continuing a pause keeps the journey the visitor started, so the
        // history shows their three-question form as ONE run instead of one row
        // per answer. A retry of a run that already ended is a new journey.
        rootRunId: PAUSED_STATUSES.has(original.status) ? (original.rootRunId || original.id) : null,
        onRunCreated,
        onRunFinished,
        replayState: replayedStepState,
        // The gaps a step after the pause reads: runDag fails the run when it
        // reaches one instead of replaying a hole (BFSF-435).
        replayGaps: gapsReadAfterPause(automation.definition, fromStepId, gaps),
        skipUntilStepId: fromStepId,
        rootStepId: rootStepId ?? original.rootStepId ?? null,
        // A resumed test run is still a test run (the Runs tab's filter).
        isTest: !!original.isTest,
        startedByUserId: original.startedByUserId || null,
    });
}

module.exports = { resumeFromStep };
