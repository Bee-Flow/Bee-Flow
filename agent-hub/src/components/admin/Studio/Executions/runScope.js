/**
 * runScope — WHOSE runs the executions surface is showing (Track H2).
 *
 * Not to be confused with `scope` ('global' | 'automation' | 'step'), which
 * says WHICH runs: all of them, one routine's, one Step's. This module answers
 * the other question, and it only ever has two answers:
 *
 *   'mine'  the default, everywhere, always. GET /_runs/recent — the routes
 *           that are user-scoped by contract.
 *   'org'   the whole organisation's run log. GET /_runs/org, which 403s
 *           without the manage_automations permission and 403s again for an
 *           account that belongs to no organisation.
 *
 * It is a separate module, and pure, because the three rules below are the
 * ones a review of this stage will come looking for, and a rule buried in a
 * 500-line component is a rule nobody can test on its own.
 *
 * ── The three rules ──────────────────────────────────────────────────────
 *
 * 1. UNKNOWN NARROWS. `normaliseRunScope` answers 'mine' for undefined, null,
 *    a typo, a number, a stale value out of localStorage — for everything
 *    that is not exactly the string 'org'. The failure this prevents is not
 *    hypothetical: a persisted filter blob is attacker-adjacent state that
 *    outlives a permission, and the widening direction must never be the one
 *    a bad value falls in.
 *
 * 2. ONLY THE GLOBAL SURFACE HAS TWO SCOPES. A per-routine or per-Step
 *    executions tab is already scoped to one object the caller owns, and
 *    `effectiveRunScope` forces 'mine' there. Without that, an 'org' left in
 *    storage by the Studio section would follow the user into the builder and
 *    fetch a list the builder's own automationId filter would then narrow —
 *    quietly turning "this routine's runs" into "this routine's runs by
 *    anyone".
 *
 * 3. A ROW IS OPENABLE ONLY WHEN IT SAYS IT IS MINE. Every per-run route
 *    (GET /runs/:id, retry, cancel, approve) is scoped to the run's own owner
 *    and 403s for anybody else — including an org admin. So in the org scope
 *    `canOpenRun` requires `mine === true`: not "not false", not "truthy".
 *    An absent field is a server that did not say, and a server that did not
 *    say is not permission.
 */

/** The two values, in the order the switch renders them. */
export const RUN_SCOPES = Object.freeze(['mine', 'org']);

/**
 * Anything at all → 'mine' | 'org'. The only input that yields 'org' is the
 * exact string 'org'; see rule 1.
 */
export function normaliseRunScope(value) {
    return value === 'org' ? 'org' : 'mine';
}

/**
 * The scope a surface may actually use: 'org' is available on the global
 * executions view only (rule 2). `scope` is the surface's own
 * 'global' | 'automation' | 'step'.
 */
export function effectiveRunScope(scope, runScope) {
    return scope === 'global' ? normaliseRunScope(runScope) : 'mine';
}

/**
 * May this row be opened? In the org scope only a row the server stamped as
 * the caller's own; in the personal scope every row, because the endpoint
 * that produced it returned nothing else (rule 3).
 */
export function canOpenRun(run, runScope) {
    if (normaliseRunScope(runScope) !== 'org') return true;
    return run?.mine === true;
}

/**
 * Live updates only reach the personal scope.
 *
 * The SSE stream (`/_runs/stream`) drops every event whose userId is not the
 * subscriber's, and its polling fallback reads /_runs/recent — also the
 * caller's own runs. Left enabled in the org scope, both would keep the
 * viewer's OWN rows ticking inside a list of everybody's and leave the rest
 * frozen: a half-live list that looks live, which is worse than one that
 * plainly is not. So the stream stands down, and the surface says so.
 */
export function runStreamEnabled(runScope) {
    return normaliseRunScope(runScope) !== 'org';
}
