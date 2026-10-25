import { formatElapsed } from './runFocus';
import type { BuildTodo } from './useBuildChoreography.types';

// How long the ending lingers ("Built · 8 steps · 1m 42s") and how long a
// refusal stays readable: the time it takes someone four metres from the
// screen to find the line and read it.
export const FAREWELL_MS = 4000;

export const SKIPPED_MS = 4000;

// A refusal reason is written for the model, not for the banner; past this
// length it stops being a line and becomes a paragraph.
const REASON_MAX = 72;

// The plan strip quotes the next to-do; a to-do is a sentence the model wrote
// for itself, and past this it would push the engine line off the bar.
const TODO_MAX = 48;

// `buildCue.startedAt` is an epoch number (captured the instant the stream
// started); formatElapsed parses ISO strings, and Date.parse(number) is NaN.
export function elapsedSince(startedAt: string | number | Date | null | undefined, now: number) {
    return startedAt ? formatElapsed(new Date(startedAt).toISOString(), now) : null;
}

export function shortReason(reason: string | null | undefined) {
    const s = String(reason || '').replace(/\s+/g, ' ').trim();
    return s.length > REASON_MAX ? `${s.slice(0, REASON_MAX - 1).trimEnd()}…` : s;
}

/**
 * "Plan 2/5 · Fetch the invoices": how far through its own to-do list the
 * model is, and what it is on. The quoted to-do drops out when the verb
 * already says the same words — the two would read as a stutter.
 */
export function planStrip(todos: BuildTodo[], verb: string | null) {
    const total = todos.length;
    if (!total) return null;
    const done = todos.filter(x => x?.done).length;
    const next = todos.find(x => x && !x.done);
    const text = String(next?.text || '').replace(/\s+/g, ' ').trim();
    const head = text.length > TODO_MAX ? text.slice(0, TODO_MAX - 1).trimEnd() : text;
    const shown = head && head.length < text.length ? `${head}…` : head;
    const duplicate = !!(head && verb && String(verb).includes(head));
    return { done, total, next: shown && !duplicate ? shown : null };
}
