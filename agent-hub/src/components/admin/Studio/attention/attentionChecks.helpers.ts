import { checkPermission } from '../../../../hooks/usePermissionCheck';
import type { AttentionBody, AttentionVerdict, AttentionCtx, AttentionGate, AttentionCheck } from './attentionChecks.types';
import { AVAILABILITY } from './attentionChecks.constants';

/**
 * May this check run for this person? Pure, and unit-tested on its own.
 *
 *   'ready'    no gate, or every gate answered yes
 *   'gated'    a gate answered no — the source is not this person's to see.
 *              Not a gap: nothing was lost that they could act on
 *   'unknown'  the gate could not be ANSWERED (no user object, no hasFeature).
 *              The check does not run and the caller names a gap, because
 *              unknown narrows — running it would be failing open on rights,
 *              and calling it empty would be failing open on the truth
 *
 * The last one is where this deliberately differs from actionChecks.js, whose
 * feature gate passes when the caller handed over no `hasFeature`. That is
 * harmless on a lesson checklist and is not harmless here.
 */
export function checkAvailability(check: { gate?: AttentionGate } | null | undefined, ctx: AttentionCtx = {}) {
    const gate = check?.gate;
    if (!gate) return AVAILABILITY.READY;
    if (gate.permission) {
        // checkPermission(null, …) answers false, which would make "nobody is
        // signed in yet" indistinguishable from "you may not". Ask first.
        if (!ctx.user || typeof ctx.user !== 'object') return AVAILABILITY.UNKNOWN;
        if (!checkPermission(ctx.user, gate.permission)) return AVAILABILITY.GATED;
    }
    if (gate.feature) {
        if (typeof ctx.hasFeature !== 'function') return AVAILABILITY.UNKNOWN;
        if (!ctx.hasFeature(gate.feature)) return AVAILABILITY.GATED;
    }
    return AVAILABILITY.READY;
}

/**
 * Run ONE entry to a verdict. NEVER THROWS — the three answers in order:
 *
 *   the gate says no        → gated: no rows, no gap, and no request
 *   the gate cannot answer  → a gap (unknown narrows)
 *   fetch or evaluate threw → a gap named after the check
 *
 * The same three, in the same order, as runSource in
 * server/routes/studio/attention.js. A check that hit a gap INSIDE itself
 * still returns the rows it did find: dropping them would lose real problems.
 */
export async function runCheck(id: string, check: AttentionCheck, ctx: AttentionCtx = {}) {
    const availability = checkAvailability(check, ctx);
    // Not this person's to see. No rows, no gap, and nothing asked of the
    // network: a check that may not run must not be run "just to be sure".
    if (availability === AVAILABILITY.GATED) {
        // `skipped: [id]`, not `[]`. A gated entry that reports nothing at all
        // vanishes without trace — no rows, no gap, no footnote — and
        // runAttentionChecks would then hand the screen a clean bill of health
        // for a check that never ran. The server pushes the same key onto
        // `gated[]` for exactly this reason.
        return { id, availability, findings: [], gaps: [], skipped: [id], truncated: 0, whole: true };
    }
    // The gate could not be answered. Also nothing asked — but this one IS a
    // gap, because nobody looked.
    if (availability === AVAILABILITY.UNKNOWN) {
        return { id, availability, findings: [], gaps: [`${id}:gate`], skipped: [], truncated: 0, whole: false };
    }
    try {
        const data = await check.fetchState(ctx);
        const verdict: Partial<AttentionVerdict> = check.evaluate(data as AttentionBody | null | undefined) || {};
        return {
            id,
            availability,
            findings: Array.isArray(verdict.findings) ? verdict.findings : [],
            gaps: (Array.isArray(verdict.unavailable) ? verdict.unavailable : []).map((label) => `${id}:${label}`),
            capped: Array.isArray(verdict.capped) ? verdict.capped : [],
            skipped: Array.isArray(verdict.skipped) ? verdict.skipped : [],
            truncated: typeof verdict.truncated === 'number' && Number.isFinite(verdict.truncated) ? Math.max(0, verdict.truncated) : 0,
            whole: verdict.complete === true,
        };
    } catch (err) {
        // Includes the 401/404/500 case: an endpoint that did not answer has
        // told us nothing, and nothing is not "nothing is wrong".
        return {
            id, availability: 'failed', error: (err as Error)?.message || 'fetch_failed',
            findings: [], gaps: [id], capped: [], skipped: [], truncated: 0, whole: false,
        };
    }
}
