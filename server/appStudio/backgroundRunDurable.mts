/**
 * A server run on hold: what a pause stores, what it may ask for, and how a resume ends the
 * step it paused at. Pure; backgroundRun.mts does the reading and writing around it.
 *
 * A step pauses through runPause.mts. The run row then turns `paused` and carries the record
 * built here (studio_app_action_runs.paused_state): the walk (sequenceWalkPause.mts), what the
 * resume compares or carries on (backgroundRunIdentity.mts RunMeta) and what the wake time
 * means. Nothing of it lives in a process, so a restart loses nothing: the wake job
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

import { MAX_WAIT_KIND_LEN, MAX_WAIT_REF_LEN, isTokenHash } from './runPause.mts';
import { limitLabel } from './backgroundRunPolicy.mts';
import type { BackgroundLimits } from './backgroundRunPolicy.mts';
import type { RunMeta } from './backgroundRunIdentity.mts';
import type { Obj, PauseRequest, ResumeOutcome } from './sequenceWalkTypes.mts';

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** What the run row stores while the run is on hold. */
export type PausedRecord = {
    v: 1; walk: Obj; run: RunMeta;
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

/** Why the host does not take this pause, or null. The step then fails with the code (its onError or a try can take it). */
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

export function pausedRecord(walk: Obj, run: RunMeta, request: PauseRequest, wake: { expire: boolean }): PausedRecord {
    const withResult = !wake.expire && Object.hasOwn(request, 'timeoutResult');
    return { v: 1, walk, run, wake: { expire: wake.expire, ...(withResult ? { timeoutResult: request.timeoutResult ?? null } : {}) } };
}

/** A stored record read back, or null when it is not one. */
export function readPausedRecord(state: unknown): PausedRecord | null {
    if (!isObject(state) || state.v !== 1 || !isObject(state.walk) || !isObject(state.run)) return null;
    const run = state.run;
    if (typeof run.fingerprint !== 'string' || !run.fingerprint) return null;
    const wake = isObject(state.wake) ? state.wake : {};
    return {
        v: 1, walk: state.walk,
        run: {
            fingerprint: run.fingerprint, role: typeof run.role === 'string' ? run.role : null,
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

/** `progress.waitingFor` of a run on hold: a small display object the step gave (who decides), or nothing. */
export function waitingForOf(request: PauseRequest): { waitingFor: Obj } | Record<string, never> {
    const w = request.waitingFor;
    if (!isObject(w) || typeof w.kind !== 'string') return {};
    const text = JSON.stringify(w);
    return text.length <= 400 ? { waitingFor: w } : { waitingFor: { kind: w.kind } };
}

/** `progress.waiting` of a run on hold: what it waits for ('approval'), 'resume' for a token, else 'timer'. */
export function waitingLabel(request: PauseRequest): string {
    const { waitKind, tokenHash } = waitOf(request);
    return waitKind ?? (tokenHash ? 'resume' : 'timer');
}
