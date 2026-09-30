/**
 * The TRAIL of one turn's phase events — the port of the web's
 * agent-hub/src/hooks/useChatEngine/phaseTrail.ts (pinned by
 * phaseTrail.lockstep.test.ts, which runs both on the same events).
 *
 * The server sends `phase` frames through every turn — `{ stage, status:
 * 'start'|'end', detail?, durationMs? }` (server/core/agentRuntime/
 * phaseEvents.js). The live line shows one at a time and the first token wipes
 * it; this keeps them, in arrival order, so after the answer there is still
 * something that says what happened.
 *
 * The trail invents nothing:
 *  1. An `end` without a `start` makes no row — a step whose beginning was
 *     never seen did not happen as far as this screen can say.
 *  2. A repeated `start` of the same OPEN stage is the same step, with its
 *     detail moved on (the privacy scan sends one per scanned window: '3/6').
 *
 * Stages overlap (guardrails runs around privacy_scan on the agent path), so
 * the durations must not be summed into "how long the turn took"; the span
 * is first start to last end.
 *
 * Pure: `now` is injectable so a test does not wait on a clock.
 */

import type { PhaseTrailEntry } from './types';

/** How many steps one turn may leave. A bound for a stream that never stops, not a limit that bites. */
export const MAX_TRAIL_STEPS = 40;

/** A pre-LLM progress step (KB search, attachment OCR, guardrails, …). */
export interface PhaseEvent {
    stage?: unknown;
    status?: unknown;
    detail?: unknown;
    durationMs?: unknown;
}

/** A non-empty, trimmed string, or null. */
function text(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed || null;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Close the last still-open row of this stage. No start, no row. */
function closeStep(rows: PhaseTrailEntry[], stage: string, data: PhaseEvent, now: number): PhaseTrailEntry[] | null {
    let at = -1;
    // Backwards: a stage that ran twice gets its own end, not the first run's.
    for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i];
        if (row && row.stage === stage && row.endedAt == null) {
            at = i;
            break;
        }
    }
    if (at < 0) return null;
    const row = rows[at] as PhaseTrailEntry;
    const next = rows.slice();
    next[at] = {
        ...row,
        endedAt: now,
        // The server measures its own duration, which beats the gap between
        // two ticks here; without one, ours stands in — both real measurements.
        durationMs: finite(data.durationMs) ? data.durationMs : finite(row.startedAt) ? now - row.startedAt : null,
    };
    return next;
}

/** Open a step, or move the detail on of the same step that is still running. */
function openStep(rows: PhaseTrailEntry[], stage: string, detail: string | null, now: number): PhaseTrailEntry[] | null {
    const last = rows.length > 0 ? rows[rows.length - 1] : null;
    if (last && last.stage === stage && last.endedAt == null) {
        if (last.detail === detail) return null;
        const next = rows.slice();
        next[next.length - 1] = { ...last, detail };
        return next;
    }
    if (rows.length >= MAX_TRAIL_STEPS) return null;
    return [...rows, { stage, detail, startedAt: now, endedAt: null, durationMs: null }];
}

/**
 * Fold one `phase` event into the trail. Returns the SAME array when there was
 * nothing to do, so a caller can skip a render.
 */
export function appendPhase(
    trail: PhaseTrailEntry[] | undefined,
    data: PhaseEvent | null | undefined,
    now: number = Date.now(),
): PhaseTrailEntry[] | undefined {
    const rows = Array.isArray(trail) ? trail : [];
    const stage = text(data?.stage);
    if (!stage || !data) return trail;
    const next = data.status === 'end' ? closeStep(rows, stage, data, now) : openStep(rows, stage, text(data.detail), now);
    return next || trail;
}

/**
 * The span of a trail, first start to last end — what "how long did this
 * take" can honestly say (the web's traceSpanMs in answerTrace.js).
 */
export function traceSpanMs(trail: readonly PhaseTrailEntry[] | undefined): number | null {
    let first: number | null = null;
    let last: number | null = null;
    for (const row of trail ?? []) {
        for (const t of [row.startedAt, row.endedAt]) {
            if (!finite(t)) continue;
            if (first === null || t < first) first = t;
            if (last === null || t > last) last = t;
        }
    }
    if (first === null || last === null || last <= first) return null;
    return last - first;
}
