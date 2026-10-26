import type { TranslateFn } from '../../../hooks/useTranslation';

/**
 * Who may START a run (Run now, Run again, Run live).
 *
 * The decision is the server's (server/automation/access.js, mayStartRun): a
 * `view` share reads an automation and its runs but does not start them, and a
 * view share beside a run share still does. The server hands the answer over as
 * `canStart` on the automation, on the run list, on every run row and on a
 * single run, so nothing here re-derives it from `myRole`.
 *
 * A payload from a server that predates the field carries none: that is "not
 * known", and the action stays on offer. The server refuses a start it should
 * not allow with `automation_run_forbidden` either way (runStartRefusal).
 */

/** The error code of a refused run start. */
export const RUN_FORBIDDEN_CODE = 'automation_run_forbidden';

/** Does the payload say the caller may start a run? Unknown counts as yes. */
export function mayStartRun(source: { canStart?: boolean | null } | null | undefined): boolean {
    return source?.canStart !== false;
}

/** The sentence that goes where a start is not on offer, and on the refusal. */
export function viewOnlyRunHint(t: TranslateFn): string {
    return t('automations.run.viewOnlyHint', 'You can view this automation but not start it. Ask the owner for run access.');
}

/**
 * The friendly sentence for a refused run start, or null when the error is
 * anything else (the caller then keeps its own message).
 */
export function runStartRefusal(t: TranslateFn, e: unknown): string | null {
    const code = (e as { code?: unknown } | null | undefined)?.code;
    return code === RUN_FORBIDDEN_CODE ? viewOnlyRunHint(t) : null;
}
