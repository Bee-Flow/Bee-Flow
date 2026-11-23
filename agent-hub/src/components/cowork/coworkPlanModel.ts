/**
 * What the plan card says, worked out from the plan the server sent. Pure: no fetching, no React.
 */
import type { PlanEffect, PlanPermissions, PlanState, PlanStepKind } from '../../api/coworkPlan.types';

/**
 * Where a plan stands:
 *   none      the item has no plan
 *   gone      it names an automation that no longer exists (or is no longer the owner's)
 *   blocked   the plan may not run as it is (nothing approved, or the approved plan itself): its findings say why
 *   first     a plan that was never approved
 *   changed   the plan differs from the approved one; runs still use the approved one (also when the change has
 *             findings: then it cannot be approved, and the findings say why)
 *   approved  the plan is exactly what was approved
 */
export type PlanStatus = 'none' | 'gone' | 'blocked' | 'first' | 'changed' | 'approved';

export function planStatusOf(state: PlanState): PlanStatus {
    if (!state.automationId) return 'none';
    if (!state.draft) return 'gone';
    if (state.draft.findings.length > 0) return state.approved && !state.upToDate ? 'changed' : 'blocked';
    if (state.upToDate) return 'approved';
    return state.approved ? 'changed' : 'first';
}

/** A plan its owner can approve now: there is one, nothing blocks it, and it is not already the approved one. */
export function canApprove(state: PlanState): boolean {
    const status = planStatusOf(state);
    return (status === 'first' || status === 'changed') && (state.draft?.findings.length ?? 0) === 0;
}

/** A plan that can be tried: there is one and nothing blocks it (an approved plan can be tried again too). */
export function canTry(state: PlanState): boolean {
    const status = planStatusOf(state);
    return (status === 'first' || status === 'changed' || status === 'approved') && (state.draft?.findings.length ?? 0) === 0;
}

/** The kinds in the order a person reads them, with how many steps of each; kinds without a step are left out. */
export function makeUpParts(makeUp: Record<PlanStepKind, number> | null | undefined): Array<{ kind: PlanStepKind; count: number }> {
    const order: PlanStepKind[] = ['fixed', 'ai', 'ask', 'deliver'];
    return order.map((kind) => ({ kind, count: makeUp?.[kind] ?? 0 })).filter((p) => p.count > 0);
}

/** An app id as a name: `google-drive` reads "Google drive". */
export function appLabel(app: string): string {
    const words = app.replaceAll('-', ' ').replaceAll('_', ' ').trim();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : app;
}

/** The apps a plan touches, per effect, each app once and in alphabetical order. */
export function appsByEffect(permissions: PlanPermissions | null | undefined): Record<PlanEffect, string[]> {
    const out: Record<PlanEffect, string[]> = { reads: [], writes: [], sends: [] };
    for (const grant of permissions?.grants ?? []) {
        const label = appLabel(grant.app);
        if (!out[grant.effect].includes(label)) out[grant.effect].push(label);
    }
    for (const effect of Object.keys(out) as PlanEffect[]) out[effect].sort((a, b) => a.localeCompare(b));
    return out;
}
