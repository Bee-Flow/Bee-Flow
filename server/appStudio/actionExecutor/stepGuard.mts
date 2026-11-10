/**
 * App Studio action executor — the `guard` of a server step (schema version 3).
 *
 * A formula the SERVER works out before it runs the step, in the step's own server scope. Truthy: the step
 * runs. Anything else (false, nothing, a formula that cannot be worked out, a guard that is not a string):
 * the step is skipped, which is the closed side. A skipped step answers ok with a null result, so the
 * sequence goes on, and says so (`skipped`, a note, a log line). It is never retried and its onError
 * handler does not run: nothing failed.
 *
 * This is the server-enforced counterpart of a condition step, which the browser decides.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { tryEvaluate } = nodeRequire('../../shared/expr/index.mjs') as { tryEvaluate: (expr: string, scope: unknown) => { value?: unknown } | null | undefined };
const log = nodeRequire('../../telemetry/log') as { info: (message: string, fields?: Record<string, unknown>) => void };

type Obj = Record<string, unknown>;

export const GUARD_SKIPPED_NOTE = 'Skipped: the guard of this step was false.';

/** True when the step may run: it has no guard, or its guard is truthy in `scope`. */
export function guardAllows(step: Obj, scope: unknown): boolean {
    const guard = step.guard;
    if (guard === undefined || guard === null) return true;
    if (typeof guard !== 'string') return false;
    if (!guard.trim()) return true; // an emptied formula box is no guard
    return !!tryEvaluate(guard, scope)?.value;
}

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

type Skipped = { ok: true; result: null; skipped: true; notes: string[] };
type Refused = { ok: false; error: string; retryable: false };

/**
 * The answer of a step its guard holds back, or null when the step may run.
 * `buildScope` is only called for a step that carries a guard.
 *
 * A transaction commits its children as one write, so a child is never run or skipped on its own: a child
 * that carries a guard (the validator refuses it at save time) stops the whole transaction here.
 */
export function guardSkip(app: { id?: unknown }, step: Obj, ctx: Obj, buildScope: (ctx: Obj) => unknown): Skipped | Refused | null {
    if (step.kind === 'transaction' && Array.isArray(step.steps) && step.steps.some((c) => isObject(c) && c.guard !== undefined && c.guard !== null)) {
        return { ok: false, error: 'A step inside a transaction cannot have its own guard. Put the guard on the transaction.', retryable: false };
    }
    if (step.guard === undefined || step.guard === null) return null;
    if (guardAllows(step, buildScope(ctx))) return null;
    log.info('[appStudio] step skipped by its guard', { appId: app.id ?? null, actionId: ctx.actionId ?? null, kind: step.kind });
    return { ok: true, result: null, skipped: true, notes: [GUARD_SKIPPED_NOTE] };
}
