/**
 * The executor of the `await_approval` step (componentSpecs/steps/await_approval.js): ask for an
 * approval, then put the run on hold until it is decided.
 *
 *   1. Only a host that can hold a run (a run on the server: its context says `canPause`) gets
 *      a request at all. Anywhere else the step fails first, so nobody is asked a question no
 *      run waits for. A test run never gets here (its decision is mocked, mcpRunHost.mts); a
 *      dry run that does is answered as approved without asking anybody.
 *   2. A timeout longer than the operator allows a run to wait fails before anything is asked.
 *   3. The request is the one request_approval makes (approvalStep.requestApprovalStep): the same
 *      licence gate, the cap on open requests, the deciders and their checks, the notifications.
 *      Its deadline is the step's timeout, and it carries AWAIT_STEP_ID, which is how the decision
 *      side (approvalWaits.mts) knows a run waits for it.
 *   4. The step answers with a pause on (approval, id), bounded by the deadline: the decision
 *      (or 'expired' at the deadline) becomes the step's result when the run goes on.
 *
 * Never throws: every failure is `{ ok: false, error, code, retryable }`.
 */

import { createRequire } from 'node:module';
import { pauseUntilResumed } from '../../runPause.mts';
import { backgroundLimits, limitLabel } from '../../backgroundRunPolicy.mts';
import type { BackgroundLimits } from '../../backgroundRunPolicy.mts';
import { APPROVAL_WAIT, AWAIT_STEP_ID, expiredDecision } from '../../approvalWaits.mts';
import type { ApprovalRow } from '../../approvalWaits.mts';
import type { StepResult } from '../../sequenceWalkTypes.mts';

const nodeRequire = createRequire(import.meta.url);

type Obj = Record<string, unknown>;

/** Who decides, as the run tray shows it while the run waits. Names only, never an address. */
export type WaitingFor = { kind: 'user' | 'group'; name: string | null } | { kind: 'panel' | 'stages'; count: number } | { kind: 'owner' };

export type AwaitDeps = {
    request: (app: unknown, model: unknown, step: Obj, ctx: Obj, opts: { stepId: string }) => Promise<StepResult>;
    getApproval: (id: string) => Promise<ApprovalRow | null>;
    userName: (id: string) => Promise<string | null>;
    groupName: (id: string) => Promise<string | null>;
    limits: () => BackgroundLimits;
};

const MAX_TIMEOUT_HOURS = 720;
const HOUR_MS = 3_600_000;
const fail = (error: string, code: string): StepResult => ({ ok: false, error, code, retryable: false });
const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

function defaultDeps(): AwaitDeps {
    const users = () => nodeRequire('../../../stores/userStore') as { getUser: (id: string) => Promise<Obj | null>; getGroup: (id: string) => Promise<Obj | null> };
    const name = (row: Obj | null, ...keys: string[]): string | null => {
        for (const k of keys) if (row && typeof row[k] === 'string' && row[k]) return String(row[k]).slice(0, 120);
        return null;
    };
    return {
        request: (app, model, step, ctx, opts) => nodeRequire('../approvalStep').requestApprovalStep(app, model, step, ctx, opts),
        getApproval: (id) => nodeRequire('../../../stores/automationStore').getApproval(id),
        userName: async (id) => name(await users().getUser(id), 'displayName', 'username'),
        groupName: async (id) => name(await users().getGroup(id), 'name'),
        limits: () => backgroundLimits(),
    };
}

/** The step's timeout in whole hours, 0 for none. */
function timeoutHoursOf(step: Obj): number {
    const n = Number(step.timeoutHours);
    return Number.isInteger(n) && n > 0 ? Math.min(n, MAX_TIMEOUT_HOURS) : 0;
}

/** Who decides the request, for the run tray. A lookup that fails says less, never fails the step. */
export async function waitingForOf(approval: ApprovalRow | null, deps: Pick<AwaitDeps, 'userName' | 'groupName'>): Promise<WaitingFor> {
    if (!approval) return { kind: 'owner' };
    if (Array.isArray(approval.stages) && approval.stages.length) return { kind: 'stages', count: approval.stages.length };
    if (Array.isArray(approval.approvers) && approval.approvers.length) return { kind: 'panel', count: approval.approvers.length };
    const lookup = async (fn: (id: string) => Promise<string | null>, id: unknown): Promise<string | null> => {
        try { return typeof id === 'string' && id ? await fn(id) : null; } catch { return null; }
    };
    if (approval.assigneeUserId) return { kind: 'user', name: await lookup(deps.userName, approval.assigneeUserId) };
    if (approval.assigneeGroupId) return { kind: 'group', name: await lookup(deps.groupName, approval.assigneeGroupId) };
    return { kind: 'owner' };
}

/** The request_approval step this step asks with: its own fields, the timeout as the request's deadline. */
function requestOf(step: Obj, hours: number): Obj {
    const { timeoutHours: _timeout, resultVar: _resultVar, ...ask } = step;
    return { ...ask, kind: 'request_approval', expiresInHours: hours };
}

export async function runAwaitApproval(app: unknown, model: unknown, step: Obj, ctx: Obj, given: Partial<AwaitDeps> = {}): Promise<StepResult> {
    if (ctx.dryRun === true) {
        return { ok: true, result: { ...expiredDecision('dry-run'), decision: 'approved' }, notes: ['dryRun: nobody was asked; the step went on as approved'] };
    }
    if (ctx.canPause !== true) {
        return fail('Waiting for an approval needs an action that runs on the server (runOn: "server" or background: true)', 'pause_unsupported');
    }
    const deps = { ...defaultDeps(), ...given };
    const hours = timeoutHoursOf(step);
    const limits = deps.limits();
    if (hours && limits.maxPauseMs && hours * HOUR_MS > limits.maxPauseMs) {
        return fail(`A run can wait at most ${Math.floor(limits.maxPauseMs / HOUR_MS)} hours (${limitLabel(limits, 'maxPauseMs')}); timeoutHours is ${hours}`, 'pause_too_long');
    }
    const asked = await deps.request(app, model, requestOf(step, hours), ctx, { stepId: AWAIT_STEP_ID });
    if (!asked.ok) return asked;
    const handle = isObject(asked.result) ? asked.result : {};
    const approvalId = typeof handle.approvalId === 'string' ? handle.approvalId : '';
    if (!approvalId) return fail('The approval could not be created', 'approval_failed');
    const deadline = typeof handle.expiresAt === 'string' ? Date.parse(handle.expiresAt) : NaN;
    let approval: ApprovalRow | null = null;
    try { approval = await deps.getApproval(approvalId); } catch { approval = null; }
    const paused = pauseUntilResumed({
        kind: APPROVAL_WAIT, ref: approvalId,
        ...(Number.isFinite(deadline) ? { until: deadline } : {}),
        timeoutResult: expiredDecision(approvalId),
    });
    return { ...paused, pause: { ...paused.pause, waitingFor: await waitingForOf(approval, deps) } };
}

export async function runStep(app: unknown, model: unknown, step: unknown, ctx: unknown): Promise<StepResult> {
    return runAwaitApproval(app, model, isObject(step) ? step : {}, isObject(ctx) ? ctx : {});
}
