/**
 * The reaper's half of an approval's EXPIRED BRANCH (edgeLabels.mts ON_EXPIRED_LABEL).
 *
 * The reaper closes every run whose approval passed its deadline in one claim
 * (automationStore.reapExpiredApprovals: of two reapers, one flips a run). Each
 * closed run comes here next, with the approval step it was waiting on:
 *
 *   - the definition the run is pinned to (resume.js automationToResume) has an
 *     'on_expired' edge out of that step: the run continues along it, like a reject
 *     continues on 'on_rejected'. The approval step's output is
 *     `approvalOutput({ approved: false, expired: true })`, the paused run ends
 *     'success' ("Expired — continued on the expired branch"), its step row
 *     'expired', and its approval rows expire with a bell that says the run went on;
 *   - no such edge, no step, the definition cannot be read, or the continuation
 *     never started: the run stays closed exactly as the reaper left it, and the
 *     caller does what it always did (the run.failed event, the expiry bells).
 *
 * The dependencies are handed in (scheduler/reapers.js wires the real ones), so
 * this file imports nothing but the two pure model modules.
 */

import { ON_EXPIRED_LABEL, hasEdgeLabelled } from '../automationModel/edgeLabels.mts';
import { approvalOutput } from '../automationModel/approvalOutput.mts';

/** A run the reaper closed, as reapExpiredApprovals returns it. */
export type ReapedRun = { id: string; automationId: string; userId: string; awaitingStepId?: string | null };

type RunRow = { id: string; automationId: string; [key: string]: unknown };

export type ExpiryDeps = {
    getRun: (id: string) => Promise<RunRow | null>;
    /** resume.js automationToResume: the definition the run continues on. */
    automationToResume: (run: RunRow) => Promise<{ definition?: { edges?: unknown } | null } | null>;
    /** resume.js resumeFromStep. */
    resumeFromStep: (runId: string, stepId: string, options: {
        decision: Record<string, unknown>; continuesJourney: true; onRunCreated: (run: { id?: unknown } | null | undefined) => void;
    }) => Promise<{ id?: unknown } | null | undefined>;
    updateRun: (id: string, patch: Record<string, unknown>) => Promise<unknown>;
    closeAwaitingStepRow: (runId: string, stepId: string, fromStatus: string, toStatus: string) => Promise<unknown>;
    /** approvalLifecycle.js expireApprovalsForContinuedRun. */
    expireApprovalsOf: (runId: string) => Promise<unknown>;
    log: { warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
    now?: () => Date;
};

export const EXPIRED_BRANCH_SUMMARY = 'Expired — continued on the expired branch';

/** Does the run's pinned definition give its approval an expired branch? Any failure answers no. */
async function hasExpiredBranch(reaped: ReapedRun, deps: ExpiryDeps): Promise<RunRow | null> {
    if (!reaped.awaitingStepId) return null;
    try {
        const run = await deps.getRun(reaped.id);
        if (!run) return null;
        const automation = await deps.automationToResume(run);
        return hasEdgeLabelled(automation?.definition?.edges, reaped.awaitingStepId, ON_EXPIRED_LABEL) ? run : null;
    } catch (e) {
        deps.log.warn(`[ApprovalExpiry] run ${reaped.id}: could not read its definition, closed as expired (${(e as Error)?.message || 'error'})`);
        return null;
    }
}

/** Start the continuation; resolves with its run id as soon as it exists, null when it never started. */
function startContinuation(run: RunRow, stepId: string, decidedAt: string, deps: ExpiryDeps): Promise<string | null> {
    return new Promise((resolve) => {
        let settled = false;
        const done = (id: unknown) => {
            if (settled) return;
            settled = true;
            resolve(id ? String(id) : null);
        };
        const decision = approvalOutput({ approved: false, expired: true, decidedAt });
        Promise.resolve()
            .then(() => deps.resumeFromStep(run.id, stepId, { decision, continuesJourney: true, onRunCreated: (child) => done(child?.id) }))
            .then((child) => done(child?.id))
            .catch((e) => {
                deps.log.error(`[ApprovalExpiry] run ${run.id}: the expired branch did not continue (${(e as Error)?.message || 'error'})`);
                done(null);
            });
    });
}

/** One closed run: continued on its expired branch (true), or left closed (false). */
async function continueOne(reaped: ReapedRun, deps: ExpiryDeps): Promise<boolean> {
    const run = await hasExpiredBranch(reaped, deps);
    const stepId = reaped.awaitingStepId;
    if (!run || !stepId) return false;
    const decidedAt = (deps.now ? deps.now() : new Date()).toISOString();
    const childId = await startContinuation(run, stepId, decidedAt, deps);
    if (!childId) return false;
    const quietly = (what: string) => (e: unknown) => deps.log.warn(`[ApprovalExpiry] run ${run.id}: ${what} (${(e as Error)?.message || 'error'})`);
    await Promise.resolve().then(() => deps.updateRun(run.id, {
        status: 'success', error: null, errorClass: null, summary: EXPIRED_BRANCH_SUMMARY, finishedAt: decidedAt,
    })).catch(quietly('parent run not marked continued'));
    await Promise.resolve().then(() => deps.closeAwaitingStepRow(run.id, stepId, 'awaiting_approval', 'expired'))
        .catch(quietly('paused step row not closed'));
    await Promise.resolve().then(() => deps.expireApprovalsOf(run.id)).catch(quietly('approval rows not expired'));
    return true;
}

/**
 * Continue every reaped run whose approval has an expired branch; answer the
 * ones that stay closed, for the reaper to handle as it always did. Never throws.
 */
export async function continueOnExpiredBranches(reaped: ReapedRun[], deps: ExpiryDeps): Promise<ReapedRun[]> {
    const closed: ReapedRun[] = [];
    for (const r of Array.isArray(reaped) ? reaped : []) {
        let continued = false;
        try {
            continued = await continueOne(r, deps);
        } catch (e) {
            deps.log.error(`[ApprovalExpiry] run ${r.id}: ${(e as Error)?.message || 'error'}`);
        }
        if (!continued) closed.push(r);
    }
    return closed;
}
