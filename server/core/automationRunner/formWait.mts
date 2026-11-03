/**
 * formWait.mts: how long a run paused on a form page waits for the visitor.
 *
 *   resolveFormWaitMs      the deadline (ms from now) of a paused form page.
 *                          Always finite: a visitor is waiting. An explicit
 *                          step.waitSeconds wins (clamped to 1 min .. 7 days);
 *                          otherwise 1 h, or, for a page due right after an
 *                          approval, AUTOMATION_FORM_WAIT_AFTER_DECISION_MS
 *   formWaitAfterDecisionMs that env value: unset or unreadable 7 days, 0 = the
 *                          step default (null)
 *   continuesFromApproval  the leg continued from a decision on an approval
 *                          step (ctx.resumedFromStepId, set by execution.js)
 *
 * A page due right after an approval: the visitor was told they could close
 * the page and will come back from the link we send (automation/formJourney.mts),
 * possibly days later, so one hour would reap the run before they return.
 *
 * Plain TypeScript that Node strips on load, importing nothing.
 */

type Env = Record<string, string | undefined>;

export const FORM_WAIT_DEFAULT_MS = 60 * 60_000;                       // 1 hour
export const FORM_WAIT_MIN_MS = 60_000;                                // 1 minute
export const FORM_WAIT_MAX_MS = 7 * 24 * 60 * 60_000;                  // 7 days
export const FORM_WAIT_AFTER_DECISION_DEFAULT_MS = 7 * 24 * 60 * 60_000; // 7 days

export function formWaitAfterDecisionMs(env: Env = process.env): number | null {
    const raw = env.AUTOMATION_FORM_WAIT_AFTER_DECISION_MS;
    if (raw === undefined || raw.trim() === '') return FORM_WAIT_AFTER_DECISION_DEFAULT_MS;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return FORM_WAIT_AFTER_DECISION_DEFAULT_MS;
    return n === 0 ? null : Math.max(FORM_WAIT_MIN_MS, Math.floor(n));
}

export function resolveFormWaitMs(
    step: { waitSeconds?: number | string | null } | null | undefined,
    { afterDecision = false, env = process.env }: { afterDecision?: boolean; env?: Env } = {},
): number {
    const secs = Number(step?.waitSeconds);
    if (Number.isFinite(secs) && secs > 0) return Math.min(FORM_WAIT_MAX_MS, Math.max(FORM_WAIT_MIN_MS, Math.round(secs) * 1000));
    const afterDecisionMs = afterDecision ? formWaitAfterDecisionMs(env) : null;
    return afterDecisionMs ?? FORM_WAIT_DEFAULT_MS;
}

export function continuesFromApproval(ctx: {
    resumedFromStepId?: string | null;
    definition?: { steps?: Array<{ id?: string; type?: string } | null> } | null;
} | null | undefined): boolean {
    const from = ctx?.resumedFromStepId;
    if (!from) return false;
    const steps = Array.isArray(ctx?.definition?.steps) ? ctx.definition.steps : [];
    return steps.some((s) => s?.id === from && s?.type === 'approval');
}
