/**
 * Undo/redo for a JSON draft, as a pure reducer — the semantics of the web's
 * hooks/useDraftHistory.ts, pinned by history.test.ts and
 * history.lockstep.test.ts (which reads the web's constants).
 *
 *   - `commit(current, next)` snapshots `current` into `past` and clears
 *     `future`; the caller then applies `next`.
 *   - Commits within COALESCE_MS of the previous one share ONE entry, so
 *     typing a word is one undo, not one per letter.
 *   - `past` is capped at CAP entries; the oldest roll off.
 *   - A commit of a structurally identical draft is a no-op.
 *   - A nullish baseline ("no draft yet") is never pushed: undoing to it
 *     would apply `null` as a definition.
 *   - Undo and redo reset the coalescing window, so the next edit starts a
 *     fresh entry.
 *
 * The store (../state) holds a HistoryState and calls these with the live
 * draft and `Date.now()`; each returns the next state and, for undo/redo,
 * the draft to apply.
 */

export const COALESCE_MS = 600;
export const CAP = 50;

export interface HistoryState<T> {
    past: T[];
    future: T[];
    lastCommitAt: number;
}

export function emptyHistory<T>(): HistoryState<T> {
    return { past: [], future: [], lastCommitAt: 0 };
}

function safeClone<T>(v: T): T {
    if (v == null) return v;
    try {
        return JSON.parse(JSON.stringify(v));
    } catch {
        return v;
    }
}

/**
 * Each draft object's JSON, written once. Drafts are immutable (every edit is
 * a new object), and the store compares the same ones over and over — the
 * definition before and after an edit, each against the baseline — so a
 * keystroke in the step editor stringifies ONE definition, not four.
 */
const jsonOf = new WeakMap<object, string>();

function json(v: unknown): string {
    if (typeof v !== 'object' || v === null) return JSON.stringify(v);
    const held = jsonOf.get(v);
    if (held !== undefined) return held;
    const text = JSON.stringify(v);
    jsonOf.set(v, text);
    return text;
}

/** Structural equality through JSON — the web's rule. */
export function sameDraft(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a == null || b == null) return a === b;
    try {
        return json(a) === json(b);
    } catch {
        return false;
    }
}

export interface CommitResult<T> {
    state: HistoryState<T>;
    /** False when `next` equals `current`: nothing to apply, nothing recorded. */
    changed: boolean;
}

/** Record an edit from `current` to `next`, at time `now` (ms). */
export function commitDraft<T>(state: HistoryState<T>, current: T, next: T, now: number): CommitResult<T> {
    if (sameDraft(current, next)) return { state, changed: false };
    const coalesced = now - state.lastCommitAt < COALESCE_MS;
    if ((coalesced && state.past.length > 0) || current == null) {
        return { state: { past: state.past, future: [], lastCommitAt: now }, changed: true };
    }
    const past = state.past.length >= CAP ? state.past.slice(state.past.length - CAP + 1) : state.past.slice();
    past.push(safeClone(current));
    return { state: { past, future: [], lastCommitAt: now }, changed: true };
}

export interface StepResult<T> {
    state: HistoryState<T>;
    /** The draft to apply, or undefined when there was nothing to step to. */
    apply: T | undefined;
}

/** Step back: `current` goes onto `future`, the top of `past` comes back. */
export function undoDraft<T>(state: HistoryState<T>, current: T): StepResult<T> {
    if (state.past.length === 0) return { state, apply: undefined };
    const apply = state.past[state.past.length - 1] as T;
    return {
        state: { past: state.past.slice(0, -1), future: [...state.future, safeClone(current)], lastCommitAt: 0 },
        apply,
    };
}

/** Step forward again: the mirror of undo. */
export function redoDraft<T>(state: HistoryState<T>, current: T): StepResult<T> {
    if (state.future.length === 0) return { state, apply: undefined };
    const apply = state.future[state.future.length - 1] as T;
    return {
        state: { past: [...state.past, safeClone(current)], future: state.future.slice(0, -1), lastCommitAt: 0 },
        apply,
    };
}

export const canUndo = (state: HistoryState<unknown>): boolean => state.past.length > 0;
export const canRedo = (state: HistoryState<unknown>): boolean => state.future.length > 0;
