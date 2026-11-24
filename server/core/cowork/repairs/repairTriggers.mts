/**
 * When Cowork works out a repair of a plan (usecases/coworkProposals.mts does the work), heard after every run:
 *
 *   - STEP FAILED TWICE. The same step of the approved plan failed in each of the item's last two runs, and both ran
 *     that approved plan. What is passed on is the step's id, its title as the approved plan names it, and the error
 *     CLASS the run recorded: never the error message (it can carry text from outside, a mail that made the step
 *     fail), and the message is not even read here (stores/coworkProposals.mts lastRunFailures selects no message).
 *   - GOAL UNDER TARGET. The item's goal was measured under its target in each of the last three measurements. What is
 *     passed on is the target and the three percentages.
 *
 * LIMITS, asked in this order, the claim last so a refused attempt does not use up the day: no open repair for the
 * item yet; the organisation has not made Cowork read-only (core/entitlements/coworkPolicy.mts runRefusalOf); neither
 * the item's nor the organisation's AI budget is used up (../spendGate.mts); at most one attempt per item per day,
 * claimed in the store so two servers agree. Its AI is booked on the run that set it off.
 *
 * Heard through ../runEnded.mts. `start()` is called from boot (boot/startupJobs.js) with the use case that proposes:
 * requiring this module starts nothing, and core does not reach into the application layer.
 */

import { createRequire } from 'node:module';
import type { Definition, ToolLookups } from '../plan/planTypes.mts';
import type { CoworkProposalsStore } from '../../../stores/coworkProposals.mts';
import type { CoworkGoalsStore } from '../../../stores/coworkGoals.mts';
import { planViewOf } from '../plan/planView.mts';
import { onRunEnded, type EndedItem } from '../runEnded.mts';
import { runRefusalOf, type CoworkPolicy } from '../../entitlements/coworkPolicy.mts';

const nodeRequire = createRequire(import.meta.url);
const log = nodeRequire('../../../telemetry/log.js') as { info: (m: string) => void; warn: (m: string) => void };

/** One attempt per item per this long. */
export const ATTEMPT_WINDOW_MS = 24 * 60 * 60_000;
/** Runs in a row the same step must have failed in. */
export const FAILED_RUNS = 2;
/** Measurements in a row the goal must have stayed under its target. */
export const UNDER_MEASUREMENTS = 3;

export type RepairTrigger =
    | { reasonCode: 'step_failed_twice'; runId: string; stepId: string; stepTitle: string; errorClass: string | null; runs: number }
    | { reasonCode: 'goal_under_target'; runId: string; targetPercent: number; percents: number[] };

export interface RepairItem { id: string; userId: string; title?: string | null; isActive?: boolean; planId?: string | null; planAutomationId?: string | null; monthlyBudget?: number | null }

/** What proposes the repair (usecases/coworkProposals.mts proposeRepair). */
export type ProposeRepair = (item: RepairItem, trigger: RepairTrigger) => Promise<unknown>;

export interface TriggerDeps {
    getSchedule: (id: string) => Promise<RepairItem | null>;
    getApprovedPlan: (scheduleId: string) => Promise<{ id: string; definition: unknown } | null>;
    proposals: Pick<CoworkProposalsStore, 'openProposalOf' | 'claimAttempt' | 'lastRunFailures'>;
    goals: Pick<CoworkGoalsStore, 'getGoal' | 'listResults'>;
    policyOf: (userId: string) => Promise<CoworkPolicy>;
    /** Throws when a budget is used up (../spendGate.mts assertSpendLeft). */
    spendLeft: (item: RepairItem) => Promise<void>;
    lookups: ToolLookups;
    now: () => Date;
}

function defaults(): TriggerDeps {
    const store = () => nodeRequire('../../../stores/coworkStore.js') as Pick<TriggerDeps, 'getSchedule' | 'getApprovedPlan'>;
    return {
        getSchedule: (id) => store().getSchedule(id),
        getApprovedPlan: (id) => store().getApprovedPlan(id),
        proposals: (nodeRequire('../../../stores/coworkProposals.mts') as typeof import('../../../stores/coworkProposals.mts')).coworkProposals(),
        goals: (nodeRequire('../../../stores/coworkGoals.mts') as typeof import('../../../stores/coworkGoals.mts')).coworkGoals(),
        policyOf: (userId) => (nodeRequire('../../entitlements/coworkPolicy.mts') as typeof import('../../entitlements/coworkPolicy.mts')).policyOfOwner(userId),
        spendLeft: (item) => (nodeRequire('../spendGate.mts') as typeof import('../spendGate.mts')).assertSpendLeft(item),
        lookups: (nodeRequire('../plan/planLookups.mts') as typeof import('../plan/planLookups.mts')).toolLookups(),
        now: () => new Date(),
    };
}

/** The step of the approved plan that failed in each of the last runs, all of them runs of that plan; else null. */
async function failedTwice(item: RepairItem, plan: { id: string; definition: unknown }, runId: string, deps: TriggerDeps): Promise<RepairTrigger | null> {
    const runs = await deps.proposals.lastRunFailures(item.id, FAILED_RUNS);
    if (runs.length < FAILED_RUNS || runs.some((r) => r.planId !== plan.id)) return null;
    const steps = planViewOf(plan.definition as Definition, deps.lookups).steps;
    const [newest, ...older] = runs;
    for (const failure of newest?.failed ?? []) {
        const step = steps.find((s) => s.id === failure.stepId);
        if (!step || !older.every((r) => r.failed.some((f) => f.stepId === failure.stepId))) continue;
        return { reasonCode: 'step_failed_twice', runId, stepId: step.id, stepTitle: step.title, errorClass: failure.errorClass, runs: runs.length };
    }
    return null;
}

/** The goal stayed under its target in each of the last measurements; else null. */
async function goalUnder(item: RepairItem, runId: string, deps: TriggerDeps): Promise<RepairTrigger | null> {
    const goal = await deps.goals.getGoal(item.id);
    if (!goal?.approvedDefinition) return null;
    const results = await deps.goals.listResults(item.id, UNDER_MEASUREMENTS);
    if (results.length < UNDER_MEASUREMENTS) return null;
    const percents: number[] = [];
    for (const r of results) {
        if (!r.ok || r.met === null || r.total === null || r.total <= 0) return null;
        percents.unshift(Math.round((r.met / r.total) * 100));
    }
    return percents.every((p) => p < goal.targetPercent) ? { reasonCode: 'goal_under_target', runId, targetPercent: goal.targetPercent, percents } : null;
}

/** What sets off a repair of this item after its run `runId`, or null. */
export async function repairTriggerOf(item: RepairItem, plan: { id: string; definition: unknown }, runId: string, deps: TriggerDeps): Promise<RepairTrigger | null> {
    return (await failedTwice(item, plan, runId, deps)) ?? goalUnder(item, runId, deps);
}

export type Checked = 'no_plan' | 'no_trigger' | 'open' | 'read_only' | 'budget' | 'tried_today' | 'proposed';

/** After a run of `ended` ended: does it need a repair, may one be worked out now, and if so, propose it. */
export async function checkAfterRun(ended: EndedItem, runId: string, propose: ProposeRepair, deps: TriggerDeps = defaults()): Promise<Checked> {
    const item = await deps.getSchedule(ended.id);
    const plan = item?.planId ? await deps.getApprovedPlan(item.id) : null;
    if (!item || !plan) return 'no_plan';
    const trigger = await repairTriggerOf(item, plan, runId, deps);
    if (!trigger) return 'no_trigger';
    if (await deps.proposals.openProposalOf(item.id, 'repair')) return 'open';
    if (runRefusalOf(await deps.policyOf(item.userId))) return 'read_only';
    try { await deps.spendLeft(item); } catch { return 'budget'; }
    if (!(await deps.proposals.claimAttempt(item.id, 'repair', deps.now(), ATTEMPT_WINDOW_MS))) return 'tried_today';
    await propose(item, trigger);
    log.info(`[Cowork] ${item.id}: a repair was worked out (${trigger.reasonCode})`);
    return 'proposed';
}

let stopListening: (() => void) | null = null;

/** Hear the runs that end, and propose with `propose`. A second start does nothing; answers whether this one started. */
export function start(propose: ProposeRepair, deps?: TriggerDeps): boolean {
    if (stopListening) return false;
    stopListening = onRunEnded((item, runId) => {
        setImmediate(() => {
            checkAfterRun(item, runId, propose, deps).catch((e: Error) => log.warn(`[Cowork] the repair check of ${item.id} failed: ${e.message}`));
        });
    });
    return true;
}

/** Stop hearing them (shutdown, tests). */
export function stop(): void {
    stopListening?.();
    stopListening = null;
}
