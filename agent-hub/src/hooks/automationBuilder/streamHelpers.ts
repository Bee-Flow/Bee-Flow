import type { BuilderMessage, BuilderSnapshot, BuilderTurn } from '../builderStream';
import type { AutomationBuilderState } from './types';

/** Turn and message helpers the builder stream's reducer and hook share. */

// Mark any in-flight assistant message as no-longer-streaming and stamp the
// reasoning end time, so its thinking block flips from "Thinking…" to
// "Thought for Xs" and stops pulsing once the stream ends.
export function finalizeStreaming(messages: BuilderMessage[]): BuilderMessage[] {
    if (!Array.isArray(messages) || !messages.some(m => m && m.isStreaming)) return messages;
    return messages.map(m => (m && m.isStreaming
        ? { ...m, isStreaming: false, thinkingEndedAt: m.thinkingEndedAt || (m.thinkingStartedAt ? Date.now() : undefined) }
        : m));
}

/**
 * The turn's silence, measured. A local 27B model reads a ~28k-token prompt
 * at a rate that puts the first token two to three MINUTES out, and in that
 * window the stream carries nothing but `builder_session` and the 10 s
 * `ping` heartbeat. This object is what lets the chat column say something
 * true during that time: what has already happened, that the connection is
 * alive, and — once a few turns have been timed — roughly how long it takes.
 *
 *   sentAt         when send() fired; every elapsed figure counts from here
 *   tier           the tier asked for, replaced by the resolved one on
 *                  `model_selected` (so 'auto' is never a bucket of its own)
 *   sessionAt      `builder_session` arrived — the server accepted the turn
 *   pings          heartbeats seen; the card re-animates its dot per beat
 *   modelId        from `model_selected` / `round_start`, when the server
 *                  names one; the key the learned duration is filed under
 *   roundStartedAt / promptChars   from the optional `round_start` event
 *   firstEventAt   the first thinking/text/tool event — the silence's end,
 *                  set ONCE, and what recordTtft() measures against sentAt
 *
 * Always replaced copy-on-write (touchTurn): BuildTab's effect that files the
 * measurement keys on `state.turn`, and an in-place write would never fire it.
 * The record itself is openTurn() in builderStream.ts.
 */

// The server remembers which approved plan its open questions belong to
// (questionsMeta.planId), so a reload keeps "this answer continues the build".
export function questionsPlanIdOf(snapshot: BuilderSnapshot): string | null {
    if (!Array.isArray(snapshot.reviewQuestions) || !snapshot.reviewQuestions.length) return null;
    const planId = (snapshot.questionsMeta as { planId?: unknown } | null | undefined)?.planId;
    return typeof planId === 'string' && planId ? planId : null;
}

export function touchTurn(s: AutomationBuilderState, patch: Partial<BuilderTurn>): AutomationBuilderState {
    return s.turn ? { ...s, turn: { ...s.turn, ...patch } } : s;
}

// The end of the silence is whichever of thinking_start / thinking / message /
// tool_call lands first; later ones must not move it.
export function markFirstEvent(s: AutomationBuilderState): AutomationBuilderState {
    if (!s.turn) return s;
    const patch: Partial<BuilderTurn> = {};
    if (!s.turn.firstEventAt) patch.firstEventAt = Date.now();
    // Any output from the model means it is past reading the prompt.
    if (s.turn.phase !== 'writing') patch.phase = 'writing';
    return Object.keys(patch).length ? touchTurn(s, patch) : s;
}

/**
 * Cheap structural equality for two automation definitions. We compare
 * via JSON.stringify after normalising key order in the shallow fields
 * we care about — definitions are small (a few dozen steps) so this is
 * fine, and it avoids a deepEqual import here.
 *
 * Returns true iff the two definitions describe the same DAG; used to
 * decide whether an SSE `draft` event is a no-op or a real conflict.
 */
export function shallowDefinitionEqual(a: unknown, b: unknown) {
    if (a === b) return true;
    if (!a || !b) return false;
    try {
        return JSON.stringify(a) === JSON.stringify(b);
    } catch {
        return false;
    }
}
