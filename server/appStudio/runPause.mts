/**
 * The pause API of a server run: how a step implementation says "wait here".
 *
 * A step's executor returns one of these instead of a result:
 *
 *   return pauseUntil(Date.now() + 3_600_000);            // go on in an hour, result null
 *   return pauseUntil(when, { result: { waited: true } });
 *   return pauseUntilResumed({ kind: 'approval', ref: approvalId, until: deadline });
 *   const { token, hash } = newResumeToken();
 *   return pauseUntilResumed({ tokenHash: hash });        // hand `token` to whoever continues it
 *
 * The walker stops at the step and the host (backgroundRun.mts) stores where the run was. It
 * goes on when:
 *   - the wake time passes (jobs/studioAppRunWake.js): the step ends with `result` /
 *     `timeoutResult`; a pause that waits for something (a kind or a token) and gives no
 *     `timeoutResult` ends the step as a failure with code `pause_expired`, which its onError
 *     handler or an enclosing try can take;
 *   - server code resumes it: backgroundRun.resumeBackgroundRun(runId, { by: 'system', waitKind,
 *     waitRef, payload }); the payload is the step's result. backgroundRun.resumeWaiting(kind,
 *     ref, payload) does that for every run that waits for the pair;
 *   - the holder of the token posts it (POST …/actions/jobs/:jobId/resume): the payload is the
 *     step's result.
 * Exactly one resume wins; the others are told the run was already resumed.
 *
 * Only an action that runs on the server (`runOn: 'server'` or `background: true`) can pause:
 * anywhere else the step fails with `pause_unsupported` (the executor does not let a wait out
 * unless the host's context says `canPause`, actionExecutor/dispatch.js; a walker host that
 * cannot pause refuses it too), and inside a branch of a parallel step with `not_in_parallel`. The limits are the operator's (backgroundRunPolicy.mts): the longest
 * wait, the paused runs per app, the size of the stored state.
 *
 * A resume token is 32 random bytes; only its sha256 is stored, the comparison is constant-time
 * and the resume that uses it clears it.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PauseRequest, StepResult } from './sequenceWalkTypes.mts';

const TOKEN_PREFIX = 'srt_';
const HASH_RE = /^[a-f0-9]{64}$/;
export const MAX_WAIT_KIND_LEN = 40;
export const MAX_WAIT_REF_LEN = 200;

const toMs = (when: number | Date): number => (when instanceof Date ? when.getTime() : when);

/** Wait until `when` (epoch ms or a Date); the step then ends with `opts.result` (null when left out). */
export function pauseUntil(when: number | Date, opts: { result?: unknown } = {}): StepResult {
    return { ok: true, pause: { until: toMs(when), timeoutResult: opts.result ?? null } };
}

/**
 * Wait until something resumes the run: server code that names (`kind`, `ref`), or the holder of
 * a token. `until` bounds the wait; with `timeoutResult` the step then ends with that result,
 * without it the step fails with `pause_expired`.
 */
export function pauseUntilResumed(opts: { kind?: string; ref?: string; tokenHash?: string; until?: number | Date | null; timeoutResult?: unknown }): StepResult {
    const pause: PauseRequest = {
        ...(opts.kind ? { kind: opts.kind } : {}), ...(opts.ref ? { ref: opts.ref } : {}),
        ...(opts.tokenHash ? { tokenHash: opts.tokenHash } : {}),
        ...(opts.until !== undefined && opts.until !== null ? { until: toMs(opts.until) } : {}),
        ...(opts.timeoutResult !== undefined ? { timeoutResult: opts.timeoutResult } : {}),
    };
    return { ok: true, pause };
}

export function hashResumeToken(token: string): string {
    return createHash('sha256').update(`studio-run-resume:${token}`).digest('hex');
}

/** A new resume token and the hash a pause stores. The token itself is never stored or logged. */
export function newResumeToken(): { token: string; hash: string } {
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('hex')}`;
    return { token, hash: hashResumeToken(token) };
}

export const isTokenHash = (v: unknown): v is string => typeof v === 'string' && HASH_RE.test(v);

/** True when `token` is the one `hash` was made from. Constant-time; anything malformed is false. */
export function resumeTokenMatches(token: unknown, hash: string | null): boolean {
    if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX) || token.length > 200 || !isTokenHash(hash)) return false;
    const given = Buffer.from(hashResumeToken(token), 'hex');
    const stored = Buffer.from(hash, 'hex');
    return given.length === stored.length && timingSafeEqual(given, stored);
}
