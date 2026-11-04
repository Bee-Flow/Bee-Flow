/**
 * The ONE server-side walker of an action sequence.
 *
 * app_run_action and app_run_tests walk through it today; later hosts (call_action,
 * onError/retry, background jobs, the mailbox hook, run logging) add a WalkHost, never a
 * second walker. The walker owns the control flow (condition, switch, loop, set_variable),
 * the walker paths and the outcome per path; the HOST owns every decision with a policy in
 * it (what may run, what it costs, how a step reaches the executor).
 *
 * Leaf order: onStepStart → decide → mock (mockFor/mocked) or execute → onStepEnd →
 * on failure: stop → resultVar, lastResult.
 *
 * Path grammar (fixed; reports, saved-test mocks and expectations read it):
 *   `steps[i]` at the top of a sequence, `action[0]` for a bare v1 action;
 *   `.then[i]`, `.else[i]`; `.cases[k].steps[i]`, `.default[i]`; a loop body `.steps[i]`
 *   (no iteration index in the path: the event carries `iteration` and `loop.count`).
 * The suffixes come from shared/appDefinition/stepFlow.mjs (childStepSlots).
 *
 * Ordinals are flattenSteps(normalizeSequence(action)) positions, mapped by object identity,
 * so a walker path and a browser stepIndex always name the same step.
 */

import { createRequire } from 'node:module';
import { childStepSlots } from '../shared/appDefinition/stepFlow.mjs';

const nodeRequire = createRequire(import.meta.url);
const { LIMITS } = nodeRequire('./componentSpecs/limits.js') as { LIMITS: { MAX_ACTION_DEPTH: number; MAX_ACTION_LOOP_ITERATIONS: number } };

export type Obj = Record<string, unknown>;
export type Step = Obj & { kind?: string };

export type StepResult = { ok: boolean; result?: unknown; error?: string; code?: string; retryable?: boolean; notes?: string[] };
export type Decision =
    | { run: true; step: Step; note?: string }
    | { run: false; status: 'skipped' | 'refused' | 'deferred'; reason: string; result?: unknown };

export type StepEvent = {
    path: string; kind: string; ordinal: number | null; ownerActionId: string;
    iteration: number | null; loop: { index: number; count: number } | null;
};
export type StepStatus = 'ok' | 'error' | 'skipped' | 'refused' | 'deferred';
export type StepEndEvent = StepEvent & {
    status: StepStatus; ms: number;
    error?: string; code?: string; mocked?: boolean; attempts?: number; handled?: boolean; result?: unknown;
    /** A remark on a step that ran (e.g. "dryRun: writeTo not applied"). */
    note?: string;
};

export type Outcome = {
    path: string; kind: string; ordinal: number | null;
    status: StepStatus | 'not_run';
    result?: unknown; error?: string; code?: string; prompt?: string; note?: string;
    mocked?: boolean; ms: number;
    /** How often the path ran (a loop body runs once per iteration; the outcome is the last). */
    count: number;
};

export type WalkState = {
    vars: Obj; form: Obj; item: unknown; index: unknown; value: unknown;
    params: Obj;
    error?: Obj;
    lastResult: unknown; executed: number; stopped: string | null;
    /** The stop came from a budget (shouldStop), not from a failing step. */
    truncated: boolean;
    failed: { path: string; kind: string; ordinal: number | null; error: string; code?: string } | null;
    callChain: string[];
    deferred: Obj[];
    outcomes: Map<string, Outcome>;
    /** Every walker path of the action with its kind (stepPaths), set by walkAction. */
    known: Map<string, string>;
    /** Remarks for the caller ("looped 200 of 450 rows"), each prefixed with its path. */
    notes: Set<string>;
};

export type WalkHost = {
    decide(step: Step, f: StepEvent, w: WalkState): Promise<Decision>;
    execute(step: Step, f: StepEvent, w: WalkState): Promise<StepResult>;
    mockFor?(path: string, step: Step): { value: unknown } | null;
    mocked?(step: Step, value: unknown, ctx: Obj): StepResult;
    resolve(binding: unknown, ctx: Obj, scope: unknown): Promise<unknown>;
    evaluate(expr: string, scope: unknown): unknown;
    buildScope(ctx: Obj): unknown;
    ctxFor(w: WalkState, f: StepEvent): Obj;
    promptOf?(step: Step, ctx: Obj): string | undefined;
    onStepStart?(e: StepEvent): void | Promise<void>;
    onStepEnd?(e: StepEndEvent): void | Promise<void>;
    onVar?(name: string, value: unknown): void;
    shouldStop?(w: WalkState): string | null;
    resolveCallee?(actionId: string): Obj | null;
    sleep(ms: number): Promise<void>;
    now(): number;
};

export type StepPath = { path: string; kind: string; ordinal: number | null; ownerActionId?: string };

export type OutcomeView = {
    ok: boolean; stopped: string | null; failed: WalkState['failed'];
    vars: Obj; result: unknown; steps: Map<string, Outcome>;
};

export const CONTROL_KINDS: readonly string[] = Object.freeze(['condition', 'switch', 'loop']);
/** Distinct paths kept in `outcomes` (a report never needs more). */
export const MAX_OUTCOMES = 300;
const MAX_NOTES = 50;
const MAX_PROMPT_CHARS = 4000;
const MAX_WALK_DEPTH = LIMITS.MAX_ACTION_DEPTH + 1;
export const MAX_LOOP_ITERATIONS = LIMITS.MAX_ACTION_LOOP_ITERATIONS;

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

// ── Paths and ordinals ──────────────────────────────────────────────────────

function topOf(action: unknown): { list: unknown[]; base: string } {
    if (!isObject(action)) return { list: [], base: 'steps' };
    if (action.kind === 'sequence') return { list: Array.isArray(action.steps) ? action.steps : [], base: 'steps' };
    return { list: [action], base: 'action' };
}

/** flattenSteps positions by object identity (the browser's stepIndex). */
function ordinalMap(action: unknown): Map<object, number> {
    const seq = nodeRequire('./actionSequence.js') as { normalizeSequence: (a: unknown) => unknown[]; flattenSteps: (s: unknown[]) => unknown[] };
    const map = new Map<object, number>();
    seq.flattenSteps(seq.normalizeSequence(action)).forEach((step, i) => { if (isObject(step)) map.set(step, i); });
    return map;
}

function collectPaths(list: unknown[], base: string, ordinals: Map<object, number>, depth: number, out: StepPath[]): void {
    list.forEach((step, i) => {
        if (!isObject(step)) return;
        const path = `${base}[${i}]`;
        out.push({ path, kind: typeof step.kind === 'string' ? step.kind : '(invalid)', ordinal: ordinals.get(step) ?? null });
        if (depth >= MAX_WALK_DEPTH) return;
        for (const slot of childStepSlots(step)) {
            if (slot.walked) collectPaths(slot.steps, `${path}${slot.suffix}`, ordinals, depth + 1, out);
        }
    });
}

/**
 * Every walker path of `action` with its kind and its flattenSteps ordinal, in pre-order.
 * `opts.resolveCallee` is the seam for a called action's steps (none yet).
 */
export function stepPaths(action: unknown, _opts: { resolveCallee?: (id: string) => Obj | null } = {}): StepPath[] {
    const out: StepPath[] = [];
    const { list, base } = topOf(action);
    collectPaths(list, base, ordinalMap(action), 1, out);
    return out;
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
    const error = String(res.error || 'Step failed');
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
        return res && typeof res === 'object' ? res : { ok: false, error: 'Step failed' };
    } catch (e) {
        return { ok: false, error: (e as Error)?.message || 'Step failed' };
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
    w.executed += 1;
    const res = mock && host.mocked ? host.mocked(step, mock.value, ctx) : await executeSafe(fr, decision.step, ev);
    const extra: Partial<Ended> = { ...(mock ? { mocked: true } : {}), ...(prompt !== undefined ? { prompt } : {}) };
    for (const note of Array.isArray(res.notes) ? res.notes : []) addNote(w, `${ev.path}: ${String(note).slice(0, 300)}`);
    if (res.ok !== true) return fail(fr, ev, res, startedAt, extra);
    if (typeof step.resultVar === 'string' && step.resultVar) w.vars = { ...w.vars, [step.resultVar]: res.result ?? null };
    w.lastResult = res.result ?? null;
    return record(fr, ev, { ...extra, status: 'ok', result: res.result ?? null, ...(decision.note ? { note: decision.note } : {}) }, startedAt);
}

async function walkControl(fr: Frame, step: Step, ev: StepEvent, startedAt: number): Promise<void> {
    const { w, host } = fr;
    const ctx = host.ctxFor(w, ev);
    const scope = host.buildScope(ctx);
    const slots = childStepSlots(step);
    const inner: Frame = { ...fr, depth: fr.depth + 1 };
    if (step.kind === 'condition') {
        const value = host.evaluate(String(step.expr ?? ''), scope);
        await record(fr, ev, { status: 'ok', result: { branch: value ? 'then' : 'else' } }, startedAt);
        const slot = slots[value ? 0 : 1];
        return walkList(inner, slot.steps, `${ev.path}${slot.suffix}`);
    }
    if (step.kind === 'switch') {
        const value = host.evaluate(String(step.expr ?? ''), scope);
        const cases = Array.isArray(step.cases) ? step.cases as Array<{ value?: unknown } | null> : [];
        const at = cases.findIndex((c) => !!c && same(c.value, value));
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

/** Walk one action (a sequence or a bare v1 action) with `host`. */
export async function walkAction(w: WalkState, action: Obj, host: WalkHost, opts: { actionId: string }): Promise<void> {
    for (const p of stepPaths(action)) if (!w.known.has(p.path)) w.known.set(p.path, p.kind);
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
