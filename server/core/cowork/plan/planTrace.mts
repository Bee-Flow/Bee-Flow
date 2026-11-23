/**
 * A run of a plan as a person reads it afterwards: the plan's steps in order, each with how it went, how long it took
 * and a short preview. The same reading serves a try-out (usecases/coworkPlanTry.mts) and a real run in the item's
 * history (usecases/coworkRunTrace.mts).
 *
 *   - A step that only reads previews what it got. A step that changes or sends previews what went INTO it: the
 *     draft, the row, the recipient. In a try-out that is what it WOULD have written or sent, and its simulated
 *     answer (made-up sample data) is never shown as if it were real.
 *   - The runner records a loop as one step, not its body per item, so a step inside a loop goes by its loop: it has
 *     the loop's status and no preview of its own.
 *   - A step the finished run never came to (a branch not taken, a step after a failure) is 'not_reached'.
 *
 * Pure: the definition and the recorded steps come in, nothing is read here.
 */

import type { Definition, Effect, StepKind, ToolLookups } from './planTypes.mts';
import { planViewOf } from './planView.mts';
import { stepsOf } from './planWalk.mts';

/** One recorded attempt of a step (stores/automationStore rowToRunStep, the fields read here). */
export interface RunStepRow {
    stepId: string;
    attempts?: number;
    status?: string;
    startedAt?: string | null;
    finishedAt?: string | null;
    input?: unknown;
    output?: unknown;
    error?: string | null;
}

/** One plan step of a run. */
export interface TraceStep {
    id: string;
    title: string;
    kind: StepKind;
    effect: Effect;
    /** 'pending' until the run reaches it, then the runner's own status; 'not_reached' when the run ended before it. */
    status: string;
    /** 0 at the top level, 1 inside a loop: such a step runs once per item and goes by its loop's status. */
    depth: number;
    durationMs: number | null;
    /** A try-out held this step back: it would change or send something. Never true in a real run. */
    held: boolean;
    error: string | null;
    /** What the step got (a reading step), or what it wrote or sent, or would have (a held step); null when nothing. */
    preview: string | null;
}

const PREVIEW_MAX = 600;

/** A value as a short text a person can read. */
export function previewOf(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    let text: string;
    if (typeof value === 'string') text = value;
    else {
        try { text = JSON.stringify(value, null, 1); } catch { return null; }
    }
    const trimmed = text.trim();
    if (!trimmed || trimmed === '{}' || trimmed === '[]') return null;
    return trimmed.length > PREVIEW_MAX ? `${trimmed.slice(0, PREVIEW_MAX)}…` : trimmed;
}

function durationOf(row: RunStepRow): number | null {
    if (!row.startedAt || !row.finishedAt) return null;
    const ms = new Date(row.finishedAt).getTime() - new Date(row.startedAt).getTime();
    return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** The last attempt of each step: the one that counts. */
function lastAttempts(rows: RunStepRow[]): Map<string, RunStepRow> {
    const last = new Map<string, RunStepRow>();
    for (const row of rows) {
        const seen = last.get(row.stepId);
        if (!seen || (row.attempts ?? 0) >= (seen.attempts ?? 0)) last.set(row.stepId, row);
    }
    return last;
}

export interface TraceFacts {
    /** The run is over: a step no row speaks for was never reached. */
    done: boolean;
    /** A try-out: steps that would change or send were held back. */
    simulated: boolean;
}

/** The steps of `definition` with how each went in the run these rows are of. */
export function traceSteps(definition: Definition | null | undefined, rows: RunStepRow[], facts: TraceFacts, lookups: ToolLookups): TraceStep[] {
    const last = lastAttempts(rows);
    const parentOf = new Map(stepsOf(definition).map((s) => [s.id, s.parentId]));
    /** A step's own status, else its loop's; a step no row speaks for is still to come, or was never reached. */
    const statusOf = (id: string): string => {
        for (let at: string | null | undefined = id; at; at = parentOf.get(at)) {
            const row = last.get(at);
            if (row) return row.status ?? 'pending';
        }
        return facts.done ? 'not_reached' : 'pending';
    };
    return planViewOf(definition, lookups).steps.map((step): TraceStep => {
        const row = last.get(step.id);
        const acts = step.effect !== 'reads';
        return {
            id: step.id, title: step.title, kind: step.kind, effect: step.effect,
            status: statusOf(step.id),
            depth: step.depth,
            durationMs: row ? durationOf(row) : null,
            held: facts.simulated && acts,
            error: row?.error ?? null,
            preview: row ? previewOf(acts ? row.input : row.output) : null,
        };
    });
}

/** Run statuses in which the run is still at work. */
const AT_WORK: ReadonlySet<string> = new Set(['queued', 'running']);

/** A run with this status is over, or waits for a person: nothing more happens by itself. */
export const runIsOver = (status: string | null | undefined): boolean => !AT_WORK.has(status ?? 'running');
