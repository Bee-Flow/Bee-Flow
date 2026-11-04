/**
 * actionNormalise's repairs for the error-handling envelope of a step (onError /
 * retry). A step's onError is a HANDLER `{ steps, stop? }`; the effects object
 * `{ toast, navigateTo }` belongs to run_automation only, and on a record step it
 * is a shape the builder model still sends.
 */

type Obj = Record<string, unknown>;

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A step's onError in the handler shape { steps: [...] } (kept as it is). */
export function isStepHandler(h: unknown): h is Obj & { steps: unknown[] } {
    return isObject(h) && Array.isArray(h.steps);
}

/** onSuccess, or an onError that is an effects object rather than a step handler. */
export function hasEffects(step: Obj): boolean {
    return step.onSuccess !== undefined || (step.onError !== undefined && !isStepHandler(step.onError));
}

/**
 * The effects of a record step are now steps of the sequence (effectSteps): drop
 * onSuccess, and an onError that is not a step handler. An effects onError with a
 * toast becomes `{ steps: [toast], stop: true }` (the toast shows instead of the raw
 * failure, then the action ends, as the old effect meant); anything else is dropped.
 */
export function finishEffects(step: Obj, at: string, notes: string[]): void {
    delete step.onSuccess;
    const h = step.onError;
    if (h === undefined || isStepHandler(h)) return;
    const toast = isObject(h) && isObject(h.toast) ? h.toast : null;
    if (toast && typeof toast.message === 'string' && toast.message.trim()) {
        step.onError = { steps: [{ kind: 'toast', message: toast.message, tone: 'danger' }], stop: true };
        notes.push(`${at}: onError { toast } read as onError { steps: [toast], stop: true } — a step's onError holds steps.`);
        return;
    }
    notes.push(`${at}: onError dropped — the runner already toasts the real failure (a step's onError takes { steps: [...] }).`);
    delete step.onError;
}

/** The steps of a step's onError handler get the same repairs as any branch (`walk`). */
export function walkHandler(step: Obj, at: string, walk: (list: unknown[], at: string) => unknown[]): void {
    if (isStepHandler(step.onError)) step.onError = { ...step.onError, steps: walk(step.onError.steps, `${at}.onError.steps`) };
}

/**
 * A bare record action with a step handler or retry: those live on a sequence STEP,
 * so the caller wraps it as a one-step sequence (true, with a note). False when it
 * has neither, or has effects (effectSteps makes the sequence then).
 */
export function envelopeNeedsSequence(action: Obj, notes: string[]): boolean {
    if (hasEffects(action) || !(isStepHandler(action.onError) || action.retry !== undefined)) return false;
    notes.push('action: a record action with onError { steps } / retry read as a one-step sequence — the error handling belongs to the step.');
    return true;
}
