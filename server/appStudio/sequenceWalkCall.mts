/**
 * The `call_action` step of the server walker (sequenceWalk.mts): the callee comes from
 * host.resolveCallee (own property of def.actions), runs with `params` (and the caller's vars and
 * form; item, index and value are not inherited), its vars writes carry back, its last server
 * result is the call's result. A missing callee, a cycle or more than LIMITS.MAX_CALL_DEPTH calls
 * stop the run.
 *
 * While the callee is walked the call keeps a frame (sequenceWalkPause.mts): what the caller had
 * before the call, and the call's params. A walk that paused inside the callee enters it again
 * from that frame: the params are not resolved a second time.
 */

import { createRequire } from 'node:module';
import { errorHandlerOf } from '../shared/appDefinition/stepFlow.mjs';
import { calleeTop, ordinalMap } from './sequencePaths.mts';
import { NO_RESULT, box, dropFrame, resumeFrame, setFrame, unbox } from './sequenceWalkPause.mts';
import type { Ended, Failure, Frame } from './sequenceWalk.mts';
import type { Obj, Step, StepEvent, WalkState } from './sequenceWalkTypes.mts';

const nodeRequire = createRequire(import.meta.url);
const { LIMITS } = nodeRequire('./componentSpecs/limits.js') as { LIMITS: { MAX_CALL_DEPTH: number; MAX_CALL_PARAMS: number } };

export const MAX_CALL_DEPTH = LIMITS.MAX_CALL_DEPTH;

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** What the walker lends this module and sequenceWalkPause.mts (its own functions, so there is one of each). */
export type StepApi = {
    walkList(fr: Frame, list: unknown, base: string): Promise<void>;
    record(fr: Frame, ev: StepEvent, end: Ended, startedAt: number): Promise<void>;
    fail(fr: Frame, ev: StepEvent, res: { error?: string; code?: string }, startedAt: number): Promise<void>;
    resolveIn(fr: Frame, binding: unknown, ctx: Obj, scope: unknown): Promise<{ value: unknown } | { error: string; code?: string }>;
    lost(fr: Frame, ev: StepEvent, startedAt: number): Promise<void>;
    failOrHandle(fr: Frame, step: Step, ev: StepEvent, f: Failure): Promise<void>;
};

/** Why a call_action cannot run, or null. */
function callRefusal(w: WalkState, id: string, callee: Obj | null): { error: string; code: string } | null {
    if (!id || !callee) return { error: `call_action: the app has no action "${id.slice(0, 80)}"`, code: 'call_missing' };
    if (w.callChain.includes(id)) return { error: `call_action: ${[...w.callChain, id].join(' → ')} calls itself; an action cannot run itself, directly or through another action`, code: 'call_cycle' };
    if (w.callChain.length > MAX_CALL_DEPTH) return { error: `call_action: ${[...w.callChain, id].join(' → ')} is more than ${MAX_CALL_DEPTH} calls deep`, code: 'call_too_deep' };
    return null;
}

/** The call's params, resolved in the CALLER's scope (data bindings are read like any binding). */
async function callParams(api: StepApi, fr: Frame, step: Step, ev: StepEvent): Promise<{ value: Obj } | { error: string; code?: string }> {
    const ctx = fr.host.ctxFor(fr.w, ev);
    const scope = fr.host.buildScope(ctx);
    const params: Obj = {};
    const entries = isObject(step.params) ? Object.entries(step.params).slice(0, LIMITS.MAX_CALL_PARAMS) : [];
    for (const [name, binding] of entries) {
        const got = await api.resolveIn(fr, binding, ctx, scope);
        if ('error' in got) return got;
        params[name] = got.value;
    }
    return { value: params };
}

type CallSaved = { params: Obj; item: unknown; index: unknown; value: unknown; lastResult: unknown; callChain: string[]; failed: WalkState['failed'] };
type CallEntry = { saved: CallSaved; params: Obj };

/** The call a resumed walk is inside of, from its frame. */
function callFromFrame(frame: Obj | null): CallEntry | null {
    const saved = frame && isObject(frame.saved) ? frame.saved : null;
    if (!frame || !saved || !isObject(frame.params)) return null;
    return {
        saved: {
            params: isObject(saved.params) ? saved.params : {}, item: saved.item, index: saved.index, value: saved.value,
            lastResult: unbox(saved.lastResult), callChain: Array.isArray(saved.callChain) ? saved.callChain.map(String) : [],
            failed: (saved.failed ?? null) as WalkState['failed'],
        },
        params: frame.params,
    };
}

/** Enter the called action: its params on the state, what the caller had set aside. Null after failing the step. */
async function enterCall(api: StepApi, fr: Frame, step: Step, ev: StepEvent, at: { startedAt: number; callee: Obj | null }): Promise<CallEntry | null> {
    const { w } = fr;
    const { startedAt, callee } = at;
    const id = typeof step.actionId === 'string' ? step.actionId : '';
    if (w.resume) {
        const back = callee ? callFromFrame(resumeFrame(w, `${ev.path}#call`)) : null;
        if (!back) await api.lost(fr, ev, startedAt);
        return back;
    }
    const refused = callRefusal(w, id, callee);
    if (refused) { await api.fail(fr, ev, refused, startedAt); return null; }
    const got = await callParams(api, fr, step, ev);
    if ('error' in got) { await api.fail(fr, ev, got, startedAt); return null; }
    const saved: CallSaved = { params: w.params, item: w.item, index: w.index, value: w.value, lastResult: w.lastResult, callChain: w.callChain, failed: w.failed };
    Object.assign(w, { params: got.value, item: undefined, index: undefined, value: undefined, lastResult: NO_RESULT, callChain: [...w.callChain, id] });
    return { saved, params: got.value };
}

/** Walks one call_action step: the called action as a sequence of its own, then back to the caller. */
export async function walkCall(api: StepApi, fr: Frame, step: Step, ev: StepEvent, startedAt: number): Promise<void> {
    const { w, host } = fr;
    const id = typeof step.actionId === 'string' ? step.actionId : '';
    const found = id && host.resolveCallee ? host.resolveCallee(id) : null;
    const callee = isObject(found) ? found : null;
    const entry = await enterCall(api, fr, step, ev, { startedAt, callee });
    if (!entry) return;
    const { saved } = entry;
    const key = `${ev.path}#call`;
    setFrame(w, key, { saved: { ...saved, lastResult: box(saved.lastResult) }, params: entry.params });
    const { list, base } = calleeTop(callee, `${ev.path}.call.steps`);
    try {
        await api.walkList({ ...fr, ordinals: ordinalMap(callee), ownerActionId: id, depth: 1, breakable: false, ...(fr.parallel ? { parallel: 'called' as const } : {}) }, list, base);
    } finally {
        dropFrame(w, key);
        // A return ends the called action only: the caller goes on.
        if (w.signal) w.signal = null;
        const produced = w.lastResult !== NO_RESULT;
        const result = produced ? w.lastResult : null;
        Object.assign(w, { params: saved.params, item: saved.item, index: saved.index, value: saved.value, callChain: saved.callChain, lastResult: produced ? result : saved.lastResult });
        if (typeof step.resultVar === 'string' && step.resultVar) w.vars = { ...w.vars, [step.resultVar]: result };
    }
    const outcome = { actionId: id, params: entry.params };
    if (w.stopped && w.failed && w.failed !== saved.failed) {
        const inner = w.failed;
        const res = { ok: false, error: `The called action "${id}" failed at ${inner.path}: ${inner.error}`, ...(inner.code ? { code: inner.code } : {}) };
        if (errorHandlerOf(step)) { w.stopped = null; w.failed = saved.failed; }
        return api.failOrHandle(fr, step, ev, { res, attempts: 1, startedAt, extra: { result: outcome }, kind: inner.kind });
    }
    return api.record(fr, ev, { status: 'ok', result: outcome }, startedAt);
}
