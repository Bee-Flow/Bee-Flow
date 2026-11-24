/**
 * The recording of one past plan run, for a replay (./replayRun.mts): what each step of its automation run read and
 * handed on, over every leg of the journey (a run that waited for a decision continues in a child run).
 *
 *   - the step rows are the run history's own (automation_run_steps); a later leg's row for a step wins, and so does
 *     a later attempt;
 *   - an output the history had to cut is swapped for the full copy kept beside it, read at the row's own
 *     coordinates only (as core/automationRunner/replaySeeding.js withFullOutput does); a cut output without a copy is
 *     no recording: that step's read is not answered from it;
 *   - a dry run is no recording: what it read was made up.
 *
 * Nothing here is shown to anyone: the replay hands these values to the engine and keeps only counts and step ids.
 */

import { createRequire } from 'node:module';
import type { Definition, DefStep } from '../plan/planTypes.mts';
import { stepsOf } from '../plan/planWalk.mts';
import { plainPlan } from '../plan/planPermissions.mts';
import { canonicalHash, recordingKey } from '../../automationRunner/recordedReads.mts';

const nodeRequire = createRequire(import.meta.url);
const { isTruncatedOutput, fullOutputRefOf } = nodeRequire('../../../stores/automationStore/payloadTruncation') as {
    isTruncatedOutput: (v: unknown) => boolean;
    fullOutputRefOf: (v: unknown) => { runId: string; stepId: string; attempts: number } | null;
};

export interface RunRow { id: string; mode?: string | null; startedAt?: string | null; triggerPayload?: unknown }
export interface StepRow { runId: string; stepId: string; stepType?: string | null; attempts?: number | null; status?: string | null; input?: unknown; output?: unknown; verdict?: unknown }

export interface RecordedStep {
    stepId: string;
    stepType: string;
    status: string;
    input: unknown;
    output: unknown;
    /** The output is the step's whole output (not a cut one without its copy). */
    usable: boolean;
    /** An AI step's verdict on its own work, when it gave one (core/automationRunner/aiStepVerdict.mts). */
    verdict?: unknown;
}

export interface Recording {
    automationRunId: string;
    startedAt: string | null;
    triggerPayload: unknown;
    steps: Map<string, RecordedStep>;
}

export interface RecordingDeps {
    getRun: (id: string) => Promise<RunRow | null>;
    getRunStepsForChain: (id: string) => Promise<StepRow[]>;
    getRunFullOutput: (runId: string, stepId: string, attempts: number) => Promise<unknown>;
}

/** The row's output, the kept full copy of a cut one, or `usable: false` when it was cut and not kept. */
async function fullOutputOf(row: StepRow, deps: RecordingDeps): Promise<{ output: unknown; usable: boolean }> {
    if (!isTruncatedOutput(row.output)) return { output: row.output ?? null, usable: true };
    const ref = fullOutputRefOf(row.output);
    const attempts = row.attempts ?? 1;
    // The ref is JSON inside output_json: only one naming this very row is followed.
    if (!ref || ref.runId !== row.runId || ref.stepId !== row.stepId || ref.attempts !== attempts) return { output: null, usable: false };
    const full = await deps.getRunFullOutput(row.runId, row.stepId, attempts);
    return full == null ? { output: null, usable: false } : { output: full, usable: true };
}

/**
 * The final row of every step of one automation run's journey, with full outputs. Also what a replay's own dry run
 * recorded, which ./replayCompare.mts reads the same way.
 */
export async function recordedStepsOf(automationRunId: string, deps: RecordingDeps): Promise<Map<string, RecordedStep>> {
    // Oldest leg first, attempts in order: the last row for a step is the one that counts.
    const finalRows = new Map<string, StepRow>();
    for (const row of await deps.getRunStepsForChain(automationRunId)) {
        if (row.status === 'running') continue;
        finalRows.set(row.stepId, row);
    }
    const steps = new Map<string, RecordedStep>();
    for (const row of finalRows.values()) {
        const { output, usable } = await fullOutputOf(row, deps);
        steps.set(row.stepId, { stepId: row.stepId, stepType: String(row.stepType ?? ''), status: String(row.status ?? ''), input: row.input ?? null, output, usable, verdict: row.verdict ?? null });
    }
    return steps;
}

/** The recording of one automation run (its whole journey), or null when it is gone or was a dry run. */
export async function recordingOf(automationRunId: string, deps: RecordingDeps): Promise<Recording | null> {
    const run = await deps.getRun(automationRunId);
    if (!run || run.mode === 'dry_run') return null;
    const steps = await recordedStepsOf(automationRunId, deps);
    return { automationRunId, startedAt: run.startedAt ?? null, triggerPayload: run.triggerPayload ?? null, steps };
}

const STEP_NOISE: readonly string[] = ['label', 'description'];

/** One step as it decides what the step does: without its layout and its name. */
export function stepFingerprint(step: DefStep): string {
    const plain = { ...(plainPlan({ steps: [step] }).steps as Record<string, unknown>[])[0] };
    for (const key of STEP_NOISE) delete plain[key];
    return canonicalHash(plain);
}

const succeeded = (s: RecordedStep): boolean => s.status === 'success' && s.usable;

/** The integration reads of the recording, by their recordingKey (the tool is the one the run's plan named). */
export function recordedReadsOf(recording: Recording, planThen: Definition): Record<string, unknown> {
    const toolOf = new Map(stepsOf(planThen).map((w) => [w.id, typeof w.step.tool === 'string' ? w.step.tool : '']));
    const out: Record<string, unknown> = {};
    for (const s of recording.steps.values()) {
        const tool = toolOf.get(s.stepId);
        if (s.stepType !== 'integration_action' || !tool || !succeeded(s)) continue;
        out[recordingKey(s.stepId, tool, s.input)] = s.output;
    }
    return out;
}

/** What each step handed on, as canonical hashes. */
export function outputHashesOf(recording: Recording): Record<string, string> {
    const out: Record<string, string> = {};
    for (const s of recording.steps.values()) if (succeeded(s)) out[s.stepId] = canonicalHash(s.output);
    return out;
}

/**
 * The recorded answers of steps that are not an app call by key (an AI step, a GET, a table read), for the steps
 * whose definition in the plan now is the same as in the plan then.
 */
export function unchangedAnswersOf(recording: Recording, planThen: Definition, planNow: Definition): Record<string, unknown> {
    const then = new Map(stepsOf(planThen).map((w) => [w.id, stepFingerprint(w.step)]));
    const out: Record<string, unknown> = {};
    for (const w of stepsOf(planNow)) {
        const s = recording.steps.get(w.id);
        if (!s || w.type === 'integration_action' || !succeeded(s) || then.get(w.id) !== stepFingerprint(w.step)) continue;
        out[w.id] = s.output;
    }
    return out;
}

/** The decisions the recorded run's questions got: approved when the step went on, rejected when it did not. */
export function decisionsOf(recording: Recording): Record<string, { decision: 'approve' | 'reject' }> {
    const out: Record<string, { decision: 'approve' | 'reject' }> = {};
    for (const s of recording.steps.values()) {
        if (s.stepType !== 'approval' || s.status.startsWith('awaiting')) continue;
        out[s.stepId] = { decision: s.status === 'success' ? 'approve' : 'reject' };
    }
    return out;
}
