/**
 * The ONE server-side walker of an action sequence.
 *
 * app_run_action and app_run_tests walk through it today; later hosts (call_action,
 * onError/retry, background jobs, the mailbox hook, run logging) add a WalkHost, never a
 * second walker. The walker owns the control flow (condition, switch, loop, set_variable),
 * the walker paths and the outcome per path; the HOST owns every decision with a policy in
 * it (what may run, what it costs, how a step reaches the executor).
 *
 * Leaf order: onStepStart → decide → mock (mockFor/mocked) or execute, per attempt of the
 * step's `retry` (stepErrorFlow.attemptStep; every attempt counts in `executed`) → onStepEnd →
 * on failure: the step's onError handler or stop → resultVar, lastResult.
 *
 * Error handlers (`onError: { steps, stop? }`, stepFlow.errorHandlerOf): a failed leaf or
 * call_action with a handler records `status: 'error', handled: true`, walks
 * `<path>.onError.steps` with `w.error` set ({ message, step, code, attempts, stepIndex? }),
 * restores it, and the walk CONTINUES (`stop: true` ends it quietly: `stopped` is set,
 * `failed` is not). A failure inside a handler without its own handler stops the run as usual.
 *
 * Path grammar (fixed; reports, saved-test mocks and expectations read it):
 *   `steps[i]` at the top of a sequence, `action[0]` for a bare v1 action;
 *   `.then[i]`, `.else[i]`; `.cases[k].steps[i]`, `.default[i]`; a loop body `.steps[i]`
 *   (no iteration index in the path: the event carries `iteration` and `loop.count`);
 *   a called action's steps `.call.steps[i]` under its call_action step (the callee always
 *   normalised as a sequence, so a bare callee is `.call.steps[0]`; events carry the callee's
 *   id as `ownerActionId`, ordinals are the callee's own).
 * The suffixes come from shared/appDefinition/stepFlow.mjs (childStepSlots).
 *
 * call_action is walker-native (sequenceWalkCall.mts): the callee comes from host.resolveCallee
 * (own property of def.actions), runs with `params` (and the caller's vars/form; item/index/value
 * are not inherited), its vars writes carry back, its last server result is the call's result.
 * Missing callee, a cycle or more than LIMITS.MAX_CALL_DEPTH calls stop the run.
 *
 * A leaf whose result asks to pause stops the walk there, and a later walk goes back to it
 * (sequenceWalkPause.mts): every list on the way starts at the index the path names and every
 * container enters its child list again from the frame it kept.
 *
 * Ordinals are flattenSteps(normalizeSequence(action)) positions, mapped by object identity,
 * so a walker path and a browser stepIndex always name the same step.
 *
 * The control kinds of the step registry (return, break, continue, while, raise_error, try,
 * parallel) are walked by sequenceWalkFlow.mts; its header says how leaving early (`w.signal`)
 * and try/catch/finally work, sequenceWalkParallel.mts how the branches of a parallel step run
 * on forks of the walk state. Their paths: a while body `.steps[i]`, a try `.steps[i]`,
 * `.catch[i]`, `.finally[i]`, a parallel branch `.branches[k].steps[i]`. A registry control kind this walker does not know fails its
 * step: it never falls through to the host as if it were a browser step.
 */

import { createRequire } from 'node:module';
import { childStepSlots, errorHandlerOf } from '../shared/appDefinition/stepFlow.mjs';
import { parallelRefusal } from '../shared/appDefinition/parallelRules.mjs';
import { calleeTop, ordinalMap, stepPaths, topOf } from './sequencePaths.mts';
import { attemptStep, errorScopeOf } from './stepErrorFlow.mts';
import { FLOW_KINDS, walkFlowStep, walkLoop } from './sequenceWalkFlow.mts';
import { completeResumed, dropFrame, pauseAt, resumeFrame, resumeIndex, resumesUnder, setFrame } from './sequenceWalkPause.mts';
import { walkCall } from './sequenceWalkCall.mts';
import type { Decision, Obj, Outcome, Step, StepEndEvent, StepEvent, StepResult, WalkHost, WalkState } from './sequenceWalkTypes.mts';

const nodeRequire = createRequire(import.meta.url);
const { LIMITS } = nodeRequire('./componentSpecs/limits.js') as {
    LIMITS: { MAX_ACTION_DEPTH: number; MAX_ACTION_LOOP_ITERATIONS: number };
};
const { stepMetaOf } = nodeRequire('./componentSpecs/stepRegistry.js') as { stepMetaOf: (kind: unknown) => { side?: string; since?: number } | null };

// The contract and the paths live beside the walker; one import path for its users.
export type { Decision, Obj, Outcome, OutcomeView, PausedWalk, PauseRequest, ResumeOutcome, Step, StepEndEvent, StepEvent, StepPath, StepResult, StepStatus, WalkHost, WalkState } from './sequenceWalkTypes.mts';
export { stepPaths };
export { newWalkState, outcomeView, resumedWalkState } from './sequenceWalkState.mts';

/** The base control kinds, walked here. */
const BASE_CONTROL_KINDS: readonly string[] = Object.freeze(['condition', 'switch', 'loop']);
/** Every kind the walker evaluates itself instead of asking the host: the base three and the registry's control kinds. */
export const CONTROL_KINDS: readonly string[] = Object.freeze([...BASE_CONTROL_KINDS, ...FLOW_KINDS]);
/** Distinct paths kept in `outcomes` (a report never needs more). */
export const MAX_OUTCOMES = 300;
const MAX_NOTES = 50;
const MAX_PROMPT_CHARS = 4000;
const MAX_WALK_DEPTH = LIMITS.MAX_ACTION_DEPTH + 1;
export const MAX_LOOP_ITERATIONS = LIMITS.MAX_ACTION_LOOP_ITERATIONS;
export { MAX_CALL_DEPTH } from './sequenceWalkCall.mts';
const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a: unknown, b: unknown): boolean => a === b || (a != null && b != null && String(a) === String(b));

// ── The walk ────────────────────────────────────────────────────────────────

export type Frame = {
    w: WalkState; host: WalkHost; ordinals: Map<object, number>; ownerActionId: string;
    loop: { index: number; count: number } | null; depth: number;
    /** Inside the body of a loop or while of the SAME action: where break and continue work. */
    breakable: boolean;
    /** Under a branch of a `parallel` step: in the action that holds it (`branch`) or in one it calls (`called`). */
    parallel?: 'branch' | 'called';
};

function eventOf(fr: Frame, step: unknown, path: string, kind: string): StepEvent {
    return {
        path, kind, ordinal: isObject(step) ? fr.ordinals.get(step) ?? null : null, ownerActionId: fr.ownerActionId,
        iteration: fr.loop ? fr.loop.index : null, loop: fr.loop,
    };
}

function addNote(w: WalkState, text: string): void {
    if (w.notes.size < MAX_NOTES) w.notes.add(text);
}

export type Ended = Omit<StepEndEvent, keyof StepEvent | 'ms'> & { prompt?: string };

function keepOutcome(w: WalkState, ev: StepEvent, end: Ended, ms: number): void {
    const prev = w.outcomes.get(ev.path);
    if (!prev && w.outcomes.size >= MAX_OUTCOMES) return;
    const outcome: Outcome = {
        path: ev.path, kind: ev.kind, ordinal: ev.ordinal, status: end.status, ms, count: (prev?.count ?? 0) + 1,
        ...(end.result !== undefined ? { result: end.result } : {}),
        ...(end.error !== undefined ? { error: end.error } : {}),
        ...(end.code !== undefined ? { code: end.code } : {}),
        ...(end.note !== undefined ? { note: end.note } : {}),
        ...(end.mocked ? { mocked: true } : {}),
        ...(end.prompt !== undefined ? { prompt: end.prompt } : {}),
        ...(end.attempts !== undefined && end.attempts > 1 ? { attempts: end.attempts } : {}),
        ...(end.handled ? { handled: true } : {}),
    };
    w.outcomes.set(ev.path, outcome);
}

async function record(fr: Frame, ev: StepEvent, end: Ended, startedAt: number): Promise<void> {
    // A paused walk unwinds through its containers: they are recorded when the run really ends them.
    if (fr.w.paused) return;
    const ms = Math.max(0, fr.host.now() - startedAt);
    keepOutcome(fr.w, ev, end, ms);
    const { prompt: _prompt, ...rest } = end;
    await fr.host.onStepEnd?.({ ...ev, ...rest, ms });
}

async function fail(fr: Frame, ev: StepEvent, res: { error?: string; code?: string }, startedAt: number, extra: Partial<Ended> = {}, cause?: string): Promise<void> {
    const error = String(res.error || 'The step failed without a reason');
    fr.w.failed = { path: ev.path, kind: ev.kind, ordinal: ev.ordinal, error, ...(res.code ? { code: res.code } : {}), ...(cause && cause !== ev.kind ? { step: cause } : {}) };
    fr.w.stopped = `${ev.path} failed`;
    await record(fr, ev, { ...extra, status: 'error', error, ...(res.code ? { code: res.code } : {}) }, startedAt);
}

/** A binding the host resolves; a thrown refusal is the step's error (its message is safe to show). */
async function resolveIn(fr: Frame, binding: unknown, ctx: Obj, scope: unknown): Promise<{ value: unknown } | { error: string; code?: string }> {
    try {
        return { value: await fr.host.resolve(binding, ctx, scope) };
    } catch (e) {
        const err = e as { message?: string; code?: unknown };
        return { error: err?.message || 'The binding could not be read', ...(typeof err?.code === 'string' ? { code: err.code } : {}) };
    }
}

/** A resumed walk that cannot get back to its step (a frame is missing): the run fails there and stops looking. */
async function lost(fr: Frame, ev: StepEvent, startedAt: number): Promise<void> {
    fr.w.resume = null;
    return fail(fr, ev, { error: 'The run could not continue where it paused', code: 'resume_lost' }, startedAt);
}

/** What sequenceWalkFlow.mts borrows (function declarations, so the order in this file does not matter). */
const FLOW_API = { walkList, record, fail, resolveIn, addNote, lost };
/** What sequenceWalkCall.mts and sequenceWalkPause.mts borrow, the same way. */
const STEP_API = { walkList, record, fail, resolveIn, lost, failOrHandle };

async function walkList(fr: Frame, list: unknown, base: string): Promise<void> {
    const steps = Array.isArray(list) ? list : [];
    const { w, host } = fr;
    // A resumed walk enters the lists on its way at the step the path names.
    for (let i = resumeIndex(w, base) ?? 0; i < steps.length; i += 1) {
        if (w.stopped || w.signal) return;
        if (host.beforeStep) await host.beforeStep(w);
        const stop = host.shouldStop ? host.shouldStop(w) : null;
        if (stop) { w.stopped = stop; w.truncated = true; return; }
        const step = steps[i];
        const path = `${base}[${i}]`;
        if (!isObject(step) || typeof step.kind !== 'string') {
            const ev = eventOf(fr, step, path, '(invalid)');
            await fail(fr, ev, { error: 'Not a step object' }, host.now());
            w.stopped = `${path} is not a step`;
            return;
        }
        await walkStep(fr, step as Step, path);
    }
}

async function walkStep(fr: Frame, step: Step, path: string): Promise<void> {
    const kind = String(step.kind);
    const ev = eventOf(fr, step, path, kind);
    const startedAt = fr.host.now();
    const resume = fr.w.resume;
    if (resume && resume.path !== path) return reenter(fr, step, ev, startedAt);
    await fr.host.onStepStart?.(ev);
    if (resume) return completeResumed(STEP_API, fr, step, ev, { startedAt, outcome: resume.outcome });
    if (fr.depth > MAX_WALK_DEPTH) {
        return fail(fr, ev, { error: `Steps are nested deeper than ${MAX_WALK_DEPTH - 1} levels` }, startedAt);
    }
    if (fr.parallel && parallelRefusal(kind, fr.parallel === 'branch')) {
        return fail(fr, ev, { error: `A ${kind} step cannot run inside a branch of a parallel step`, code: 'not_in_parallel' }, startedAt);
    }
    if (kind === 'set_variable') return setVariable(fr, step, ev, startedAt);
    if (kind === 'call_action') return walkCall(STEP_API, fr, step, ev, startedAt);
    if (BASE_CONTROL_KINDS.includes(kind)) return walkControl(fr, step, ev, startedAt);
    if (FLOW_KINDS.includes(kind)) return walkFlowStep(FLOW_API, fr, step, ev, startedAt);
    const meta = stepMetaOf(kind);
    if (meta?.side === 'control' && meta.since !== undefined) {
        return fail(fr, ev, { error: `A ${kind} step cannot run here yet`, code: 'kind_unsupported' }, startedAt);
    }
    return walkLeaf(fr, step, ev, startedAt);
}

/**
 * A resumed walk passing through a container on its way back to the step it paused at: the
 * kind enters its child list again from its frame. Nothing is evaluated or recorded twice.
 */
async function reenter(fr: Frame, step: Step, ev: StepEvent, startedAt: number): Promise<void> {
    const kind = String(step.kind);
    if (resumesUnder(fr.w, `${ev.path}.onError.steps[`)) {
        const handler = errorHandlerOf(step);
        const frame = resumeFrame(fr.w, `${ev.path}#onError`);
        if (!handler || !frame) return lost(fr, ev, startedAt);
        return runHandler(fr, ev, handler, isObject(frame.error) ? frame.error : undefined);
    }
    if (kind === 'call_action') return walkCall(STEP_API, fr, step, ev, startedAt);
    if (BASE_CONTROL_KINDS.includes(kind)) return reenterControl(fr, step, ev, startedAt);
    if (FLOW_KINDS.includes(kind)) return walkFlowStep(FLOW_API, fr, step, ev, startedAt);
    return lost(fr, ev, startedAt);
}

async function setVariable(fr: Frame, step: Step, ev: StepEvent, startedAt: number): Promise<void> {
    const { w, host } = fr;
    const name = typeof step.name === 'string' ? step.name : '';
    if (!name) {
        // As before the walker existed: the run is marked failed but goes on.
        w.failed = { path: ev.path, kind: ev.kind, ordinal: ev.ordinal, error: 'set_variable has no name' };
        return record(fr, ev, { status: 'error', error: 'set_variable has no name' }, startedAt);
    }
    const ctx = host.ctxFor(w, ev);
    const got = await resolveIn(fr, step.value, ctx, host.buildScope(ctx));
    if ('error' in got) return fail(fr, ev, got, startedAt);
    w.vars = { ...w.vars, [name]: got.value };
    host.onVar?.(name, got.value);
    return record(fr, ev, { status: 'ok', result: { [name]: got.value } }, startedAt);
}

async function decideSafe(fr: Frame, step: Step, ev: StepEvent): Promise<Decision | { error: string }> {
    try {
        return await fr.host.decide(step, ev, fr.w);
    } catch (e) {
        return { error: (e as Error)?.message || 'The step could not be prepared' };
    }
}

async function executeSafe(fr: Frame, step: Step, ev: StepEvent): Promise<StepResult> {
    try {
        const res = await fr.host.execute(step, ev, fr.w);
        return res && typeof res === 'object' ? res : { ok: false, error: 'The step gave no answer', retryable: false };
    } catch (e) {
        // An unknown outcome (the host itself threw): never retried.
        return { ok: false, error: (e as Error)?.message || 'The step could not run', retryable: false };
    }
}

function promptFor(fr: Frame, step: Step, ctx: Obj): string | undefined {
    const text = fr.host.promptOf ? fr.host.promptOf(step, ctx) : undefined;
    return typeof text === 'string' ? text.slice(0, MAX_PROMPT_CHARS) : undefined;
}

async function walkLeaf(fr: Frame, step: Step, ev: StepEvent, startedAt: number): Promise<void> {
    const { w, host } = fr;
    const decision = await decideSafe(fr, step, ev);
    if ('error' in decision) return fail(fr, ev, decision, startedAt);
    if (!decision.run) {
        return record(fr, ev, { status: decision.status, error: decision.reason, ...(decision.result !== undefined ? { result: decision.result } : {}) }, startedAt);
    }
    const ctx = host.ctxFor(w, ev);
    const prompt = promptFor(fr, decision.step, ctx);
    const mock = host.mockFor && host.mocked ? host.mockFor(ev.path, step) : null;
    const once = async (attempt: number): Promise<StepResult> => {
        w.executed += 1;
        return mock && host.mocked ? host.mocked(step, mock.value, ctx, attempt) : executeSafe(fr, decision.step, ev);
    };
    const { res, attempts } = await attemptStep(step, once, { sleep: (ms) => host.sleep(ms), stop: () => !!(host.shouldStop && host.shouldStop(w)) });
    const extra: Partial<Ended> = { ...(mock ? { mocked: true } : {}), ...(prompt !== undefined ? { prompt } : {}), ...(attempts > 1 ? { attempts } : {}) };
    for (const note of Array.isArray(res.notes) ? res.notes : []) addNote(w, `${ev.path}: ${String(note).slice(0, 300)}`);
    if (res.ok !== true) return failOrHandle(fr, step, ev, { res, attempts, startedAt, extra });
    if (res.pause) return pauseAt(STEP_API, fr, step, ev, { res, attempts, startedAt, extra });
    // A transaction hands back its children's resultVars (as the browser does): later steps read vars.<name>.
    const named = step.kind === 'transaction' && isObject(res.result) ? res.result.vars : undefined;
    if (isObject(named)) w.vars = { ...w.vars, ...named };
    if (typeof step.resultVar === 'string' && step.resultVar) w.vars = { ...w.vars, [step.resultVar]: res.result ?? null };
    w.lastResult = res.result ?? null;
    return record(fr, ev, { ...extra, status: 'ok', result: res.result ?? null, ...(decision.note ? { note: decision.note } : {}) }, startedAt);
}

/** `kind`: the kind that really failed (inside a called action, the callee's step), for error.step. */
export type Failure = { res: StepResult; attempts: number; startedAt: number; extra: Partial<Ended>; kind?: string };

/**
 * A step failed (after its retries). With an onError handler: record it as handled, walk the
 * handler with `w.error` in scope, restore, continue (or stop quietly). Without: stop the run.
 */
async function failOrHandle(fr: Frame, step: Step, ev: StepEvent, f: Failure): Promise<void> {
    const { w } = fr;
    const handler = errorHandlerOf(step);
    if (!handler) return fail(fr, ev, f.res, f.startedAt, f.extra, f.kind);
    const error = String(f.res.error || 'The step failed without a reason');
    await record(fr, ev, { ...f.extra, status: 'error', error, ...(f.res.code ? { code: f.res.code } : {}), attempts: f.attempts, handled: true }, f.startedAt);
    const saved = w.error;
    w.error = errorScopeOf(f.kind ?? ev.kind, f.res, f.attempts, ev.ordinal);
    return runHandler(fr, ev, handler, saved);
}

/** Walks an onError handler with `w.error` already set, then puts back the error scope around it (`saved`). */
async function runHandler(fr: Frame, ev: StepEvent, handler: { steps: unknown; stop?: boolean }, saved: Obj | undefined): Promise<void> {
    const { w } = fr;
    const key = `${ev.path}#onError`;
    setFrame(w, key, saved ? { error: saved } : {});
    try {
        await walkList({ ...fr, depth: fr.depth + 1 }, handler.steps, `${ev.path}.onError.steps`);
    } finally {
        w.error = saved;
        dropFrame(w, key);
    }
    if (handler.stop && !w.stopped) w.stopped = `${ev.path} failed; its onError handler ends the run`;
}

/** A resumed walk passing through a condition, a switch or a loop: the path says which branch, the loop has its frame. */
async function reenterControl(fr: Frame, step: Step, ev: StepEvent, startedAt: number): Promise<void> {
    const inner: Frame = { ...fr, depth: fr.depth + 1 };
    if (step.kind === 'loop') return walkLoop(FLOW_API, inner, step, ev, startedAt, null);
    const slot = childStepSlots(step).find((sl) => sl.suffix !== '.onError.steps' && resumesUnder(fr.w, `${ev.path}${sl.suffix}[`));
    return slot ? walkList(inner, slot.steps, `${ev.path}${slot.suffix}`) : lost(fr, ev, startedAt);
}

async function walkControl(fr: Frame, step: Step, ev: StepEvent, startedAt: number): Promise<void> {
    const { w, host } = fr;
    const ctx = host.ctxFor(w, ev);
    const scope = host.buildScope(ctx);
    // The kind's own branches; a handler slot (last) is walked by failOrHandle, never as a branch.
    const slots = childStepSlots(step).filter((sl) => sl.suffix !== '.onError.steps');
    const inner: Frame = { ...fr, depth: fr.depth + 1 };
    if (step.kind === 'condition') {
        const value = host.evaluate(String(step.expr ?? ''), scope);
        await record(fr, ev, { status: 'ok', result: { branch: value ? 'then' : 'else' } }, startedAt);
        const slot = slots[value ? 0 : 1];
        return walkList(inner, slot.steps, `${ev.path}${slot.suffix}`);
    }
    if (step.kind === 'switch') {
        const value = host.evaluate(String(step.expr ?? ''), scope);
        const cases = Array.isArray(step.cases) ? step.cases as Array<{ value?: unknown; whenExpr?: unknown } | null> : [];
        // A case without a `value` but with a `whenExpr` formula (since 3) is picked when that formula is true.
        const picks = (c: { value?: unknown; whenExpr?: unknown }): boolean => (c.value === undefined && typeof c.whenExpr === 'string' && c.whenExpr !== ''
            ? !!host.evaluate(c.whenExpr, scope) : same(c.value, value));
        const at = cases.findIndex((c) => !!c && picks(c));
        await record(fr, ev, { status: 'ok', result: { case: at >= 0 ? at : 'default' } }, startedAt);
        const slot = slots[at >= 0 ? at : slots.length - 1];
        return walkList(inner, slot.steps, `${ev.path}${slot.suffix}`);
    }
    return walkLoop(FLOW_API, inner, step, ev, startedAt, { ctx, scope });
}

/** Walk one action (a sequence or a bare v1 action) with `host`. */
export async function walkAction(w: WalkState, action: Obj, host: WalkHost, opts: { actionId: string }): Promise<void> {
    const own = host.resolveCallee;
    const resolveCallee = own ? (id: string) => own(id) : undefined;
    for (const p of stepPaths(action, { resolveCallee, rootId: opts.actionId })) if (!w.known.has(p.path)) w.known.set(p.path, p.kind);
    if (!w.callChain.length) w.callChain = [opts.actionId];
    const fr: Frame = { w, host, ordinals: ordinalMap(action), ownerActionId: opts.actionId, loop: null, depth: 1, breakable: false };
    const { list, base } = topOf(action);
    await walkList(fr, list, base);
    // A return ended the action: that is how it ends, not a stop.
    if (w.signal) w.signal = null;
    if (w.resume) {
        // The step the run paused at is not where the path says (it never should be: the host checks the action is unchanged).
        const path = w.resume.path;
        w.resume = null;
        w.failed = { path, kind: '(resume)', ordinal: null, error: 'The run could not continue where it paused', code: 'resume_lost' };
        w.stopped = `${path} was not found`;
    }
}
