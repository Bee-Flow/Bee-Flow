/**
 * The decision side of `await_approval` (componentSpecs/steps/await_approval.js): a run on hold
 * waits for (kind 'approval', ref <approval id>), and this module continues it.
 *
 *   continueWaitingRuns  called by automation/approvalHooks.runOnDecidedHook, which every final
 *                        transition of an approval passes through (a decision, a panel or stage
 *                        that resolved, a withdraw, an expiry by the reaper or at decide time).
 *                        The decision becomes the waiting step's result. Who may decide is the
 *                        existing approval gate (canDecide), checked when they decide; of two
 *                        resumes of one run exactly one wins (backgroundRun's compare-and-set).
 *   settleDueWait        the wake job reached a run that waits for an approval (its timeout, or
 *                        the longest wait the operator allows). A decision that is already there
 *                        continues the run with it (a lost nudge costs nothing); an approval still
 *                        open is closed as expired first, so nobody decides a question whose run
 *                        has moved on.
 *   releaseWait          the run that asked will not wait any more (cancelled, refused before it
 *                        could go on hold): its open request is withdrawn.
 *
 * Only rows an await_approval step made are touched (source 'app', stepId AWAIT_STEP_ID, the
 * same app). Nothing here throws: a failure is logged with ids only, and the timer stays the
 * backstop of every nudge.
 */

import { createRequire } from 'node:module';
import type { ActionRunRow } from '../stores/studioAppData/actionRuns.mts';

const nodeRequire = createRequire(import.meta.url);

type Obj = Record<string, unknown>;

/** The `stepId` an await_approval request carries: how the decision side knows a run waits for it. */
export const AWAIT_STEP_ID = 'await_approval';
export const APPROVAL_WAIT = 'approval';

export type ApprovalRow = Obj & {
    id: string; status?: string; source?: string | null; stepId?: string | null; studioAppId?: string | null; isTest?: boolean;
    decisionReason?: string | null; answers?: Obj | null; decidedBy?: string | null; decidedByName?: string | null; decidedAt?: string | Date | null;
};

/** What the decision side reads and writes; the real stores and services by default, a fake in tests. */
export type ApprovalWaitDeps = {
    getApproval: (id: string) => Promise<ApprovalRow | null>;
    expire: (approval: ApprovalRow) => Promise<ApprovalRow | null>;
    withdraw: (approval: ApprovalRow, reason: string) => Promise<unknown>;
    resumeWaiting: (kind: string, ref: string, payload: unknown) => Promise<unknown[]>;
    log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };
};

export type StepDecision = {
    decision: string; reason: string | null; answers: Obj | null;
    decidedBy: string | null; decidedByName: string | null; decidedAt: string | null; approvalId: string;
};

const FINAL = ['approved', 'rejected', 'expired', 'cancelled'];
const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : text(v));

/** True for a row an await_approval step asked with (never a test approval). */
export function isAwaitedApproval(approval: unknown): approval is ApprovalRow {
    return isObject(approval) && typeof approval.id === 'string' && approval.source === 'app'
        && approval.stepId === AWAIT_STEP_ID && approval.isTest !== true;
}

/** The step's result for a final approval row. */
export function decisionOf(approval: ApprovalRow): StepDecision {
    return {
        decision: String(approval.status), reason: text(approval.decisionReason), answers: isObject(approval.answers) ? approval.answers : null,
        decidedBy: text(approval.decidedBy), decidedByName: text(approval.decidedByName), decidedAt: iso(approval.decidedAt), approvalId: approval.id,
    };
}

/** The step's result when its timeout passes without a decision. */
export function expiredDecision(approvalId: string): StepDecision {
    return { decision: 'expired', reason: null, answers: null, decidedBy: null, decidedByName: null, decidedAt: null, approvalId };
}

// Required when called, so a caller that hands in its own deps loads none of these.
const store = (): Obj & Record<string, (...a: unknown[]) => Promise<never>> => nodeRequire('../stores/automationStore');

function defaultDeps(): ApprovalWaitDeps {
    return {
        getApproval: (id) => store().getApproval(id),
        expire: async (approval) => {
            const automationStore = store();
            const flipped = await automationStore.decideApproval(approval.id, { status: 'expired', decidedBy: null });
            if (!flipped) return null;
            await automationStore.appendApprovalAudit({ approvalId: approval.id, decidedBy: null, decision: 'expired', source: 'app' }).catch(() => {});
            nodeRequire('../automation/approvalEvents').dispatchApprovalDecided(flipped);
            // The hook writes the app's record and, through continueWaitingRuns, continues the run.
            await nodeRequire('../automation/approvalHooks').runOnDecidedHook(flipped);
            return flipped;
        },
        withdraw: (approval, reason) => nodeRequire('../automation/approvalService').withdraw({ approval, deciderId: null, reason, source: 'app' }),
        resumeWaiting: (kind, ref, payload) => (nodeRequire('./backgroundRun.mts') as { resumeWaiting: ApprovalWaitDeps['resumeWaiting'] }).resumeWaiting(kind, ref, payload),
        log: nodeRequire('../telemetry/log'),
    };
}

const withDeps = (given: Partial<ApprovalWaitDeps>): ApprovalWaitDeps => ({ ...defaultDeps(), ...given });

/** An approval reached a final status: every run that waits for it goes on with the decision. */
export async function continueWaitingRuns(approval: unknown, given: Partial<ApprovalWaitDeps> = {}): Promise<number> {
    if (!isAwaitedApproval(approval) || !FINAL.includes(String(approval.status))) return 0;
    const deps = withDeps(given);
    try {
        const out = await deps.resumeWaiting(APPROVAL_WAIT, approval.id, decisionOf(approval));
        return out.filter((r) => isObject(r) && r.ok === true).length;
    } catch (e) {
        deps.log.warn(`[StudioApprovalWait] approval ${approval.id}: the waiting run was not continued (${(e as Error)?.name || 'error'}); the wake job will`);
        return 0;
    }
}

/**
 * The wake job reached `row`, a run waiting for an approval whose time is up. True when this
 * continued the run (with the decision there is, or by closing the request as expired); false
 * leaves it to the timer (no such approval: the step then ends as its pause said).
 */
export async function settleDueWait(row: ActionRunRow, given: Partial<ApprovalWaitDeps> = {}): Promise<boolean> {
    if (row.waitKind !== APPROVAL_WAIT || !row.waitRef) return false;
    const deps = withDeps(given);
    try {
        let approval = await deps.getApproval(row.waitRef);
        if (!isAwaitedApproval(approval) || approval.studioAppId !== row.appId) return false;
        if (approval.status === 'pending') {
            const expired = await deps.expire(approval);
            // Lost the race to a decider: read the decision they made.
            approval = expired ?? await deps.getApproval(row.waitRef);
            if (expired) return true;
        }
        if (!isAwaitedApproval(approval) || !FINAL.includes(String(approval.status))) return false;
        await deps.resumeWaiting(APPROVAL_WAIT, approval.id, decisionOf(approval));
        return true;
    } catch (e) {
        deps.log.warn(`[StudioApprovalWait] run ${row.id}: its approval could not be read (${(e as Error)?.name || 'error'}); the timer ends the wait`);
        return false;
    }
}

/** The run of `appId` that waited for (kind, ref) will not go on: withdraw the request it asked. */
export async function releaseWait(appId: string, waitKind: unknown, waitRef: unknown, reason: string, given: Partial<ApprovalWaitDeps> = {}): Promise<boolean> {
    if (waitKind !== APPROVAL_WAIT || typeof waitRef !== 'string' || !waitRef) return false;
    const deps = withDeps(given);
    try {
        const approval = await deps.getApproval(waitRef);
        if (!isAwaitedApproval(approval) || approval.studioAppId !== appId || approval.status !== 'pending') return false;
        await deps.withdraw(approval, reason);
        deps.log.info(`[StudioApprovalWait] approval ${approval.id} withdrawn: its run will not wait for it`);
        return true;
    } catch (e) {
        deps.log.warn(`[StudioApprovalWait] approval ${String(waitRef).slice(0, 80)} could not be withdrawn (${(e as Error)?.name || 'error'})`);
        return false;
    }
}
