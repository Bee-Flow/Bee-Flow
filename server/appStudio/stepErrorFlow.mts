/**
 * Step retry and the `error` scope of a handler, for the server walker
 * (sequenceWalk.mts). The browser coordinator (agent-hub runtime/actionRunner/
 * sequence.ts) does the same with the same shared helpers (stepFlow.mjs).
 *
 *   attemptStep — runs one step, and again per its `retry` while the answer
 *                 says retrying can help (`retryable !== false`), waiting
 *                 `delayMs` in between, never past `stop()`.
 *   errorScopeOf — the `error` a handler reads: { message, step, code,
 *                 attempts, stepIndex? }, bounded like a /step body.
 */

import { clampErrorScope, retryPlanOf } from '../shared/appDefinition/stepFlow.mjs';
import type { StepResult } from './sequenceWalkTypes.mts';

export type AttemptOpts = {
    sleep: (ms: number) => Promise<void>;
    /** True when the walk must not start another attempt (budget, deadline, shutdown). */
    stop?: () => boolean;
};

/**
 * `once(attempt)` (1-based) until it succeeds, its answer is not retryable, the
 * step's retry plan is used up or `stop()` says so. Returns the last answer
 * and how many attempts ran.
 */
export async function attemptStep(step: unknown, once: (attempt: number) => Promise<StepResult>, opts: AttemptOpts): Promise<{ res: StepResult; attempts: number }> {
    const plan = retryPlanOf(step);
    let attempt = 1;
    let res = await once(attempt);
    while (!res.ok && res.retryable !== false && attempt <= plan.times && !(opts.stop && opts.stop())) {
        if (plan.delayMs > 0) await opts.sleep(plan.delayMs);
        if (opts.stop && opts.stop()) break;
        attempt += 1;
        res = await once(attempt);
    }
    return { res, attempts: attempt };
}

/** The `error` scope for a handler of a failed step. */
export function errorScopeOf(kind: string, res: { error?: string; code?: string }, attempts: number, stepIndex: number | null): Record<string, unknown> {
    return clampErrorScope({
        message: res.error || 'The step failed',
        step: kind,
        code: res.code ?? null,
        attempts,
        ...(stepIndex !== null ? { stepIndex } : {}),
    }) as Record<string, unknown>;
}
