/**
 * Loops and the control-flow step kinds of the step registry, in the browser:
 * the base `loop`, and return, break, continue, while, raise_error and try. The
 * server walker does the same in server/appStudio/sequenceWalkFlow.mts.
 *
 * Leaving early is a thrown SIGNAL (RETURN, BREAK, CONTINUE), not a failure:
 * the coordinator passes it through its step loop untouched, a loop or while
 * takes BREAK and CONTINUE (loopSignalOf), and the action boundary takes
 * RETURN (runActionSteps: the clicked action, and every called action).
 *
 *   return       sets the action's result when it has a `value`, then RETURN
 *   break        BREAK inside a loop or while of the same action, else it fails
 *   continue     the same with CONTINUE
 *   while        checks `expr` before every round, at most maxIterations rounds
 *                (MAX_LOOP_ITERATIONS). Reaching the cap just ends it.
 *   raise_error  fails with the author's message and code (`raised` when none)
 *   try          runs `steps`. A failure there with a `catch` list: `catch`
 *                runs with `error` in scope and the sequence goes on. `finally`
 *                then runs whatever happened (a failure, a signal, a declined
 *                confirm), and what was pending goes on unless `finally` ended
 *                in something of its own. Nothing runs once the page is gone.
 *   parallel     runs its branches side by side on copies of the state and
 *                joins them (./parallelStep).
 *
 * A step inside `try.steps` keeps its own retry and onError: the coordinator
 * does both before the failure reaches the try.
 */
import { tryEvaluate } from '@shared/expr/engine.mjs';
import { clampErrorScope } from '@shared/appDefinition/stepFlow.mjs';
import { resolveBinding } from '../resolveBinding';
import type { ClientStepEnv } from './clientSteps';
import { CANCELLED, MAX_LOOP_ITERATIONS, SEQ_ABORT, failureMessage, mergeAppEffects } from './core';
import type { RunStep } from './core';
import { runParallel } from './parallelStep';
import type { ParallelEnv } from './parallelStep';
import { StepFailure } from './serverSteps';
import type { ErrorScope, SeqState } from './serverSteps';

/** The part of the sequence env the control kinds read. */
export interface FlowEnv extends ClientStepEnv, ParallelEnv {
    indexMap: Map<RunStep, number>;
    /** Inside the steps of a loop or while of the same action: where break and continue work. */
    breakable?: boolean;
}

type ExecSteps<E extends FlowEnv> = (env: E, list: unknown, st: SeqState) => Promise<void>;

/** A return step: unwinds to the action boundary. */
const RETURN = Symbol('actionRunner.return');
const BREAK = Symbol('actionRunner.break');
const CONTINUE = Symbol('actionRunner.continue');

/** Is `e` a return, break or continue on its way out (never a failure)? */
export function isFlowSignal(e: unknown): boolean {
    return e === RETURN || e === BREAK || e === CONTINUE;
}

/** What a loop or while does with something thrown out of one round: `break`, `continue`, or null (not for the loop). */
function loopSignalOf(e: unknown): 'break' | 'continue' | null {
    if (e === BREAK) return 'break';
    return e === CONTINUE ? 'continue' : null;
}

/** `env` for the steps of a loop or while. */
function loopBodyEnv<E extends FlowEnv>(env: E): E {
    return env.breakable ? env : { ...env, breakable: true };
}

/**
 * Runs the top-level steps of one action (the clicked one, or a called one). A
 * return ends them as a success: true when one did.
 */
export async function runActionSteps<E extends FlowEnv>(exec: ExecSteps<E>, env: E, steps: unknown, st: SeqState): Promise<boolean> {
    try {
        await exec(env, steps, st);
        return false;
    } catch (e) {
        if (e !== RETURN) throw e;
        return true;
    }
}

// ── Which step a failure came from (what a catch reads as error.step / error.stepIndex) ──

interface FailureOrigin { kind: string; index: number | undefined; map: Map<RunStep, number> }
const origins = new WeakMap<object, FailureOrigin>();

/**
 * Remembers where `e` failed, as it travels up: the innermost step of an action
 * names the kind; in a calling action the position becomes the call_action's
 * (the kind stays the step that really failed), as on the server.
 */
export function noteFailure(e: unknown, step: RunStep, indexMap: Map<RunStep, number>): void {
    if (!e || typeof e !== 'object') return;
    const prev = origins.get(e);
    if (prev && prev.map === indexMap) return;
    const kind = prev?.kind ?? ((e instanceof StepFailure && e.stepKind) || String(step.kind));
    origins.set(e, { kind, index: indexMap.get(step), map: indexMap });
}

function caughtScope(env: FlowEnv, e: unknown): ErrorScope {
    const origin = e && typeof e === 'object' ? origins.get(e) : undefined;
    const failure = e instanceof StepFailure ? e : null;
    return clampErrorScope({
        message: failureMessage(e, env.ctx.tr),
        step: origin?.kind ?? failure?.stepKind ?? '',
        code: failure?.code ?? null,
        attempts: failure?.attempts ?? 1,
        stepIndex: origin?.index,
    }) as ErrorScope;
}

// ── The kinds ───────────────────────────────────────────────────────────────

const MAX_MESSAGE_CHARS = 500;
const MAX_CODE_CHARS = 60;

function runReturn(env: FlowEnv, step: RunStep, st: SeqState): never {
    if (step.value !== undefined && step.value !== null) {
        st.lastResult = resolveBinding(step.value, env.liveBag(st) as Parameters<typeof resolveBinding>[1]).value ?? null;
    }
    throw RETURN;
}

function runLoopExit(env: FlowEnv, step: RunStep): never {
    if (!env.breakable) {
        const failure = new StepFailure(env.ctx.tr('studio_apps_flow_control.runtime.not_in_loop', 'A {kind} step only works inside a loop or while.', { kind: String(step.kind) }));
        failure.code = 'not_in_loop';
        failure.stepKind = String(step.kind);
        throw failure;
    }
    throw step.kind === 'break' ? BREAK : CONTINUE;
}

function runRaise(env: FlowEnv, step: RunStep, st: SeqState): never {
    const { value } = resolveBinding(step.message as Parameters<typeof resolveBinding>[0], env.liveBag(st) as Parameters<typeof resolveBinding>[1]);
    const text = value === null || value === undefined ? '' : String(value).slice(0, MAX_MESSAGE_CHARS);
    const failure = new StepFailure(text || env.ctx.tr('studio_apps_flow_control.runtime.raised', 'The action raised an error.'));
    failure.code = typeof step.code === 'string' && step.code ? step.code.slice(0, MAX_CODE_CHARS) : 'raised';
    failure.stepKind = 'raise_error';
    throw failure;
}

async function runWhile<E extends FlowEnv>(env: E, step: RunStep, st: SeqState, exec: ExecSteps<E>): Promise<void> {
    const own = typeof step.maxIterations === 'number' && step.maxIterations > 0 ? Math.floor(step.maxIterations) : MAX_LOOP_ITERATIONS;
    const cap = Math.min(own, MAX_LOOP_ITERATIONS);
    const inner = loopBodyEnv(env);
    for (let round = 0; round < cap; round++) {
        if (!env.ctx.alive.current) throw CANCELLED;
        if (!tryEvaluate(step.expr, env.liveBag(st).scope).value) return;
        try {
            await exec(inner, step.steps, st);
        } catch (e) {
            const signal = loopSignalOf(e);
            if (signal === 'break') return;
            if (signal !== 'continue') throw e;
        }
    }
}

/** What one round of a loop hands back to the state around it. */
function carryRound(st: SeqState, iter: SeqState, step: RunStep, outerVars: Record<string, unknown>): void {
    // itemVar/indexVar are ITERATION-scoped: whatever the name
    // held outside the loop is restored, so later steps never
    // see it pinned to the last row. Other writes carry on.
    const carried = { ...iter.vars };
    for (const name of [step.itemVar, step.indexVar]) {
        if (typeof name !== 'string' || !name) continue;
        if (Object.prototype.hasOwnProperty.call(outerVars, name)) carried[name] = outerVars[name];
        else delete carried[name];
    }
    st.vars = carried;
    st.lastResult = iter.lastResult;
    // Same reason lastResult is carried back: an iteration
    // is a copy of the state, so an automation's return picked
    // up inside the body would otherwise be dropped.
    if (iter.appEffects) st.appEffects = mergeAppEffects(st.appEffects, iter.appEffects);
    if (iter.effectsUnknown) st.effectsUnknown = true;
}

const ROUND_DONE = Symbol('actionRunner.roundDone');

/** The base `loop` kind: one round per row of its source; takes break and continue. */
export async function runLoop<E extends FlowEnv>(env: E, step: RunStep, st: SeqState, exec: ExecSteps<E>): Promise<void> {
    const { value: src } = resolveBinding(step.source, env.liveBag(st) as Parameters<typeof resolveBinding>[1]);
    const arr: unknown[] = Array.isArray(src) ? src : [];
    const cap = Number.isInteger(step.maxIterations)
        ? Math.min(step.maxIterations as number, MAX_LOOP_ITERATIONS) : MAX_LOOP_ITERATIONS;
    const inner = loopBodyEnv(env);
    for (let i = 0; i < arr.length && i < cap; i++) {
        const outerVars = st.vars || {};
        const iter: SeqState = {
            ...st,
            item: arr[i],
            index: i,
            vars: {
                ...outerVars,
                ...(step.itemVar ? { [step.itemVar as string]: arr[i] } : {}),
                ...(step.indexVar ? { [step.indexVar as string]: i } : {}),
            },
        };
        let left: unknown = ROUND_DONE;
        try {
            await exec(inner, step.steps, iter);
        } catch (e) {
            // Only a return, break or continue hands the round's writes back. A failure, a
            // cancelled run and a quiet abort leave the state around the loop as it was, as
            // they always did (what a handler further out reads does not change).
            if (!isFlowSignal(e)) throw e;
            left = e;
        }
        carryRound(st, iter, step, outerVars);
        if (left === ROUND_DONE) continue;
        const signal = loopSignalOf(left);
        if (signal === 'break') return;
        if (signal !== 'continue') throw left;
    }
}

const NOTHING = Symbol('actionRunner.nothingPending');

/** Runs `catch` for the failure `e`. Returns what is pending afterwards (NOTHING when the catch dealt with it). */
async function runCatch<E extends FlowEnv>(env: E, step: RunStep, st: SeqState, e: unknown, exec: ExecSteps<E>): Promise<unknown> {
    const saved = st.errorScope;
    st.errorScope = caughtScope(env, e);
    st.error = null;
    if (st.run) st.run.handled = true;
    try {
        await exec(env, step.catch, st);
        return NOTHING;
    } catch (inner) {
        return inner;
    } finally {
        st.errorScope = saved;
    }
}

async function runTry<E extends FlowEnv>(env: E, step: RunStep, st: SeqState, exec: ExecSteps<E>): Promise<void> {
    let pending: unknown = NOTHING;
    try {
        await exec(env, step.steps, st);
    } catch (e) {
        const failed = e !== CANCELLED && e !== SEQ_ABORT && !isFlowSignal(e);
        pending = failed && Array.isArray(step.catch) ? await runCatch(env, step, st, e, exec) : e;
    }
    if (pending === CANCELLED || !env.ctx.alive.current) throw CANCELLED;
    if (Array.isArray(step.finally) && step.finally.length) {
        // The result a return is carrying out is not replaced by a step of `finally`.
        const result = st.lastResult;
        await exec(env, step.finally, st);
        if (pending === RETURN) st.lastResult = result;
    }
    if (pending !== NOTHING) throw pending;
}

/**
 * Runs a control kind of the step registry with `exec` walking its child
 * steps. False when `step` is not one of them.
 */
export async function runFlowStep<E extends FlowEnv>(env: E, step: RunStep, st: SeqState, exec: ExecSteps<E>): Promise<boolean> {
    switch (step.kind) {
        case 'return': return runReturn(env, step, st);
        case 'break':
        case 'continue': return runLoopExit(env, step);
        case 'raise_error': return runRaise(env, step, st);
        case 'while': await runWhile(env, step, st, exec); return true;
        case 'try': await runTry(env, step, st, exec); return true;
        case 'parallel': await runParallel(env, step, st, exec); return true;
        default: return false;
    }
}
