/**
 * Steps a plan has to include (the enterprise split). Pure; the hooks that
 * read the viewer's entitlements are in ./usePlanLocks.ts.
 *
 * Mirrors server/automation/licensedSteps.js, which is the real gate: going
 * live, publishing and test runs are refused there with a 403 that names the
 * step. This only makes the builder say so BEFORE someone builds a routine
 * around a step it cannot run:
 *
 *   - the palette offers the step inert, with the reason (stepPalette.gated);
 *   - a step of that kind already on the canvas carries a lock chip
 *     (nodes/PlanLockChip.tsx), because it may be live and running, and it
 *     may not;
 *   - the Privacy Shield editor will not switch a step INTO a locked kind.
 *
 * `untokenize` ("Show real values again") is never locked: it only puts values
 * back, and a routine that already hid them must always be able to.
 */

import type { TranslateFn } from '../../../../hooks/useTranslation';

export const PRIVACY_STEPS = 'automation_privacy_steps';
export const APPROVALS = 'approvals';

/** Step kind (payload.kind / step.type) → the capability it needs. */
export const PLAN_CAPABILITY_BY_KIND: Readonly<Record<string, string>> = Object.freeze({
    guard: PRIVACY_STEPS,
    tokenize: PRIVACY_STEPS,
    approval: APPROVALS,
});

/** Capability id → the sentence that explains the lock. Only locked ones are present. */
export type PlanLocks = Readonly<Record<string, string>>;

export const NO_LOCKS: PlanLocks = Object.freeze({});

interface CatalogWithLocks { planLocks?: PlanLocks | null }

/** The capability a step kind needs, or null. */
export function capabilityForKind(kind: unknown): string | null {
    if (typeof kind !== 'string') return null;
    return Object.prototype.hasOwnProperty.call(PLAN_CAPABILITY_BY_KIND, kind) ? PLAN_CAPABILITY_BY_KIND[kind] : null;
}

/** Why a step of this kind cannot be added here, or null when it can. */
export function planLockReason(kind: unknown, catalog: CatalogWithLocks | null | undefined): string | null {
    const cap = capabilityForKind(kind);
    if (!cap) return null;
    const reason = catalog?.planLocks?.[cap];
    return typeof reason === 'string' && reason ? reason : null;
}

/**
 * The step catalog with the plan's locks riding on it, so every palette
 * surface that already receives the catalog (ribbon, add-step menus, loop
 * bodies, "Fits after") sees them without a new prop. A catalog that has not
 * loaded stays null: callers read a non-null catalog as "loaded". Nothing to
 * add and nothing to take away answers the same object.
 */
export function withPlanLocks<T extends object>(catalog: T | null | undefined, locks: PlanLocks): (T & CatalogWithLocks) | null {
    if (!catalog) return null;
    const had = (catalog as CatalogWithLocks).planLocks;
    if (!Object.keys(locks).length && !had) return catalog;
    return { ...catalog, planLocks: locks };
}

type LockReasonFn = (id: string) => string | null;

/** The sentence for one capability's lock: `not_granted` is an admin's switch, anything else the plan. */
export function lockSentence(capability: string, reason: string, t: TranslateFn): string {
    const disabled = reason === 'not_granted';
    if (capability === APPROVALS) {
        return disabled
            ? t('automation.plan.approval_disabled', 'Approvals are switched off for your organisation. Ask an administrator to switch them on.')
            : t('automation.plan.approval_locked', 'Approvals are part of the Enterprise plan. A routine with an approval step cannot go live without it.');
    }
    return disabled
        ? t('automation.plan.privacy_disabled', 'Privacy Shield steps are switched off for your organisation. Ask an administrator to switch them on. Steps that are already live keep running.')
        : t('automation.plan.privacy_locked', 'Privacy Shield steps are part of the Enterprise plan. Steps that are already live keep running.');
}

/**
 * The locks as the entitlements answer them. Only a real answer locks: while
 * they load, or when they failed, nothing is locked and the server has the
 * last word (the rule useSharingLocked follows).
 */
export function planLocksFrom(
    ent: { lockReason?: LockReasonFn; loading?: boolean; error?: unknown } | null | undefined,
    t: TranslateFn,
): PlanLocks {
    if (!ent || ent.loading || ent.error || typeof ent.lockReason !== 'function') return NO_LOCKS;
    const out: Record<string, string> = {};
    for (const cap of [PRIVACY_STEPS, APPROVALS]) {
        const reason = ent.lockReason(cap);
        if (reason != null) out[cap] = lockSentence(cap, reason, t);
    }
    return Object.keys(out).length ? Object.freeze(out) : NO_LOCKS;
}
