/**
 * Loops and the control-flow step kinds of the step registry, for the server walker
 * (sequenceWalk.mts): the base `loop`, and return, break, continue, while, raise_error and try.
 * The browser coordinator does the same in agent-hub runtime/actionRunner/controlFlow.ts.
 *
 * Leaving early is a SIGNAL on the walk state (`w.signal`), not a stop: walkList ends its list
 * while one is set, a loop or while takes `break` and `continue`, and the action boundary
 * (walkAction, a call_action) takes `return`. A failure stays what it was (`w.failed` plus
 * `w.stopped`); `try` is the one place that takes it back.
 *
 *   return       sets the action's result when it has a `value`, then signals `return`
 *   break        signals; refused outside a loop or while (the validator refuses it first)
 *   continue     the same
 *   while        evaluates `expr` before every round, at most maxIterations rounds
 *                (LIMITS.MAX_ACTION_LOOP_ITERATIONS). Reaching the cap is a note, not a failure.
 *                Recorded once, when it ends, with `{ iterations }`.
 *   raise_error  fails with the author's message and code (`raised` when none)
 *   try          walks `steps`. A failure there (not a budget stop, not a handler's quiet stop)
 *                with a `catch` list: the failure is taken back, `catch` runs with `w.error`
 *                set, the walk goes on. `finally` then runs whatever happened (a failure, a
 *                signal), except after a budget stop, and what was pending is put back unless
 *                `finally` itself failed or signalled. Recorded once, when it ends.
 *
 * A step inside `try.steps` keeps its own retry and onError: both are done by the leaf walk
 * before the failure ever reaches the try. A transaction is one leaf, so it is caught whole.
 */

import { createRequire } from 'node:module';
import { errorScopeOf } from './stepErrorFlow.mts';
import type { Ended, Frame } from './sequenceWalk.mts';
import type { Obj, Step, StepEvent, WalkState } from './sequenceWalkTypes.mts';

const nodeRequire = createRequire(import.meta.url);
const { LIMITS } = nodeRequire('./componentSpecs/limits.js') as { LIMITS: { MAX_ACTION_LOOP_ITERATIONS: number } };

const MAX_LOOP_ITERATIONS = LIMITS.MAX_ACTION_LOOP_ITERATIONS;
const MAX_MESSAGE_CHARS = 500;
const MAX_CODE_CHARS = 60;

/** What the walker lends this module (its own functions, so there is one of each). */
export type FlowApi = {
    walkList(fr: Frame, list: unknown, base: string): Promise<void>;
    record(fr: Frame, ev: StepEvent, end: Ended, startedAt: number): Promise<void>;
    fail(fr: Frame, ev: StepEvent, res: { error?: string; code?: string }, startedAt: number): Promise<void>;
    resolveIn(fr: Frame, binding: unknown, ctx: Obj, scope: unknown): Promise<{ value: unknown } | { error: string; code?: string }>;
    addNote(w: WalkState, text: string): void;
};

type FlowWalk = (api: FlowApi, fr: Frame, step: Step, ev: StepEvent, startedAt: number) => Promise<void>;

/**
 * After one round of a loop or while: takes a `break` or `continue` off the state.
 * True when the loop must end (a break, or a return on its way out).
 */
export function endRound(w: WalkState): boolean {
    if (w.signal === 'continue') { w.signal = null; return false; }
    if (w.signal === 'break') { w.signal = null; return true; }
    return !!w.signal;
}

/** The base `loop` kind: one round per row of its source, at most its cap; takes break and continue. */
export async function walkLoop(api: FlowApi, fr: Frame, step: Step, ev: StepEvent, startedAt: number, at: { ctx: Obj; scope: unknown }): Promise<void> {
    const { w } = fr;
    const got = await api.resolveIn(fr, step.source, at.ctx, at.scope);
    if ('error' in got) return api.fail(fr, ev, got, startedAt);
    const source = got.value;
    if (!Array.isArray(source)) {
        api.addNote(w, `${ev.path}: the loop source did not resolve to a list. Bind it to a records binding, or to a formula that returns a list (e.g. rows passed in scope.vars).`);
        return api.record(fr, ev, { status: 'skipped', error: 'source did not resolve to a list', result: { iterations: 0 } }, startedAt);
    }
    const own = typeof step.maxIterations === 'number' && step.maxIterations > 0 ? step.maxIterations : MAX_LOOP_ITERATIONS;
    const cap = Math.min(own, MAX_LOOP_ITERATIONS);
    const count = Math.min(source.length, cap);
    if (source.length > count) api.addNote(w, `${ev.path}: looped ${count} of ${source.length} rows (cap ${cap}).`);
    await api.record(fr, ev, { status: 'ok', result: { iterations: count } }, startedAt);
    const saved = { vars: w.vars, item: w.item, index: w.index };
    for (let n = 0; n < count && !w.stopped && !w.signal; n += 1) {
        w.item = source[n];
        w.index = n;
        const bound: Obj = {};
        if (typeof step.itemVar === 'string' && step.itemVar) bound[step.itemVar] = source[n];
        if (typeof step.indexVar === 'string' && step.indexVar) bound[step.indexVar] = n;
        w.vars = { ...w.vars, ...bound };
        await api.walkList({ ...fr, loop: { index: n, count }, breakable: true }, step.steps, `${ev.path}.steps`);
        if (endRound(w)) break;
    }
    // itemVar/indexVar are iteration-scoped, as in the browser; other writes carry on.
    const carried: Obj = { ...w.vars };
    for (const name of [step.itemVar, step.indexVar]) {
        if (typeof name !== 'string' || !name) continue;
        if (Object.hasOwn(saved.vars, name)) carried[name] = saved.vars[name]; else delete carried[name];
    }
    w.vars = carried;
    w.item = saved.item;
    w.index = saved.index;
}

const walkReturn: FlowWalk = async (api, fr, step, ev, startedAt) => {
    const { w, host } = fr;
    let result: Obj = {};
    if (step.value !== undefined && step.value !== null) {
        const ctx = host.ctxFor(w, ev);
        const got = await api.resolveIn(fr, step.value, ctx, host.buildScope(ctx));
        if ('error' in got) return api.fail(fr, ev, got, startedAt);
        w.lastResult = got.value ?? null;
        result = { value: w.lastResult };
    }
    w.signal = 'return';
    return api.record(fr, ev, { status: 'ok', result }, startedAt);
};

const walkLoopExit: FlowWalk = async (api, fr, step, ev, startedAt) => {
    const kind = step.kind === 'break' ? 'break' : 'continue';
    if (!fr.breakable) return api.fail(fr, ev, { error: `A ${kind} step only works inside a loop or while`, code: 'not_in_loop' }, startedAt);
    fr.w.signal = kind;
    return api.record(fr, ev, { status: 'ok' }, startedAt);
};

const walkWhile: FlowWalk = async (api, fr, step, ev, startedAt) => {
    const { w, host } = fr;
    const own = typeof step.maxIterations === 'number' && step.maxIterations > 0 ? step.maxIterations : MAX_LOOP_ITERATIONS;
    const cap = Math.min(Math.floor(own), MAX_LOOP_ITERATIONS);
    const inner: Frame = { ...fr, depth: fr.depth + 1, breakable: true };
    let rounds = 0;
    let capped = false;
    while (!w.stopped && !w.signal) {
        const ctx = host.ctxFor(w, ev);
        if (!host.evaluate(String(step.expr ?? ''), host.buildScope(ctx))) break;
        if (rounds >= cap) { capped = true; break; }
        // count 0: an open loop, the number of rounds is not known up front.
        await api.walkList({ ...inner, loop: { index: rounds, count: 0 } }, step.steps, `${ev.path}.steps`);
        rounds += 1;
        if (endRound(w)) break;
    }
    if (capped) api.addNote(w, `${ev.path}: the while ended after ${cap} rounds with its condition still true (maxIterations).`);
    return api.record(fr, ev, { status: 'ok', result: { iterations: rounds, ...(capped ? { capped: true } : {}) } }, startedAt);
};

const walkRaise: FlowWalk = async (api, fr, step, ev, startedAt) => {
    const { w, host } = fr;
    const ctx = host.ctxFor(w, ev);
    const got = await api.resolveIn(fr, step.message, ctx, host.buildScope(ctx));
    if ('error' in got) return api.fail(fr, ev, got, startedAt);
    const text = got.value === null || got.value === undefined ? '' : String(got.value);
    const code = typeof step.code === 'string' && step.code ? step.code.slice(0, MAX_CODE_CHARS) : 'raised';
    return api.fail(fr, ev, { error: text.slice(0, MAX_MESSAGE_CHARS) || 'The action raised an error', code }, startedAt);
};

/** The failure `try.steps` ended in, when it is one a catch takes: a failed step, not a budget stop. */
function caughtFailure(w: WalkState, before: WalkState['failed']): NonNullable<WalkState['failed']> | null {
    if (!w.stopped || w.truncated || !w.failed || w.failed === before) return null;
    return w.failed;
}

async function walkCatch(api: FlowApi, fr: Frame, step: Step, ev: StepEvent, failure: NonNullable<WalkState['failed']>, before: WalkState['failed']): Promise<void> {
    const { w } = fr;
    const outcome = w.outcomes.get(failure.path);
    if (outcome && outcome.status === 'error') outcome.handled = true;
    w.stopped = null;
    w.failed = before;
    const saved = w.error;
    w.error = errorScopeOf(failure.step ?? failure.kind, failure, outcome?.attempts ?? 1, failure.ordinal);
    try {
        await api.walkList(fr, step.catch, `${ev.path}.catch`);
    } finally {
        w.error = saved;
    }
}

/** Runs `finally` with whatever is pending set aside, and puts it back unless `finally` ended in its own. */
async function walkFinally(api: FlowApi, fr: Frame, step: Step, ev: StepEvent): Promise<void> {
    const { w } = fr;
    if (!Array.isArray(step.finally) || !step.finally.length || w.truncated) return;
    const pending = { stopped: w.stopped, failed: w.failed, signal: w.signal, lastResult: w.lastResult };
    w.stopped = null;
    w.signal = null;
    await api.walkList(fr, step.finally, `${ev.path}.finally`);
    if (w.stopped || w.signal) return;
    w.stopped = pending.stopped;
    w.failed = pending.failed;
    w.signal = pending.signal;
    // The result a return is carrying out is not replaced by a step of `finally`.
    if (pending.signal === 'return') w.lastResult = pending.lastResult;
}

const walkTry: FlowWalk = async (api, fr, step, ev, startedAt) => {
    const { w } = fr;
    const inner: Frame = { ...fr, depth: fr.depth + 1 };
    const before = w.failed;
    await api.walkList(inner, step.steps, `${ev.path}.steps`);
    const failure = caughtFailure(w, before);
    const caught = !!failure && Array.isArray(step.catch);
    if (failure && caught) await walkCatch(api, inner, step, ev, failure, before);
    await walkFinally(api, inner, step, ev);
    return api.record(fr, ev, { status: 'ok', result: { caught } }, startedAt);
};

const FLOW_WALKS: Readonly<Record<string, FlowWalk>> = Object.freeze({
    return: walkReturn, break: walkLoopExit, continue: walkLoopExit, while: walkWhile, raise_error: walkRaise, try: walkTry,
});

/** The registry control kinds this walker runs itself. */
export const FLOW_KINDS: readonly string[] = Object.freeze(Object.keys(FLOW_WALKS));

/** Walks one step of a FLOW_KINDS kind. */
export function walkFlowStep(api: FlowApi, fr: Frame, step: Step, ev: StepEvent, startedAt: number): Promise<void> {
    return FLOW_WALKS[String(step.kind)](api, fr, step, ev, startedAt);
}
