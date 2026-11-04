/**
 * App Studio validator — the error-handling envelope of a sequence step:
 * `onError: { steps, stop? }` (its steps are validated like any branch, one level
 * deeper and counted, with `error` in scope) and `retry: { times, delayMs? }`.
 * Which kinds may carry them is the step spec's business (componentSpecs/
 * stepEnvelope.js); a field a kind does not take is `action.step_unknown_field`.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { LIMITS } = nodeRequire('../componentSpecs/limits.js') as {
    LIMITS: { MAX_STEP_RETRY_TIMES: number; MAX_STEP_RETRY_DELAY_MS: number; DEFAULT_STEP_RETRY_DELAY_MS: number };
};

type Obj = Record<string, unknown>;
type Finding = { code: string; severity: string; path: string; message: string; hint: string };
type Ctx = { pushE: (f: Finding) => void; inErrorHandler?: boolean } & Obj;
type Counter = { n: number; reported: boolean; top?: unknown };
type Walk = {
    depth: number; counter: Counter; ctx: Ctx;
    validateActionSteps: (steps: unknown, path: string, depth: number, counter: Counter, ctx: Ctx) => void;
};

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** `fsType` is 'errorHandler' or 'retry'. */
export function validateEnvelopeField(fsType: string, value: unknown, path: string, walk: Walk): void {
    if (fsType === 'retry') validateRetry(value, path, walk.ctx);
    else validateErrorHandler(value, path, walk);
}

function validateErrorHandler(value: unknown, path: string, walk: Walk): void {
    const { ctx } = walk;
    if (!isObject(value) || !Array.isArray(value.steps)) {
        ctx.pushE({ code: 'action.on_error_invalid', severity: 'error', path, message: 'onError on a step takes { steps: [...], stop?: true }.', hint: 'Put the fallback steps in onError.steps; a message is a toast step inside it.' });
        return;
    }
    const extra = Object.keys(value).filter((k) => k !== 'steps' && k !== 'stop');
    if (extra.length || (value.stop !== undefined && typeof value.stop !== 'boolean')) {
        ctx.pushE({ code: 'action.on_error_invalid', severity: 'error', path, message: `onError takes only steps and stop (true/false)${extra.length ? `; found ${extra.join(', ')}` : ''}.`, hint: 'Remove the other fields.' });
    }
    walk.validateActionSteps(value.steps, `${path}.steps`, walk.depth + 1, walk.counter, { ...ctx, inErrorHandler: true });
}

function validateRetry(value: unknown, path: string, ctx: Ctx): void {
    const bad = (message: string): void => ctx.pushE({
        code: 'action.retry_invalid', severity: 'error', path, message,
        hint: `Use { times: 1-${LIMITS.MAX_STEP_RETRY_TIMES}, delayMs: 0-${LIMITS.MAX_STEP_RETRY_DELAY_MS} } (delayMs defaults to ${LIMITS.DEFAULT_STEP_RETRY_DELAY_MS}).`,
    });
    if (!isObject(value)) { bad('retry must be { times, delayMs? }.'); return; }
    const extra = Object.keys(value).filter((k) => k !== 'times' && k !== 'delayMs');
    if (extra.length) bad(`retry takes only times and delayMs; found ${extra.join(', ')}.`);
    const { times, delayMs } = value;
    if (!Number.isInteger(times) || (times as number) < 0 || (times as number) > LIMITS.MAX_STEP_RETRY_TIMES) {
        bad(`retry.times is ${JSON.stringify(times)}; it must be a whole number from 0 to ${LIMITS.MAX_STEP_RETRY_TIMES} (LIMITS.MAX_STEP_RETRY_TIMES).`);
    }
    if (delayMs !== undefined && (!Number.isInteger(delayMs) || (delayMs as number) < 0 || (delayMs as number) > LIMITS.MAX_STEP_RETRY_DELAY_MS)) {
        bad(`retry.delayMs is ${JSON.stringify(delayMs)}; it must be a whole number of milliseconds from 0 to ${LIMITS.MAX_STEP_RETRY_DELAY_MS} (LIMITS.MAX_STEP_RETRY_DELAY_MS).`);
    }
}
