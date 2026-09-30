/**
 * What the editor knows about its last test run, and how each thing that
 * happens to one changes it. Pure: the store (testRunStore.ts) applies these.
 *
 * The web builder keeps the same bookkeeping in its builder stream hook
 * (useAutomationBuilderStream.ts executeStep / pollRunProgress):
 *
 *   - a dry run REPLACES the rows — once its own run id is first seen, so the
 *     cards keep the previous run's colours until the new one has news;
 *   - a step run ("Test this step", "Run up to here", "Run from here")
 *     MERGES its rows by step id: it records one step, or a step and what
 *     follows it, and every other card keeps what it showed;
 *   - a step run that fails replaces that step's row with an error row and
 *     drops its flowlet sub-rows (`markStepFailed`): the old row's output
 *     belongs to an attempt that is no longer true;
 *   - while the request is out, the run feed's step events (GET
 *     /_runs/stream) light the cards up as the steps go — the request itself
 *     only answers when the run is over.
 */

import type { AutomationRun, AutomationRunStep, RunEvent } from '@/features/automations';
import type { StepRunMode, StepRunResult, TestRunResult } from '@/features/flow-editor/api';

export type TestRunKind = 'dry' | 'step';

export interface TestRunState {
    kind: TestRunKind | null;
    mode: StepRunMode | null;
    /** The step a step run was asked for. */
    stepId: string | null;
    pending: boolean;
    /** When this test began and settled, by the phone's clock. */
    startedAt: string | null;
    finishedAt: string | null;
    /** The run the feed reported for this test (then the answer's). */
    runId: string | null;
    run: AutomationRun | null;
    rows: AutomationRunStep[];
    /** The request failed: the words for it. */
    error: string | null;
}

export const IDLE_TEST_RUN: TestRunState = Object.freeze({
    kind: null,
    mode: null,
    stepId: null,
    pending: false,
    startedAt: null,
    finishedAt: null,
    runId: null,
    run: null,
    rows: [],
    error: null,
}) as TestRunState;

export function beginRun(
    state: TestRunState,
    { kind, stepId = null, mode = null, now }: { kind: TestRunKind; stepId?: string | null; mode?: StepRunMode | null; now: number },
): TestRunState {
    return { ...state, kind, stepId, mode, pending: true, startedAt: new Date(now).toISOString(), finishedAt: null, runId: null, error: null };
}

/** The row a `step.started` frame makes: the step is running, nothing of an older attempt carried. */
function startedRow(runId: string, event: RunEvent, prev: AutomationRunStep | undefined): AutomationRunStep {
    return {
        runId, stepId: event.stepId as string, parentStepId: null, stepType: event.stepType ?? prev?.stepType ?? null,
        attempts: prev?.attempts ?? null, status: 'running', startedAt: event.at ?? null, finishedAt: null,
        input: prev?.input, output: undefined, error: null, errorClass: null, branchIndex: prev?.branchIndex ?? null,
    };
}

/** A `step.finished` frame settles the row it started (the feed carries no output: the answer brings it). */
function finishedRow(runId: string, event: RunEvent, prev: AutomationRunStep | undefined): AutomationRunStep {
    const base = prev ?? startedRow(runId, event, undefined);
    return {
        ...base, runId, status: event.status || 'success', startedAt: base.startedAt, finishedAt: event.at ?? null,
        error: event.error ?? null, errorClass: event.errorClass ?? null,
    };
}

function liveRow(runId: string, event: RunEvent, prev: AutomationRunStep | undefined): AutomationRunStep {
    return event.type === 'step.finished' ? finishedRow(runId, event, prev) : startedRow(runId, event, prev);
}

/** A step event of the run this test started lights its card; anything else is ignored. */
export function applyRunEvent(state: TestRunState, event: RunEvent): TestRunState {
    if (!state.pending || !event.runId) return state;
    if (state.runId && event.runId !== state.runId) return state;
    const claimed = state.runId
        ? state
        : { ...state, runId: event.runId, rows: state.kind === 'dry' ? [] : state.rows };
    if ((event.type !== 'step.started' && event.type !== 'step.finished') || !event.stepId) return claimed;
    const prev = claimed.rows.find((r) => r.stepId === event.stepId && !r.parentStepId);
    const row = liveRow(event.runId, event, prev?.runId === event.runId ? prev : undefined);
    const rows = prev ? claimed.rows.map((r) => (r === prev ? row : r)) : [...claimed.rows, row];
    return { ...claimed, rows };
}

/** A run stub still saying "running" after its request settled did not finish. */
function settleRunStub(run: AutomationRun | null): AutomationRun | null {
    return run && run.status === 'running' ? { ...run, status: 'error' } : run;
}

export function settleDryRun(state: TestRunState, result: TestRunResult, now: number): TestRunState {
    return {
        ...state,
        pending: false,
        finishedAt: new Date(now).toISOString(),
        run: result.run,
        runId: result.run?.id ?? state.runId,
        rows: result.steps,
    };
}

/** The answer's rows win; rows it does not carry are kept. */
export function mergeRows(rows: readonly AutomationRunStep[], fresh: readonly AutomationRunStep[]): AutomationRunStep[] {
    const byId = new Map(rows.map((r) => [r.stepId, r]));
    for (const r of fresh) byId.set(r.stepId, r);
    return Array.from(byId.values());
}

export function settleStepRun(state: TestRunState, result: StepRunResult, now: number): TestRunState {
    return {
        ...state,
        pending: false,
        finishedAt: new Date(now).toISOString(),
        run: result.run ?? settleRunStub(state.run),
        runId: result.run?.id ?? state.runId,
        rows: mergeRows(state.rows, result.steps),
    };
}

/**
 * One step's row after a failed step run: an error row that carries nothing
 * of the attempt before it, and none of its flowlet sub-rows
 * (`<stepId>/<subId>`, recursively).
 */
export function markStepFailed(rows: readonly AutomationRunStep[], stepId: string, error: string): AutomationRunStep[] {
    if (!stepId) return rows.slice();
    const prefix = `${stepId}/`;
    const failed: AutomationRunStep = {
        runId: '', stepId, parentStepId: null, stepType: null, attempts: null, status: 'error',
        startedAt: null, finishedAt: null, input: undefined, output: null, error, errorClass: null, branchIndex: null,
    };
    const out: AutomationRunStep[] = [];
    let replaced = false;
    for (const row of rows) {
        if (row.stepId === stepId && !row.parentStepId) {
            out.push(failed);
            replaced = true;
        } else if (!row.stepId.startsWith(prefix)) {
            out.push(row);
        }
    }
    if (!replaced) out.push(failed);
    return out;
}

export function failRun(state: TestRunState, message: string, now: number): TestRunState {
    const rows = state.kind === 'step' && state.stepId ? markStepFailed(state.rows, state.stepId, message) : state.rows;
    return { ...state, pending: false, finishedAt: new Date(now).toISOString(), error: message, run: settleRunStub(state.run), rows };
}

/** How long the test took: the run's own measure, else the phone's clock. */
export function testDurationMs(state: TestRunState): number | null {
    if (state.run?.durationMs != null) return state.run.durationMs;
    const start = Date.parse(state.startedAt || '');
    const end = Date.parse(state.finishedAt || '');
    return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}
