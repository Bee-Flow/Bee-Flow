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
 *   parallel     walks its branches side by side on forks of the walk state and joins them
 *                (sequenceWalkParallel.mts). Recorded once, when every branch ended.
 *
 * A walk can pause at a step inside any of these except a parallel branch. Each container keeps
 * a frame while it walks its list (sequenceWalkPause.mts) and, on a resumed walk, enters that
 * list again from the frame instead of from the start.
 *
 * A step inside `try.steps` keeps its own retry and onError: both are done by the leaf walk
 * before the failure ever reaches the try. A transaction is one leaf, so it is caught whole.
 */

import { createRequire } from 'node:module';
import { errorScopeOf } from './stepErrorFlow.mts';
import { walkParallel } from './sequenceWalkParallel.mts';
import { box, dropFrame, resumeFrame, resumesUnder, setFrame, unbox } from './sequenceWalkPause.mts';
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
    /** A resumed walk that cannot get back to its step: fails it and stops looking. */
    lost(fr: Frame, ev: StepEvent, startedAt: number): Promise<void>;
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

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A loop being walked: its rows (`offset`: the round its first row belongs to), and what to put back after it. */
type LoopRun = { source: unknown[]; offset: number; count: number; restore: { item: unknown; index: unknown; vars: Record<string, { has: boolean; value?: unknown }> } };

/** What itemVar and indexVar held before the loop (they are iteration-scoped). */
function loopNames(step: Step, vars: Obj): LoopRun['restore']['vars'] {
    const out: LoopRun['restore']['vars'] = {};
    for (const name of [step.itemVar, step.indexVar]) {
        if (typeof name !== 'string' || !name) continue;
        out[name] = Object.hasOwn(vars, name) ? { has: true, value: vars[name] } : { has: false };
    }
    return out;
}

/** Resolve the source and record the loop; null when it does not run (the step is recorded or failed). */
async function startLoop(api: FlowApi, fr: Frame, step: Step, ev: StepEvent, startedAt: number, at: { ctx: Obj; scope: unknown }): Promise<LoopRun | null> {
    const { w } = fr;
    const got = await api.resolveIn(fr, step.source, at.ctx, at.scope);
    if ('error' in got) { await api.fail(fr, ev, got, startedAt); return null; }
    const source = got.value;
    if (!Array.isArray(source)) {
        api.addNote(w, `${ev.path}: the loop source did not resolve to a list. Bind it to a records binding, or to a formula that returns a list (e.g. rows passed in scope.vars).`);
        await api.record(fr, ev, { status: 'skipped', error: 'source did not resolve to a list', result: { iterations: 0 } }, startedAt);
        return null;
    }
    const own = typeof step.maxIterations === 'number' && step.maxIterations > 0 ? step.maxIterations : MAX_LOOP_ITERATIONS;
    const cap = Math.min(own, MAX_LOOP_ITERATIONS);
    const count = Math.min(source.length, cap);
    if (source.length > count) api.addNote(w, `${ev.path}: looped ${count} of ${source.length} rows (cap ${cap}).`);
    await api.record(fr, ev, { status: 'ok', result: { iterations: count } }, startedAt);
    return { source, offset: 0, count, restore: { item: w.item, index: w.index, vars: loopNames(step, w.vars) } };
}

/** The loop a resumed walk is inside of, from its frame, and the round it paused in. */
function loopFromFrame(frame: Obj | null): { run: LoopRun; first: number } | null {
    if (!frame || !Array.isArray(frame.source) || typeof frame.n !== 'number' || typeof frame.count !== 'number') return null;
    const restore = isObject(frame.restore) ? frame.restore : {};
    const vars = (isObject(restore.vars) ? restore.vars : {}) as LoopRun['restore']['vars'];
    const offset = typeof frame.offset === 'number' ? frame.offset : 0;
    return { run: { source: frame.source, offset, count: frame.count, restore: { item: restore.item, index: restore.index, vars } }, first: frame.n };
}

/** The rounds of a loop from round `first` on. The round a resumed walk paused in keeps the item and variables of the restored state. */
async function loopRounds(api: FlowApi, fr: Frame, step: Step, ev: StepEvent, run: LoopRun, first: number): Promise<void> {
    const { w } = fr;
    const key = `${ev.path}#loop`;
    for (let n = first; n < run.count && !w.stopped && !w.signal; n += 1) {
        if (!w.resume) {
            const row = run.source[n - run.offset];
            w.item = row;
            w.index = n;
            const bound: Obj = {};
            if (typeof step.itemVar === 'string' && step.itemVar) bound[step.itemVar] = row;
            if (typeof step.indexVar === 'string' && step.indexVar) bound[step.indexVar] = n;
            w.vars = { ...w.vars, ...bound };
        }
        setFrame(w, key, { source: run.source, offset: run.offset, count: run.count, n, restore: run.restore });
        await api.walkList({ ...fr, loop: { index: n, count: run.count }, breakable: true }, step.steps, `${ev.path}.steps`);
        if (endRound(w)) break;
    }
    dropFrame(w, key);
}

/** The base `loop` kind: one round per row of its source, at most its cap; takes break and continue. `at` is null on a resumed walk. */
export async function walkLoop(api: FlowApi, fr: Frame, step: Step, ev: StepEvent, startedAt: number, at: { ctx: Obj; scope: unknown } | null): Promise<void> {
    const { w } = fr;
    const back = w.resume ? loopFromFrame(resumeFrame(w, `${ev.path}#loop`)) : null;
    if (w.resume && !back) return api.lost(fr, ev, startedAt);
    const run = back ? back.run : at ? await startLoop(api, fr, step, ev, startedAt, at) : null;
    if (!run) return;
    await loopRounds(api, fr, step, ev, run, back ? back.first : 0);
    // itemVar/indexVar are iteration-scoped, as in the browser; other writes carry on.
    const carried: Obj = { ...w.vars };
    for (const [name, was] of Object.entries(run.restore.vars)) {
        if (was.has) carried[name] = was.value; else delete carried[name];
    }
    w.vars = carried;
    w.item = run.restore.item;
    w.index = run.restore.index;
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
    const key = `${ev.path}#while`;
    const frame = resumeFrame(w, key);
    if (w.resume && typeof frame?.rounds !== 'number') return api.lost(fr, ev, startedAt);
    let rounds = typeof frame?.rounds === 'number' ? frame.rounds : 0;
    let capped = false;
    while (!w.stopped && !w.signal) {
        // The round a resumed walk paused in was already let in by the condition.
        if (!w.resume) {
            const ctx = host.ctxFor(w, ev);
            if (!host.evaluate(String(step.expr ?? ''), host.buildScope(ctx))) break;
            if (rounds >= cap) { capped = true; break; }
        }
        setFrame(w, key, { rounds });
        // count 0: an open loop, the number of rounds is not known up front.
        await api.walkList({ ...inner, loop: { index: rounds, count: 0 } }, step.steps, `${ev.path}.steps`);
        rounds += 1;
        if (endRound(w)) break;
    }
    dropFrame(w, key);
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

/** A try being walked: the slot it is in, the failure that was there before it, and what its frame keeps for a pause. */
type TryRun = { slot: 'steps' | 'catch' | 'finally'; before: WalkState['failed']; caught: boolean; error?: Obj; pending?: Obj };

const tryFrame = (t: TryRun): Obj => ({ slot: t.slot, before: t.before, caught: t.caught, ...(t.error ? { error: t.error } : {}), ...(t.pending ? { pending: t.pending } : {}) });

/** The `catch` list, with `w.error` already set; `t.error` is the error scope around the try, put back after. */
async function walkCatchList(api: FlowApi, fr: Frame, step: Step, ev: StepEvent, t: TryRun): Promise<void> {
    const { w } = fr;
    t.slot = 'catch';
    t.caught = true;
    setFrame(w, `${ev.path}#try`, tryFrame(t));
    try {
        await api.walkList(fr, step.catch, `${ev.path}.catch`);
    } finally {
        w.error = t.error;
    }
}

async function walkCatch(api: FlowApi, fr: Frame, step: Step, ev: StepEvent, failure: NonNullable<WalkState['failed']>, t: TryRun): Promise<void> {
    const { w } = fr;
    const outcome = w.outcomes.get(failure.path);
    if (outcome && outcome.status === 'error') outcome.handled = true;
    w.stopped = null;
    w.failed = t.before;
    t.error = w.error;
    w.error = errorScopeOf(failure.step ?? failure.kind, failure, outcome?.attempts ?? 1, failure.ordinal);
    return walkCatchList(api, fr, step, ev, t);
}

/**
 * Runs `finally` with whatever is pending set aside, and puts it back unless `finally` ended in
 * its own. On a walk resumed inside `finally`, what was pending comes from the frame.
 */
async function walkFinally(api: FlowApi, fr: Frame, step: Step, ev: StepEvent, t: TryRun): Promise<void> {
    const { w } = fr;
    const resumed = t.slot === 'finally';
    if (!resumed) {
        if (!Array.isArray(step.finally) || !step.finally.length || w.truncated) return;
        t.pending = { stopped: w.stopped, failed: w.failed, signal: w.signal ?? null, lastResult: box(w.lastResult) };
        t.slot = 'finally';
        w.stopped = null;
        w.signal = null;
    }
    const pending = t.pending ?? {};
    setFrame(w, `${ev.path}#try`, tryFrame(t));
    await api.walkList(fr, step.finally, `${ev.path}.finally`);
    if (w.stopped || w.signal) return;
    w.stopped = typeof pending.stopped === 'string' ? pending.stopped : null;
    w.failed = (pending.failed ?? null) as WalkState['failed'];
    w.signal = (pending.signal ?? null) as WalkState['signal'];
    // The result a return is carrying out is not replaced by a step of `finally`.
    if (pending.signal === 'return') w.lastResult = unbox(pending.lastResult);
}

/** The try a resumed walk is inside of: its frame, when the slot it names is the one the path goes through. */
function tryFromFrame(w: WalkState, path: string): TryRun | null {
    const frame = resumeFrame(w, `${path}#try`);
    const slot = frame?.slot;
    if (!frame || (slot !== 'steps' && slot !== 'catch' && slot !== 'finally')) return null;
    if (!resumesUnder(w, `${path}.${slot}[`)) return null;
    return {
        slot, before: (frame.before ?? null) as WalkState['failed'], caught: frame.caught === true,
        ...(isObject(frame.error) ? { error: frame.error } : {}), ...(isObject(frame.pending) ? { pending: frame.pending } : {}),
    };
}

const walkTry: FlowWalk = async (api, fr, step, ev, startedAt) => {
    const { w } = fr;
    const inner: Frame = { ...fr, depth: fr.depth + 1 };
    const back = w.resume ? tryFromFrame(w, ev.path) : null;
    if (w.resume && !back) return api.lost(fr, ev, startedAt);
    const t: TryRun = back ?? { slot: 'steps', before: w.failed, caught: false };
    if (t.slot === 'steps') {
        setFrame(w, `${ev.path}#try`, tryFrame(t));
        await api.walkList(inner, step.steps, `${ev.path}.steps`);
        const failure = caughtFailure(w, t.before);
        if (failure && Array.isArray(step.catch)) await walkCatch(api, inner, step, ev, failure, t);
    } else if (t.slot === 'catch') {
        await walkCatchList(api, inner, step, ev, t);
    }
    await walkFinally(api, inner, step, ev, t);
    dropFrame(w, `${ev.path}#try`);
    return api.record(fr, ev, { status: 'ok', result: { caught: t.caught } }, startedAt);
};

const FLOW_WALKS: Readonly<Record<string, FlowWalk>> = Object.freeze({
    return: walkReturn, break: walkLoopExit, continue: walkLoopExit, while: walkWhile, raise_error: walkRaise, try: walkTry,
    parallel: walkParallel,
});

/** The registry control kinds this walker runs itself. */
export const FLOW_KINDS: readonly string[] = Object.freeze(Object.keys(FLOW_WALKS));

/** Walks one step of a FLOW_KINDS kind. */
export function walkFlowStep(api: FlowApi, fr: Frame, step: Step, ev: StepEvent, startedAt: number): Promise<void> {
    return FLOW_WALKS[String(step.kind)](api, fr, step, ev, startedAt);
}
