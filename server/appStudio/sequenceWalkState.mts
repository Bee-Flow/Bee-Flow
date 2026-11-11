/**
 * The state of one walk (sequenceWalk.mts): a fresh one, one put back after a pause, and the
 * walk as data when it ended. sequenceWalk.mts re-exports these, so its importers keep one
 * import path.
 */

import { restoreInto } from './sequenceWalkPause.mts';
import type { Obj, Outcome, OutcomeView, ResumeOutcome, WalkState } from './sequenceWalkTypes.mts';

/** A fresh state for one walk. */
export function newWalkState(init: { vars?: Obj; form?: Obj; item?: unknown; index?: unknown; value?: unknown; params?: Obj; trigger?: Obj } = {}): WalkState {
    return {
        ...(init.trigger ? { trigger: init.trigger } : {}),
        vars: { ...(init.vars ?? {}) }, form: { ...(init.form ?? {}) }, item: init.item, index: init.index, value: init.value,
        params: { ...(init.params ?? {}) },
        lastResult: null, executed: 0, stopped: null, truncated: false, failed: null,
        callChain: [], deferred: [], outcomes: new Map(), known: new Map(), notes: new Set(), frames: new Map(),
    };
}

/**
 * The state of a walk that paused (`state`: PausedWalk.state), ready to be walked on: walkAction
 * goes back to the paused step and ends it with `outcome`. Null when `state` is not a snapshot.
 */
export function resumedWalkState(state: unknown, outcome: ResumeOutcome): WalkState | null {
    const w = newWalkState();
    return restoreInto(w, state, outcome) ? w : null;
}

/** The walk as data: ok/stopped, the vars, the last server result, and an outcome for EVERY known path. */
export function outcomeView(w: WalkState): OutcomeView {
    const steps = new Map<string, Outcome>();
    for (const [path, kind] of w.known) {
        steps.set(path, w.outcomes.get(path) ?? { path, kind, ordinal: null, status: 'not_run', ms: 0, count: 0 });
    }
    for (const [path, o] of w.outcomes) if (!steps.has(path)) steps.set(path, o);
    return {
        ok: !w.failed && !(w.stopped && w.truncated),
        stopped: w.stopped, failed: w.failed, vars: w.vars, result: w.lastResult, steps,
    };
}
