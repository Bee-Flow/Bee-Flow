/**
 * Pausing a walk and walking on later (sequenceWalk.mts), possibly in another process.
 *
 * A leaf step whose result carries `pause` (runPause.mts) stops the walk at that step. At that
 * moment the walk state is copied to plain JSON (snapshotWalk): the scope roots, the counters,
 * the deferred effects and one FRAME per container the step sits in. A frame is what its
 * container needs to be entered again without evaluating anything twice:
 *
 *   <path>#loop     the rows still to do, the round, what to put back after the loop
 *   <path>#while    the rounds done
 *   <path>#try      the slot the walk is in (steps, catch, finally) and what is pending
 *   <path>#call     what the caller had before the call, and the call's params
 *   <path>#onError  the error scope around the handler
 *
 * A condition and a switch need no frame: the path says which branch was taken. A branch of a
 * `parallel` step cannot pause (the walker refuses it), so there is no frame for a fork.
 *
 * Resuming (restoreInto): a fresh state gets the snapshot back and `resume` set. The walker then
 * starts every list on the way at the index the path names, lets each container enter its list
 * again from its frame, and completes the paused step with the resume's outcome: a result (its
 * resultVar is set, the walk goes on) or a failure its onError handler or an enclosing try takes.
 *
 * Outcomes per path and notes are not kept: a report of the whole run is not what a paused
 * background run answers with, and they would be a second copy of step results at rest.
 */

import type { Failure, Frame } from './sequenceWalk.mts';
import type { StepApi } from './sequenceWalkCall.mts';
import type { Obj, PausedWalk, ResumeOutcome, Step, StepEvent, StepResult, WalkState } from './sequenceWalkTypes.mts';

/** The lastResult of a called action before it ran a server step. */
export const NO_RESULT: unique symbol = Symbol('no result');

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A value that may be NO_RESULT, as JSON. */
export const box = (v: unknown): Obj => (v === NO_RESULT ? { none: true } : { value: v ?? null });
export const unbox = (b: unknown): unknown => {
    if (!isObject(b)) return null;
    return b.none === true ? NO_RESULT : b.value ?? null;
};

// ── Frames ──────────────────────────────────────────────────────────────────

export function setFrame(w: WalkState, key: string, frame: Obj): void {
    if (!w.frames) w.frames = new Map();
    w.frames.set(key, frame);
}

export function dropFrame(w: WalkState, key: string): void {
    w.frames?.delete(key);
}

/** The frame a resumed walk kept under `key`, or null. */
export function resumeFrame(w: WalkState, key: string): Obj | null {
    const frame = w.resume ? w.resume.frames[key] : null;
    return isObject(frame) ? frame : null;
}

/** True while a resumed walk still has to pass through a path that starts with `prefix`. */
export function resumesUnder(w: WalkState, prefix: string): boolean {
    return !!w.resume && w.resume.path.startsWith(prefix);
}

/** The index a resumed walk enters the list at `base` with, or null when the list starts at its first step. */
export function resumeIndex(w: WalkState, base: string): number | null {
    if (!resumesUnder(w, `${base}[`)) return null;
    const rest = w.resume ? w.resume.path.slice(base.length + 1) : '';
    const end = rest.indexOf(']');
    const n = end > 0 ? Number(rest.slice(0, end)) : NaN;
    return Number.isInteger(n) && n >= 0 ? n : null;
}

// ── Snapshot ────────────────────────────────────────────────────────────────

const framePath = (key: string): string => key.slice(0, Math.max(0, key.lastIndexOf('#')));

/** A loop frame keeps only the rows from its current round on. */
function encodeFrame(frame: Obj): Obj {
    if (!Array.isArray(frame.source) || typeof frame.n !== 'number') return frame;
    const from = frame.n - (typeof frame.offset === 'number' ? frame.offset : 0);
    return { ...frame, source: frame.source.slice(Math.max(0, from)), offset: frame.n };
}

/**
 * The walk as plain JSON, paused at `cursor`. Throws when a value in scope cannot be stored
 * (a cycle); the walker then fails the step instead of pausing.
 */
export function snapshotWalk(w: WalkState, cursor: string): Obj {
    const frames: Obj = {};
    for (const [key, frame] of w.frames ?? []) {
        // Only the containers the paused step sits in: a frame beside the path is not needed to get back.
        if (cursor.startsWith(`${framePath(key)}.`)) frames[key] = encodeFrame(frame);
    }
    const raw = {
        v: 1, cursor, vars: w.vars, form: w.form, item: w.item, index: w.index, value: w.value, params: w.params,
        ...(w.error ? { error: w.error } : {}),
        ...(w.trigger ? { trigger: w.trigger } : {}),
        lastResult: box(w.lastResult), executed: w.executed, callChain: w.callChain, deferred: w.deferred, failed: w.failed, frames,
    };
    return JSON.parse(JSON.stringify(raw)) as Obj;
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * A try and a call tell "a new failure" from "the failure that was already there" by identity.
 * After a round trip through JSON a frame's copy of the walk's failure is that failure again.
 */
function relinkFailed(frame: Obj, failed: WalkState['failed']): void {
    if (!failed) return;
    if (sameJson(frame.before, failed)) frame.before = failed;
    for (const holder of [frame.saved, frame.pending]) {
        if (isObject(holder) && sameJson(holder.failed, failed)) holder.failed = failed;
    }
}

const objOr = (v: unknown): Obj => (isObject(v) ? v : {});

/**
 * Put a snapshot back on the fresh state `w` and point it at the step it paused at. False when
 * the snapshot is not one this walker wrote.
 */
export function restoreInto(w: WalkState, state: unknown, outcome: ResumeOutcome): boolean {
    if (!isObject(state) || state.v !== 1 || typeof state.cursor !== 'string' || !state.cursor) return false;
    const failed = isObject(state.failed) ? state.failed as NonNullable<WalkState['failed']> : null;
    const frames: Record<string, Obj> = {};
    for (const [key, frame] of Object.entries(objOr(state.frames))) {
        if (!isObject(frame)) continue;
        relinkFailed(frame, failed);
        frames[key] = frame;
    }
    Object.assign(w, {
        vars: objOr(state.vars), form: objOr(state.form), item: state.item, index: state.index, value: state.value,
        params: objOr(state.params), lastResult: unbox(state.lastResult),
        executed: typeof state.executed === 'number' ? state.executed : 0,
        callChain: Array.isArray(state.callChain) ? state.callChain.map(String) : [],
        deferred: Array.isArray(state.deferred) ? state.deferred.filter(isObject) : [],
        failed, resume: { path: state.cursor, frames, outcome },
    });
    if (isObject(state.error)) w.error = state.error;
    if (isObject(state.trigger)) w.trigger = state.trigger;
    return true;
}

/** Mark `w` paused at a step. The walk ends like a budget stop: no try catches it, no finally runs. */
export function markPaused(w: WalkState, paused: PausedWalk): void {
    w.paused = paused;
    w.stopped = `${paused.path} paused`;
    w.truncated = true;
}

// ── The paused step ─────────────────────────────────────────────────────────

/** The step a walk paused at, ended by the resume: its result (as a step that ran), or a failure. */
export async function completeResumed(api: StepApi, fr: Frame, step: Step, ev: StepEvent, at: { startedAt: number; outcome: ResumeOutcome }): Promise<void> {
    const { w } = fr;
    const { startedAt, outcome } = at;
    w.resume = null;
    if ('error' in outcome) {
        const res: StepResult = { ok: false, error: outcome.error, code: outcome.code, retryable: false };
        return api.failOrHandle(fr, step, ev, { res, attempts: 1, startedAt, extra: {} });
    }
    const result = outcome.result ?? null;
    if (typeof step.resultVar === 'string' && step.resultVar) w.vars = { ...w.vars, [step.resultVar]: result };
    w.lastResult = result;
    return api.record(fr, ev, { status: 'ok', result }, startedAt);
}

/** Why a step that asked to pause cannot, or null. */
function pauseRefusal(fr: Frame): { error: string; code: string } | null {
    if (!fr.host.canPause) return { error: 'This step has to wait, which only an action that runs on the server can do', code: 'pause_unsupported' };
    if (fr.parallel) return { error: 'A step that has to wait cannot run inside a branch of a parallel step', code: 'not_in_parallel' };
    return null;
}

/** A leaf asked to pause: take the snapshot and stop the walk there, or fail the step when that cannot be. */
export async function pauseAt(api: StepApi, fr: Frame, step: Step, ev: StepEvent, f: Failure): Promise<void> {
    const { w, host } = fr;
    const request = f.res.pause ?? {};
    let denied = pauseRefusal(fr);
    let state: Obj = {};
    if (!denied) {
        try {
            state = snapshotWalk(w, ev.path);
            denied = host.acceptPause ? await host.acceptPause(request, state, ev) : null;
        } catch {
            denied = { error: 'The run could not be put on hold', code: 'pause_state_invalid' };
        }
    }
    if (denied) return api.failOrHandle(fr, step, ev, { ...f, res: { ok: false, error: denied.error, code: denied.code, retryable: false } });
    markPaused(w, { path: ev.path, kind: ev.kind, ordinal: ev.ordinal, ownerActionId: ev.ownerActionId, request, state });
}
