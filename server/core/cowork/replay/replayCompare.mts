/**
 * Does a changed plan come out the same as the plan that ran then, on one past run's recording (./replayRun.mts)?
 *
 * Both sides are dry runs on the same recording: the plan as it was approved then (the baseline, which reproduces
 * the past run from what it read) and the plan as it is now. So a write or a send is simulated on both sides the
 * same way, and two runs that would do the same come out byte for byte the same; comparing the replay with the live
 * run itself would set a simulated mail next to a sent one.
 *
 * Per step: present on both sides, with the same status, the same input and the same output. A step either side
 * marked as having no recording (core/automationRunner/recordedReads.mts) decides nothing but is counted: a replay
 * with any is only a replay in part. The questions Cowork asks (approvals, forms) are compared by status only: a
 * replay answers them as they were answered then.
 *
 * Step ids and counts only: nothing of what a step read or wrote leaves this module.
 */

import type { RecordedStep } from './recordingOf.mts';
import { canonicalHash, NO_RECORDING } from '../../automationRunner/recordedReads.mts';

export type Verdict = 'same' | 'differs' | 'partial';
export interface Comparison { verdict: Verdict; missingSteps: number; differingSteps: string[] }

/** At most this many step ids are kept per past run. */
export const MAX_DIFFERING = 50;
const QUESTION_TYPES: ReadonlySet<string> = new Set(['approval', 'form_page']);

/** A step had no recording somewhere in its output (a step that loops marks each item it could not answer). */
export function hadNoRecording(step: RecordedStep | undefined): boolean {
    if (!step) return false;
    if (!step.usable) return true;
    try {
        return JSON.stringify(step.output ?? null).includes(`"${NO_RECORDING}":true`);
    } catch {
        return false;
    }
}

function differs(a: RecordedStep | undefined, b: RecordedStep | undefined, outputOnly: boolean): boolean {
    if (!a || !b) return true;
    if (a.status !== b.status) return true;
    if (QUESTION_TYPES.has(b.stepType)) return false;
    if (!outputOnly && canonicalHash(a.input) !== canonicalHash(b.input)) return true;
    return canonicalHash(a.output) !== canonicalHash(b.output);
}

/**
 * The verdict of one replay: `baseline` the plan then, `candidate` the plan now, both on the same recording. A step in
 * `outputOnly` is compared on its status and what it hands on: its type changed on purpose, so it reads differently.
 */
export function compareReplay(baseline: Map<string, RecordedStep>, candidate: Map<string, RecordedStep>, outputOnly: ReadonlySet<string> = new Set()): Comparison {
    const ids = [...new Set([...baseline.keys(), ...candidate.keys()])].sort();
    const missing = ids.filter((id) => hadNoRecording(baseline.get(id)) || hadNoRecording(candidate.get(id)));
    const differing = ids.filter((id) => !missing.includes(id) && differs(baseline.get(id), candidate.get(id), outputOnly.has(id)));
    const verdict: Verdict = missing.length > 0 ? 'partial' : differing.length > 0 ? 'differs' : 'same';
    return { verdict, missingSteps: missing.length, differingSteps: differing.slice(0, MAX_DIFFERING) };
}
