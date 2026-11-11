/**
 * A server run on hold: what a pause stores, what it may ask for, and how a resume ends the
 * step it paused at. Pure; backgroundRun.mts does the reading and writing around it.
 *
 * A step pauses through runPause.mts. The run row then turns `paused` and carries the record
 * built here (studio_app_action_runs.paused_state): the walk (sequenceWalkPause.mts), the
 * actions the walk is in (actionsSnapshot), what the resume compares or carries on
 * (backgroundRunIdentity.mts RunMeta) and what the wake time means.
 *
 * THE SNAPSHOT. A run on hold continues on the steps it paused in, also when the app was
 * published again with that action edited in the meantime: a wait can last days (an approval),
 * and the stored position names a step of the action as it was. So the pause keeps the action
 * and every action reachable from it through call_action, as they are in the definition the run
 * walks. Every reachable action, not only the calls after the paused step: a loop round or a
 * handler can come back to a call that lies before it. Only the actions are kept. The data
 * model, the row rules, the role, the variables' declarations and the connections are read
 * fresh when the run goes on, so a step of the snapshot that names a table, field, connection
 * or automation that is gone fails as that step always does (its onError or a try can take it).
 * A kind the install no longer knows ends the run as refused (unknownStepKind). Nothing of it lives in a process, so a restart loses nothing: the wake job
 * (jobs/studioAppRunWake.js), a server-side resume or the holder of the resume token continues
 * the run on any instance. The store's compare-and-set lets exactly one of them win.
 *
 * The record is personal data at rest (form values, variables, loop rows). It leaves the row in
 * the statement that resumes or cancels the run, and with every other end of it; a pause that
 * outlives the run retention is ended and cleared by the retention job.
 *
 * Operator limits (backgroundRunPolicy.mts, 0 = unlimited): STUDIO_APP_PAUSE_MAX_MS (the longest
 * one wait), STUDIO_APP_PAUSED_PER_APP, STUDIO_APP_PAUSE_STATE_MAX_BYTES.
 */

import { createRequire } from 'node:module';
import { childStepSlots } from '../shared/appDefinition/stepFlow.mjs';
import { closeOverCalls, ownAction } from './actionCalls.mts';
import { MAX_WAIT_KIND_LEN, MAX_WAIT_REF_LEN, isTokenHash } from './runPause.mts';
import { limitLabel } from './backgroundRunPolicy.mts';
import type { BackgroundLimits } from './backgroundRunPolicy.mts';
import type { RunMeta } from './backgroundRunIdentity.mts';
import type { Obj, PauseRequest, ResumeOutcome } from './sequenceWalkTypes.mts';

const nodeRequire = createRequire(import.meta.url);
const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const MAX_NESTING = 16;

/** What the run row stores while the run is on hold. */
export type PausedRecord = {
    v: 1; walk: Obj; run: RunMeta;
    /** The action the run is in and every action it can call, by id, as the run walks them. */
    actions: Obj;
    /** When the wake time passes: the step fails with `pause_expired`, or ends with `timeoutResult`. */
    wake: { expire: boolean; timeoutResult?: unknown };
};

/** Who resumes a run: the wake job, server code that names what the run waits for, or the holder of its token. */
export type ResumeBy =
    | { by: 'timer' }
    | { by: 'system'; waitKind: string; waitRef: string; payload?: unknown }
    | { by: 'token'; appId: string; userId: string; token: string; payload?: unknown };

export type Refusal = { error: string; code: string };

const short = (v: unknown, max: number): string | null => (typeof v === 'string' && v && v.length <= max ? v : null);

/** What a pause waits for, as the row's columns. */
export function waitOf(request: PauseRequest): { waitKind: string | null; waitRef: string | null; tokenHash: string | null } {
    return { waitKind: short(request.kind, MAX_WAIT_KIND_LEN), waitRef: short(request.ref, MAX_WAIT_REF_LEN), tokenHash: isTokenHash(request.tokenHash) ? request.tokenHash : null };
}

/**
 * When the wake job looks at the run, and what that means. A pause with a time continues then;
 * one without is ended by the longest wait the operator allows (never, when that is unlimited).
 */
export function wakePlan(request: PauseRequest, now: number, limits: BackgroundLimits): { wakeAt: number | null; expire: boolean } {
    const until = typeof request.until === 'number' && Number.isFinite(request.until) ? request.until : null;
    const { waitKind, tokenHash } = waitOf(request);
    const waitsForSomething = !!waitKind || !!tokenHash;
    if (until === null) return { wakeAt: limits.maxPauseMs ? now + limits.maxPauseMs : null, expire: true };
    return { wakeAt: until, expire: waitsForSomething && !Object.hasOwn(request, 'timeoutResult') };
}

/**
 * The actions a run of `actionId` needs to go on, out of the `actions` it walks: the action
 * itself and every action reachable from it through call_action, as plain JSON.
 */
export function actionsSnapshot(actions: unknown, actionId: string): Obj {
    const out: Obj = {};
    for (const id of [...closeOverCalls(actions, [actionId])].sort()) {
        const action = ownAction(actions, id);
        if (action) out[id] = action;
    }
    return JSON.parse(JSON.stringify(out)) as Obj;
}

function kindsIn(list: unknown, depth: number, seen: Set<string>): void {
    if (!Array.isArray(list) || depth > MAX_NESTING) return;
    for (const step of list) {
        if (!isObject(step)) continue;
        seen.add(String(step.kind));
        for (const slot of childStepSlots(step)) kindsIn(slot.steps, depth + 1, seen);
    }
}

/** Every kind a step or a bare action can have today (the catalogue with its extensions). */
function kindsOfToday(): string[] {
    const specs = nodeRequire('./componentSpecs') as { STEP_KINDS: readonly string[]; ACTION_KINDS: readonly string[] };
    return [...specs.STEP_KINDS, ...specs.ACTION_KINDS];
}

/**
 * A step kind in a snapshot that this install does not know (a kind that was withdrawn, or a
 * snapshot written by a later version before a roll back), or null.
 */
export function unknownStepKind(actions: Obj, known: readonly string[] = kindsOfToday()): string | null {
    const seen = new Set<string>();
    for (const action of Object.values(actions)) {
        if (!isObject(action)) continue;
        // A bare action is its own single step.
        kindsIn(action.kind === 'sequence' ? action.steps : [action], 1, seen);
    }
    return [...seen].find((kind) => !known.includes(kind)) ?? null;
}

/**
 * Why the host does not take this pause, or null. The step then fails with the code (its onError
 * or a try can take it). `state` is everything the row would store: the walk and the actions.
 */
export function pauseRefusal(request: PauseRequest, state: Obj, now: number, limits: BackgroundLimits): Refusal | null {
    const { waitKind, tokenHash } = waitOf(request);
    const until = typeof request.until === 'number' && Number.isFinite(request.until) ? request.until : null;
    const malformed = (request.kind && !waitKind) || (request.ref && !waitOf(request).waitRef) || (request.tokenHash && !tokenHash);
    if (malformed || (until === null && !waitKind && !tokenHash)) {
        return { error: 'The step asked to wait without saying until when or for what', code: 'pause_invalid' };
    }
    if (until !== null && limits.maxPauseMs && until - now > limits.maxPauseMs) {
        return { error: `A step can wait at most ${Math.round(limits.maxPauseMs / 3_600_000)} hours (${limitLabel(limits, 'maxPauseMs')})`, code: 'pause_too_long' };
    }
    if (limits.pauseStateMaxBytes && Buffer.byteLength(JSON.stringify(state), 'utf8') > limits.pauseStateMaxBytes) {
        return { error: `The run holds too much data to be put on hold (${limitLabel(limits, 'pauseStateMaxBytes')}). Keep less in variables, or wait before a large loop instead of inside it`, code: 'pause_state_too_large' };
    }
    return null;
}

/** The refusal when the app already has as many runs on hold as it may. */
export function pausedCapRefusal(paused: number, limits: BackgroundLimits): Refusal | null {
    if (!limits.pausedPerApp || paused < limits.pausedPerApp) return null;
    return { error: `This app already has ${paused} runs on hold (limit ${limits.pausedPerApp}, ${limitLabel(limits, 'pausedPerApp')})`, code: 'pause_limit' };
}

export function pausedRecord(kept: { walk: Obj; actions: Obj }, run: RunMeta, request: PauseRequest, wake: { expire: boolean }): PausedRecord {
    const withResult = !wake.expire && Object.hasOwn(request, 'timeoutResult');
    return { v: 1, walk: kept.walk, actions: kept.actions, run, wake: { expire: wake.expire, ...(withResult ? { timeoutResult: request.timeoutResult ?? null } : {}) } };
}

/** A stored record read back, or null when it is not one. */
export function readPausedRecord(state: unknown): PausedRecord | null {
    if (!isObject(state) || state.v !== 1 || !isObject(state.walk) || !isObject(state.run) || !isObject(state.actions)) return null;
    const run = state.run;
    const wake = isObject(state.wake) ? state.wake : {};
    return {
        v: 1, walk: state.walk, actions: state.actions,
        run: {
            role: typeof run.role === 'string' ? run.role : null,
            activeMs: typeof run.activeMs === 'number' && run.activeMs > 0 ? run.activeMs : 0,
            written: Array.isArray(run.written) ? run.written.filter((n): n is string => typeof n === 'string') : [],
        },
        wake: { expire: wake.expire === true, ...(Object.hasOwn(wake, 'timeoutResult') ? { timeoutResult: wake.timeoutResult } : {}) },
    };
}

/** How the paused step ends for this resume. */
export function resumeOutcome(how: ResumeBy, record: PausedRecord): ResumeOutcome {
    if (how.by !== 'timer') return { result: how.payload ?? null };
    if (record.wake.expire) return { error: 'Nothing continued the run before its wait ended', code: 'pause_expired' };
    return { result: record.wake.timeoutResult ?? null };
}

/** `progress.waiting` of a run on hold: what it waits for ('approval'), 'resume' for a token, else 'timer'. */
export function waitingLabel(request: PauseRequest): string {
    const { waitKind, tokenHash } = waitOf(request);
    return waitKind ?? (tokenHash ? 'resume' : 'timer');
}
