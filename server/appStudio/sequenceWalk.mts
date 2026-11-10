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
 * call_action is walker-native: the callee comes from host.resolveCallee (own property of
 * def.actions), runs with `params` (and the caller's vars/form; item/index/value are not
 * inherited), its vars writes carry back, its last server result is the call's result.
 * Missing callee, a cycle or more than LIMITS.MAX_CALL_DEPTH calls stop the run.
 *
 * Ordinals are flattenSteps(normalizeSequence(action)) positions, mapped by object identity,
 * so a walker path and a browser stepIndex always name the same step.
 */

import { createRequire } from 'node:module';
import { childStepSlots, errorHandlerOf } from '../shared/appDefinition/stepFlow.mjs';
import { calleeTop, ordinalMap, stepPaths, topOf } from './sequencePaths.mts';
import { attemptStep, errorScopeOf } from './stepErrorFlow.mts';
import type { Decision, Obj, Outcome, OutcomeView, Step, StepEndEvent, StepEvent, StepResult, WalkHost, WalkState } from './sequenceWalkTypes.mts';

const nodeRequire = createRequire(import.meta.url);
const { LIMITS } = nodeRequire('./componentSpecs/limits.js') as {
    LIMITS: { MAX_ACTION_DEPTH: number; MAX_ACTION_LOOP_ITERATIONS: number; MAX_CALL_DEPTH: number; MAX_CALL_PARAMS: number };
};

// The contract and the paths live beside the walker; one import path for its users.
export type { Decision, Obj, Outcome, OutcomeView, Step, StepEndEvent, StepEvent, StepPath, StepResult, StepStatus, WalkHost, WalkState } from './sequenceWalkTypes.mts';
export { stepPaths };

export const CONTROL_KINDS: readonly string[] = Object.freeze(['condition', 'switch', 'loop']);
/** Distinct paths kept in `outcomes` (a report never needs more). */
export const MAX_OUTCOMES = 300;
const MAX_NOTES = 50;
const MAX_PROMPT_CHARS = 4000;
const MAX_WALK_DEPTH = LIMITS.MAX_ACTION_DEPTH + 1;
export const MAX_LOOP_ITERATIONS = LIMITS.MAX_ACTION_LOOP_ITERATIONS;
export const MAX_CALL_DEPTH = LIMITS.MAX_CALL_DEPTH;
/** The lastResult of a called action before it ran a server step. */
const NO_RESULT: unique symbol = Symbol('no result');

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a: unknown, b: unknown): boolean => a === b || (a != null && b != null && String(a) === String(b));

/** A fresh state for one walk. */
export function newWalkState(init: { vars?: Obj; form?: Obj; item?: unknown; index?: unknown; value?: unknown; params?: Obj } = {}): WalkState {
    return {
        vars: { ...(init.vars ?? {}) }, form: { ...(init.form ?? {}) }, item: init.item, index: init.index, value: init.value,
        params: { ...(init.params ?? {}) },
        lastResult: null, executed: 0, stopped: null, truncated: false, failed: null,
        callChain: [], deferred: [], outcomes: new Map(), known: new Map(), notes: new Set(),
    };
}


// ── The walk ────────────────────────────────────────────────────────────────

type Frame = {
    w: WalkState; host: WalkHost; ordinals: Map<object, number>; ownerActionId: string;
    loop: { index: number; count: number } | null; depth: number;
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

type Ended = Omit<StepEndEvent, keyof StepEvent | 'ms'> & { prompt?: string };

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
    const ms = Math.max(0, fr.host.now() - startedAt);
    keepOutcome(fr.w, ev, end, ms);
    const { prompt: _prompt, ...rest } = end;
    await fr.host.onStepEnd?.({ ...ev, ...rest, ms });
}

async function fail(fr: Frame, ev: StepEvent, res: { error?: string; code?: string }, startedAt: number, extra: Partial<Ended> = {}): Promise<void> {
    const error = String(res.error || 'The step failed without a reason');
    fr.w.failed = { path: ev.path, kind: ev.kind, ordinal: ev.ordinal, error, ...(res.code ? { code: res.code } : {}) };
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

async function walkList(fr: Frame, list: unknown, base: string): Promise<void> {
    const steps = Array.isArray(list) ? list : [];
    const { w, host } = fr;
    for (let i = 0; i < steps.length; i += 1) {
        if (w.stopped) return;
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
    await fr.host.onStepStart?.(ev);
    if (fr.depth > MAX_WALK_DEPTH) {
        return fail(fr, ev, { error: `Steps are nested deeper than ${MAX_WALK_DEPTH - 1} levels` }, startedAt);
    }
    if (kind === 'set_variable') return setVariable(fr, step, ev, startedAt);
    if (kind === 'call_action') return walkCall(fr, step, ev, startedAt);
    if (CONTROL_KINDS.includes(kind)) return walkControl(fr, step, ev, startedAt);
    return walkLeaf(fr, step, ev, startedAt);
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
    // A transaction hands back its children's resultVars (as the browser does): later steps read vars.<name>.
    const named = step.kind === 'transaction' && isObject(res.result) ? res.result.vars : undefined;
    if (isObject(named)) w.vars = { ...w.vars, ...named };
    if (typeof step.resultVar === 'string' && step.resultVar) w.vars = { ...w.vars, [step.resultVar]: res.result ?? null };
    w.lastResult = res.result ?? null;
    return record(fr, ev, { ...extra, status: 'ok', result: res.result ?? null, ...(decision.note ? { note: decision.note } : {}) }, startedAt);
}

/** `kind`: the kind that really failed (inside a called action, the callee's step), for error.step. */
type Failure = { res: StepResult; attempts: number; startedAt: number; extra: Partial<Ended>; kind?: string };

/**
 * A step failed (after its retries). With an onError handler: record it as handled, walk the
 * handler with `w.error` in scope, restore, continue (or stop quietly). Without: stop the run.
 */
async function failOrHandle(fr: Frame, step: Step, ev: StepEvent, f: Failure): Promise<void> {
    const { w } = fr;
    const handler = errorHandlerOf(step);
    if (!handler) return fail(fr, ev, f.res, f.startedAt, f.extra);
    const error = String(f.res.error || 'The step failed without a reason');
    await record(fr, ev, { ...f.extra, status: 'error', error, ...(f.res.code ? { code: f.res.code } : {}), attempts: f.attempts, handled: true }, f.startedAt);
    const saved = w.error;
    w.error = errorScopeOf(f.kind ?? ev.kind, f.res, f.attempts, ev.ordinal);
    try {
        await walkList({ ...fr, depth: fr.depth + 1 }, handler.steps, `${ev.path}.onError.steps`);
    } finally {
        w.error = saved;
    }
    if (handler.stop && !w.stopped) w.stopped = `${ev.path} failed; its onError handler ends the run`;
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
    return walkLoop(inner, step, ev, startedAt, { ctx, scope });
}

async function walkLoop(fr: Frame, step: Step, ev: StepEvent, startedAt: number, at: { ctx: Obj; scope: unknown }): Promise<void> {
    const { w } = fr;
    const got = await resolveIn(fr, step.source, at.ctx, at.scope);
    if ('error' in got) return fail(fr, ev, got, startedAt);
    const source = got.value;
    if (!Array.isArray(source)) {
        addNote(w, `${ev.path}: the loop source did not resolve to a list. Bind it to a records binding, or to a formula that returns a list (e.g. rows passed in scope.vars).`);
        return record(fr, ev, { status: 'skipped', error: 'source did not resolve to a list', result: { iterations: 0 } }, startedAt);
    }
    const own = typeof step.maxIterations === 'number' && step.maxIterations > 0 ? step.maxIterations : MAX_LOOP_ITERATIONS;
    const cap = Math.min(own, MAX_LOOP_ITERATIONS);
    const count = Math.min(source.length, cap);
    if (source.length > count) addNote(w, `${ev.path}: looped ${count} of ${source.length} rows (cap ${cap}).`);
    await record(fr, ev, { status: 'ok', result: { iterations: count } }, startedAt);
    const saved = { vars: w.vars, item: w.item, index: w.index };
    for (let n = 0; n < count && !w.stopped; n += 1) {
        w.item = source[n];
        w.index = n;
        const bound: Obj = {};
        if (typeof step.itemVar === 'string' && step.itemVar) bound[step.itemVar] = source[n];
        if (typeof step.indexVar === 'string' && step.indexVar) bound[step.indexVar] = n;
        w.vars = { ...w.vars, ...bound };
        await walkList({ ...fr, loop: { index: n, count } }, step.steps, `${ev.path}.steps`);
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

/** Why a call_action cannot run, or null. */
function callRefusal(w: WalkState, id: string, callee: Obj | null): { error: string; code: string } | null {
    if (!id || !callee) return { error: `call_action: the app has no action "${id.slice(0, 80)}"`, code: 'call_missing' };
    if (w.callChain.includes(id)) return { error: `call_action: ${[...w.callChain, id].join(' → ')} calls itself; an action cannot run itself, directly or through another action`, code: 'call_cycle' };
    if (w.callChain.length > MAX_CALL_DEPTH) return { error: `call_action: ${[...w.callChain, id].join(' → ')} is more than ${MAX_CALL_DEPTH} calls deep`, code: 'call_too_deep' };
    return null;
}

/** The call's params, resolved in the CALLER's scope (data bindings are read like any binding). */
async function callParams(fr: Frame, step: Step, ev: StepEvent): Promise<{ value: Obj } | { error: string; code?: string }> {
    const ctx = fr.host.ctxFor(fr.w, ev);
    const scope = fr.host.buildScope(ctx);
    const params: Obj = {};
    const entries = isObject(step.params) ? Object.entries(step.params).slice(0, LIMITS.MAX_CALL_PARAMS) : [];
    for (const [name, binding] of entries) {
        const got = await resolveIn(fr, binding, ctx, scope);
        if ('error' in got) return got;
        params[name] = got.value;
    }
    return { value: params };
}

async function walkCall(fr: Frame, step: Step, ev: StepEvent, startedAt: number): Promise<void> {
    const { w, host } = fr;
    const id = typeof step.actionId === 'string' ? step.actionId : '';
    const callee = id && host.resolveCallee ? host.resolveCallee(id) : null;
    const refused = callRefusal(w, id, isObject(callee) ? callee : null);
    if (refused) return fail(fr, ev, refused, startedAt);
    const got = await callParams(fr, step, ev);
    if ('error' in got) return fail(fr, ev, got, startedAt);
    const saved = { params: w.params, item: w.item, index: w.index, value: w.value, lastResult: w.lastResult, callChain: w.callChain, failed: w.failed };
    Object.assign(w, { params: got.value, item: undefined, index: undefined, value: undefined, lastResult: NO_RESULT, callChain: [...w.callChain, id] });
    const { list, base } = calleeTop(callee, `${ev.path}.call.steps`);
    try {
        await walkList({ ...fr, ordinals: ordinalMap(callee), ownerActionId: id, depth: 1 }, list, base);
    } finally {
        const produced = w.lastResult !== NO_RESULT;
        const result = produced ? w.lastResult : null;
        Object.assign(w, { params: saved.params, item: saved.item, index: saved.index, value: saved.value, callChain: saved.callChain, lastResult: produced ? result : saved.lastResult });
        if (typeof step.resultVar === 'string' && step.resultVar) w.vars = { ...w.vars, [step.resultVar]: result };
    }
    const outcome = { actionId: id, params: got.value };
    if (w.stopped && w.failed && w.failed !== saved.failed) {
        const inner = w.failed;
        const res = { ok: false, error: `The called action "${id}" failed at ${inner.path}: ${inner.error}`, ...(inner.code ? { code: inner.code } : {}) };
        if (errorHandlerOf(step)) { w.stopped = null; w.failed = saved.failed; }
        return failOrHandle(fr, step, ev, { res, attempts: 1, startedAt, extra: { result: outcome }, kind: inner.kind });
    }
    return record(fr, ev, { status: 'ok', result: outcome }, startedAt);
}

/** Walk one action (a sequence or a bare v1 action) with `host`. */
export async function walkAction(w: WalkState, action: Obj, host: WalkHost, opts: { actionId: string }): Promise<void> {
    const own = host.resolveCallee;
    const resolveCallee = own ? (id: string) => own(id) : undefined;
    for (const p of stepPaths(action, { resolveCallee, rootId: opts.actionId })) if (!w.known.has(p.path)) w.known.set(p.path, p.kind);
    if (!w.callChain.length) w.callChain = [opts.actionId];
    const fr: Frame = { w, host, ordinals: ordinalMap(action), ownerActionId: opts.actionId, loop: null, depth: 1 };
    const { list, base } = topOf(action);
    await walkList(fr, list, base);
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
