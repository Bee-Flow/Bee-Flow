/**
 * The one chat frame reducer.
 *
 * Every chat surface folds the same event vocabulary (content, thinking,
 * tools, citations, DLP, guardrails, done, error…) into a live turn, and they
 * used to do it in four near-copies of one switch that drifted apart —
 * `tool_confirm` was ignored by one and unknown to the others. Now a surface
 * is an ADAPTER: a table from event name to a handler (or IGNORE), built from
 * the shared handlers in handlers.ts. The table is data, so a test can ask
 * which events each surface accounts for without mounting anything.
 *
 * Three outcomes per frame, and the difference matters:
 *   - a handler ran           → the turn changed; `mark()` schedules a render
 *                               (unless the handler returned `false`)
 *   - the name maps to IGNORE → a decision somebody made; nothing happens
 *   - the name is not listed  → `onUnhandled`, so a feature the server grew
 *                               shows up as a gap instead of as nothing
 */

import type { SseFrame } from '@/core/api/sse';

export type FrameData = Readonly<Record<string, unknown>>;

/**
 * Mutates the live turn in place. Return `false` when the frame changed
 * nothing, so it does not cost a render.
 */
export type FrameHandler<S> = (turn: S, d: FrameData) => boolean | void;

/** Accounted for, deliberately not acted on. */
export const IGNORE = 'ignore' as const;

export type FrameAdapter<S> = Readonly<Record<string, FrameHandler<S> | typeof IGNORE>>;

export interface FrameSink {
    /** The turn changed; publish it on the next flush. */
    mark: () => void;
    /** An event no adapter entry accounts for. */
    onUnhandled?: (event: string, data: unknown) => void;
}

/** Narrow an unknown SSE payload to a record without reaching for `any`. */
export function asRecord(data: unknown): FrameData {
    return data && typeof data === 'object' ? (data as FrameData) : {};
}

/** Own keys only: an event called `constructor` must not find Object's. */
export function entryFor<S>(
    adapter: FrameAdapter<S>,
    event: string,
): FrameHandler<S> | typeof IGNORE | undefined {
    return Object.prototype.hasOwnProperty.call(adapter, event) ? adapter[event] : undefined;
}

/** Fold one frame into the live turn through a surface's adapter. */
export function reduceFrame<S>(adapter: FrameAdapter<S>, turn: S, frame: SseFrame, sink: FrameSink): void {
    const entry = entryFor(adapter, frame.event);
    if (entry === undefined) {
        sink.onUnhandled?.(frame.event, frame.data);
        return;
    }
    if (entry === IGNORE) return;
    if (entry(turn, asRecord(frame.data)) !== false) sink.mark();
}

/** Whether a surface routes or deliberately ignores an event. */
export function accounts<S>(adapter: FrameAdapter<S>, event: string): boolean {
    return entryFor(adapter, event) !== undefined;
}
