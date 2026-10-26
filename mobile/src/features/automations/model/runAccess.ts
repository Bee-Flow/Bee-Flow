/**
 * Who may START a run (Run now, Run again, Run live).
 *
 * The decision is the server's (server/automation/access.js, mayStartRun): a
 * `view` share reads an automation and its runs but does not start them, and a
 * view share beside a run share still does. The server hands the answer over as
 * `canStart` on the automation and on a single run, so nothing here re-derives
 * it from a role. A payload without the field (an older server) is "not
 * known": the action stays, and the server refuses a start it should not allow
 * with `automation_run_forbidden` (core/api/errors.ts says that in words).
 */

export function mayStartRun(source: { canStart?: boolean } | null | undefined): boolean {
    return source?.canStart !== false;
}

/** The English fallback of `automations.run.viewOnlyHint`, a key the web client owns too. */
export const VIEW_ONLY_RUN_HINT = 'You can view this automation but not start it. Ask the owner for run access.';
