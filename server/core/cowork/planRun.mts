/**
 * A Cowork item run AS ITS PLAN (executeTask in core/aiTaskRunner.js hands an item with an approved plan here): the
 * third run mode, next to a plain prompt and a run as an agent.
 *
 * What runs is the plan AS IT WAS APPROVED (stores/coworkPlans.mts keeps that copy), on the automation runner. The
 * automation the plan was made from only lends its identity (its owner, its organisation, the row its run history
 * hangs on): its own definition of the moment is never read, so a change to it does nothing until its owner approves
 * it as the item's next plan.
 *
 * Before the runner starts, the three things that make "what was approved" true are checked again, at every run:
 *
 *   - the stored copy still has the fingerprint it was approved with (a row changed behind the plan's back);
 *   - it is still a plan Cowork runs (core/cowork/plan/planChecks.mts: the rules may be stricter than when it was
 *     approved);
 *   - the automation behind it still exists, still belongs to the item's owner, and is not managed by a Solution
 *     stage (./plan/planSource.mts).
 *
 * A run that fails one of them does not start, and says which. The runner then applies its own gates (the owner's
 * account and organisation, the run policy, the Privacy Shield), as for any automation.
 *
 * The run's own notifications are held to the owner (./plan/planRunCopy.mts): the automation's notification settings
 * are not used, so nothing about the run reaches another person or a shared room, and the owner hears once.
 */

import { createRequire } from 'node:module';
import type { Definition, PlanFinding, ToolLookups } from './plan/planTypes.mts';
import { checkPlan } from './plan/planChecks.mts';
import { planFingerprint } from './plan/planPermissions.mts';
import { planViewOf } from './plan/planView.mts';
import { toolLookups } from './plan/planLookups.mts';
import { runCopyOf } from './plan/planRunCopy.mts';
import { effectiveIndependence, withAsks } from './plan/planIndependence.mts';
import { sinceTriggerData } from './sinceLastTime.mts';
import { mayAskByLicence, type MayAsk } from './plan/planLicence.mts';
import { appsNotAllowed, capLevel, policyOfOwner, type CoworkPolicy } from '../entitlements/coworkPolicy.mts';
import { permissionsOf, BUILT_IN_APP } from './plan/planPermissions.mts';
import { runMaxMs } from './runDeadline.mts';
import { isManagedByStage, planSourceOf, type SourceRow } from './plan/planSource.mts';
import { claimAttempt, type ClaimStore } from './runClaim.mts';

const nodeRequire = createRequire(import.meta.url);
const log = nodeRequire('../../telemetry/log') as { info: (msg: string) => void; error: (...a: unknown[]) => void };

export interface PlanTask {
    id: string;
    userId: string;
    title?: string;
    /** When the item last ran, and how that ended (the "since last time" of ./sinceLastTime.mts). */
    lastRunAt?: string | null;
    lastStatus?: string | null;
    [key: string]: unknown;
}

interface ApprovedPlan { id: string; automationId: string; definition: unknown; fingerprint: string }
type AutomationRow = SourceRow;
/** The terminal row the automation runner answers with. */
export interface AutomationRunRow { id?: string; status?: string; summary?: string | null; error?: string | null; lastOutput?: unknown }

export interface PlanRunStore extends ClaimStore {
    getApprovedPlan: (scheduleId: string) => Promise<ApprovedPlan | null>;
    linkPlanRun: (runId: string | null, link: { planId: string; automationRunId?: string | null; independence?: string | null }) => Promise<unknown>;
    markCompleted: (id: string, result: string, close?: { runId?: string | null; waiting?: boolean }) => Promise<unknown>;
}

export interface PlanRunDeps {
    /** The failure path both other run modes use (core/aiTaskRunner.js failRun): mark, move on, notify. */
    failRun: (task: PlanTask, err: Error, opts: { manual: boolean; store: PlanRunStore; close?: { runId?: string | null } }) => Promise<unknown>;
    /** Move the schedule on after a run that finished (core/aiTaskRunner.js advanceAfterTaskRun). */
    advance: (task: PlanTask, opts: { manual: boolean; store: PlanRunStore; startTime: number }) => Promise<unknown>;
    NOTIFICATION: { category: string; link: string | null; prefix: string };
    getAutomation?: (id: string) => Promise<AutomationRow | null>;
    /** The automation is managed by a Solution stage (./plan/planSource.mts). */
    isManaged?: (automation: AutomationRow) => Promise<boolean>;
    executeAutomation?: (automation: AutomationRow, opts: Record<string, unknown>) => Promise<AutomationRunRow | null | undefined>;
    createNotification?: (n: Record<string, unknown>) => Promise<unknown>;
    lookups?: ToolLookups;
    /** Approvals are in the owner's licence: a level that asks needs them (./plan/planIndependence.mts). */
    mayAsk?: MayAsk;
    /** The owner's organisation's Cowork policy (../entitlements/coworkPolicy.mts). */
    policyOf?: (userId: string) => Promise<CoworkPolicy>;
}

/** A plan that may not run as it is: the owner has to look at it. */
export class PlanRefusedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PlanRefusedError';
    }
}

const PAUSED: ReadonlySet<string> = new Set(['awaiting_approval', 'awaiting_form', 'awaiting_confirm']);
const TEXT_KEYS = ['body', 'text', 'message', 'content'];

/** The message a result step delivered (its output is { delivered: { title, body } }), else the output itself. */
function messageOf(out: unknown): unknown {
    const delivered = out && typeof out === 'object' ? (out as { delivered?: unknown }).delivered : undefined;
    return delivered && typeof delivered === 'object' ? delivered : out;
}

/**
 * What the run produced, in words: the text of its last step when it has one (the message a result step delivered
 * included), else the runner's summary.
 */
export function resultTextOf(row: AutomationRunRow | null | undefined): string {
    const out = messageOf(row?.lastOutput);
    if (typeof out === 'string' && out.trim()) return out;
    if (out && typeof out === 'object') {
        for (const key of TEXT_KEYS) {
            const value = (out as Record<string, unknown>)[key];
            if (typeof value === 'string' && value.trim()) return value;
        }
    }
    return typeof row?.summary === 'string' && row.summary.trim() ? row.summary : 'Done.';
}

function firstFinding(findings: PlanFinding[]): string {
    return findings[0]?.message ?? '';
}

/** The approved plan, if it may still run; throws PlanRefusedError with the reason when it may not. */
async function runnablePlan(task: PlanTask, store: PlanRunStore, lookups: ToolLookups, source: { getAutomation: NonNullable<PlanRunDeps['getAutomation']>; isManaged: NonNullable<PlanRunDeps['isManaged']> }) {
    const plan = await store.getApprovedPlan(task.id);
    if (!plan) throw new PlanRefusedError('This item has no approved plan any more.');
    const definition = plan.definition as Definition;
    if (planFingerprint(definition) !== plan.fingerprint) {
        throw new PlanRefusedError('The stored plan is not the one that was approved. Approve the plan again.');
    }
    const findings = checkPlan(definition, lookups);
    if (findings.length > 0) {
        throw new PlanRefusedError(`This plan may not run as it is: ${firstFinding(findings)} Change the plan and approve it again.`);
    }
    const automation = await planSourceOf(plan.automationId, task.userId, source);
    if (!automation) {
        throw new PlanRefusedError('The automation behind this plan is gone or is no longer yours. Make a new plan for this item.');
    }
    return { plan, definition, automation };
}

function defaults(deps: PlanRunDeps) {
    return {
        getAutomation: deps.getAutomation ?? ((id: string) => (nodeRequire('../../stores/automationStore') as { getAutomation: (id: string) => Promise<AutomationRow | null> }).getAutomation(id)),
        isManaged: deps.isManaged ?? isManagedByStage,
        executeAutomation: deps.executeAutomation ?? ((a: AutomationRow, o: Record<string, unknown>) => (nodeRequire('../automationRunner') as { executeAutomation: (a: AutomationRow, o: Record<string, unknown>) => Promise<AutomationRunRow> }).executeAutomation(a, o)),
        createNotification: deps.createNotification ?? ((n: Record<string, unknown>) => (nodeRequire('../../stores/notificationStore') as { createNotification: (n: Record<string, unknown>) => Promise<unknown> }).createNotification(n)),
        lookups: deps.lookups ?? toolLookups(),
        mayAsk: deps.mayAsk ?? mayAskByLicence,
        policyOf: deps.policyOf ?? ((userId: string) => policyOfOwner(userId)),
    };
}

/**
 * The level this run uses, under the organisation's ceiling; a level that asks, when asking is not possible, refuses
 * the run, and so does an app the organisation does not let run unattended.
 */
async function levelOf(task: PlanTask, automation: AutomationRow, definition: Definition, d: ReturnType<typeof defaults>) {
    const policy = await d.policyOf(task.userId);
    const blocked = appsNotAllowed(permissionsOf(definition, d.lookups).grants.map((g) => g.app).filter((a) => a !== BUILT_IN_APP), policy);
    if (blocked.length > 0) throw new PlanRefusedError(`Your organisation does not let ${blocked.join(', ')} run while nobody watches, so this plan did not run.`);
    const asks = await d.mayAsk({ userId: task.userId, organizationId: (automation as { organizationId?: string | null }).organizationId ?? null });
    try {
        const chosen = effectiveIndependence(task.independence, asks);
        return effectiveIndependence(capLevel(chosen, policy.ceiling), asks);
    } catch (e) {
        throw new PlanRefusedError((e as Error).message);
    }
}

/** How a run the runner handed back ended, for Cowork: the text of its outcome, or a throw when it did not finish. */
function outcomeOf(row: AutomationRunRow | null | undefined): { text: string; paused: boolean } {
    const status = row?.status ?? 'error';
    if (PAUSED.has(status)) {
        return { text: 'This run is waiting for a decision. It continues when you have decided, under Approvals.', paused: true };
    }
    if (status !== 'success') throw new Error(row?.error || row?.summary || 'The plan did not finish.');
    return { text: resultTextOf(row), paused: false };
}

/** Tell the owner what a run produced. A failed notification never fails the run. */
async function announce(task: PlanTask, text: string, deps: PlanRunDeps, createNotification: NonNullable<PlanRunDeps['createNotification']>): Promise<void> {
    try {
        await createNotification({
            userId: task.userId, taskId: task.id, category: deps.NOTIFICATION.category,
            title: `${deps.NOTIFICATION.prefix}${task.title ?? ''}`, message: text, link: deps.NOTIFICATION.link,
        });
    } catch (e) {
        log.error(`[AITaskRunner] could not notify about plan run of ${task.id}: ${(e as Error).message}`);
    }
}

/**
 * Run one item as its approved plan. `manual`: a person pressed Run now. `due`: the scheduler tick started this for a
 * due moment (the claim then asks that it still is, ./runClaim.mts).
 */
export async function executePlanRun(
    task: PlanTask,
    { manual = false, store, due = false }: { manual?: boolean; store: PlanRunStore; due?: boolean },
    deps: PlanRunDeps,
): Promise<void> {
    const startTime = Date.now();
    const d = defaults(deps);
    const attempt = await claimAttempt(store, task, { manual, due });
    if (!attempt) return;
    log.info(`[AITaskRunner] Executing ${task.id} as its plan`);
    try {
        const { plan, definition, automation } = await runnablePlan(task, store, d.lookups, d);
        // The level is kept on the run: after a pause the journey continues with the questions it started with.
        const independence = await levelOf(task, automation, definition, d);
        await store.linkPlanRun(attempt.runId, { planId: plan.id, independence });
        // A spread without the row's own copies: the runner executes exactly the definition handed in
        // (core/automationRunner/definitionForRun.js). 'manual' is its live production run.
        // The row's own time limit is held to Cowork's as well (./plan/planRunCopy.mts holds the run policy's).
        const limited = typeof automation.runTimeoutMs === 'number' ? { runTimeoutMs: Math.min(automation.runTimeoutMs, runMaxMs()) } : {};
        const row = await d.executeAutomation({ ...automation, ...limited, definition: runCopyOf(withAsks(definition, independence, d.lookups)) }, {
            triggerKind: 'manual',
            // "Only what is new since last time": {{trigger.output.since}} (./sinceLastTime.mts).
            triggerPayload: sinceTriggerData(task),
            mode: 'live',
            startedByUserId: task.userId,
            onRunCreated: (run: { id?: string }) => store.linkPlanRun(attempt.runId, { planId: plan.id, automationRunId: run?.id ?? null }),
        });
        const { text, paused } = outcomeOf(row);
        // The schedule moves on before the run closes: once the item stops saying 'running', a tick must not find
        // this moment still due. A run that waits for a decision closes as 'waiting' (./planRunFollowUp.mts).
        await deps.advance(task, { manual, store, startTime });
        await store.markCompleted(task.id, text, { runId: attempt.runId, waiting: paused });
        // A plan that ends in a result for its owner has delivered it itself; one that does not, or that stopped
        // before its result step, is announced here.
        if (paused || planViewOf(definition, d.lookups).makeUp.deliver === 0) await announce(task, text, deps, d.createNotification);
    } catch (caught) {
        const err = caught instanceof Error ? caught : new Error(String(caught));
        log.error(`[AITaskRunner] Plan run of ${task.id} failed:`, err.message);
        await deps.failRun(task, err, { manual, store, close: { runId: attempt.runId } });
    }
}
