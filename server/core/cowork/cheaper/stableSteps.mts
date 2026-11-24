/**
 * Cheaper with age: once a week per item, an AI step that did the same work often enough is offered as a fixed step.
 *
 *   - WHICH STEPS. An `ai_step` of the approved plan WITHOUT tools (no app tools, no knowledge base, no agent) that
 *     ended well in at least MIN_RUNS runs of that approved plan. One per item per week, in turn when there are more.
 *   - WHAT HAPPENS. usecases/coworkProposals.mts `offerFixedStep` asks the amend mode to make that one step fixed,
 *     replays only that change on the past runs of the approved plan, and keeps the offer only when at least 95% of
 *     them come out the same. Anything less is dropped without a word: an offer is not a need.
 *   - LIMITS. Not while the organisation has made Cowork read-only, not while the item's or the organisation's AI
 *     budget is used up (../spendGate.mts), not while an offer of this item is open, at most one attempt per item per
 *     week (claimed in the store, so two servers agree).
 *
 * `start()` is called from boot (boot/startupJobs.js) with the use case that offers: requiring this module starts
 * nothing, and core does not reach into the application layer.
 */

import { createRequire } from 'node:module';
import type { Definition, ToolLookups } from '../plan/planTypes.mts';
import type { CoworkProposalsStore } from '../../../stores/coworkProposals.mts';
import type { RepairItem } from '../repairs/repairTriggers.mts';
import { aiToolsOf, stepsOf } from '../plan/planWalk.mts';
import { planViewOf } from '../plan/planView.mts';
import { runRefusalOf, type CoworkPolicy } from '../../entitlements/coworkPolicy.mts';

const nodeRequire = createRequire(import.meta.url);
const log = nodeRequire('../../../telemetry/log.js') as { info: (m: string) => void; warn: (m: string) => void };

/** Runs of the approved plan an AI step must have ended well in. */
export const MIN_RUNS = 10;
const WEEK_MS = 7 * 24 * 60 * 60_000;
/** How often the job looks for items whose week is up. */
const EVERY_MS = 6 * 60 * 60_000;
const PAGE = 200;

export interface StableStep { stepId: string; stepTitle: string; runs: number }
/** What offers the fixed step (usecases/coworkProposals.mts offerFixedStep); `bookOn` is the run its AI is booked on. */
export type OfferFixedStep = (item: RepairItem, step: StableStep & { bookOn: string | null }) => Promise<unknown>;

export interface CheaperDeps {
    proposals: Pick<CoworkProposalsStore, 'itemsWithApprovedPlan' | 'claimAttempt' | 'openProposalOf' | 'stepSuccessCounts' | 'lastRunFailures'>;
    getSchedule: (id: string) => Promise<RepairItem | null>;
    getApprovedPlan: (scheduleId: string) => Promise<{ id: string; definition: unknown } | null>;
    policyOf: (userId: string) => Promise<CoworkPolicy>;
    /** Throws when a budget is used up (../spendGate.mts assertSpendLeft). */
    spendLeft: (item: RepairItem) => Promise<void>;
    lookups: ToolLookups;
    now: () => Date;
}

function defaults(): CheaperDeps {
    const store = () => nodeRequire('../../../stores/coworkStore.js') as Pick<CheaperDeps, 'getSchedule' | 'getApprovedPlan'>;
    return {
        proposals: (nodeRequire('../../../stores/coworkProposals.mts') as typeof import('../../../stores/coworkProposals.mts')).coworkProposals(),
        getSchedule: (id) => store().getSchedule(id),
        getApprovedPlan: (id) => store().getApprovedPlan(id),
        policyOf: (userId) => (nodeRequire('../../entitlements/coworkPolicy.mts') as typeof import('../../entitlements/coworkPolicy.mts')).policyOfOwner(userId),
        spendLeft: (item) => (nodeRequire('../spendGate.mts') as typeof import('../spendGate.mts')).assertSpendLeft(item),
        lookups: (nodeRequire('../plan/planLookups.mts') as typeof import('../plan/planLookups.mts')).toolLookups(),
        now: () => new Date(),
    };
}

/** The AI steps of a plan that use no tool and ended well in at least MIN_RUNS runs, the most runs first. */
export function stableAiSteps(definition: Definition | null | undefined, counts: Record<string, number>, lookups: ToolLookups): StableStep[] {
    const titles = new Map(planViewOf(definition, lookups).steps.map((s) => [s.id, s.title]));
    return stepsOf(definition)
        .filter((w) => w.type === 'ai_step' && aiToolsOf(w.step).length === 0 && !w.step.agentId
            && !(Array.isArray(w.step.knowledgeBaseIds) && w.step.knowledgeBaseIds.length > 0) && (counts[w.id] ?? 0) >= MIN_RUNS)
        .map((w) => ({ stepId: w.id, stepTitle: titles.get(w.id) ?? w.id, runs: counts[w.id] ?? 0 }))
        .sort((a, b) => b.runs - a.runs || a.stepId.localeCompare(b.stepId));
}

export type Looked = 'no_plan' | 'read_only' | 'budget' | 'none' | 'open' | 'tried_this_week' | 'offered';

/** The week number since the epoch: which of several steady steps gets its turn. */
const weekOf = (now: Date): number => Math.floor(now.getTime() / WEEK_MS);

/** Look at one item: offer one of its steady AI steps as a fixed step, when everything allows it. */
export async function lookAtItem(itemId: string, offer: OfferFixedStep, deps: CheaperDeps = defaults()): Promise<Looked> {
    const item = await deps.getSchedule(itemId);
    const plan = item?.planId && item.isActive !== false ? await deps.getApprovedPlan(item.id) : null;
    if (!item || !plan) return 'no_plan';
    if (runRefusalOf(await deps.policyOf(item.userId))) return 'read_only';
    try { await deps.spendLeft(item); } catch { return 'budget'; }
    const steady = stableAiSteps(plan.definition as Definition, await deps.proposals.stepSuccessCounts(item.id, plan.id), deps.lookups);
    if (steady.length === 0) return 'none';
    if (await deps.proposals.openProposalOf(item.id, 'fixed_step')) return 'open';
    const now = deps.now();
    if (!(await deps.proposals.claimAttempt(item.id, 'fixed_step', now, WEEK_MS))) return 'tried_this_week';
    const step = steady[weekOf(now) % steady.length] as StableStep;
    const [latest] = await deps.proposals.lastRunFailures(item.id, 1);
    await offer(item, { ...step, bookOn: latest?.runId ?? null });
    return 'offered';
}

/** One pass over every item with an approved plan. Answers how many were offered something to look at. */
export async function weeklyPass(offer: OfferFixedStep, deps: CheaperDeps = defaults()): Promise<number> {
    let looked = 0;
    let after: string | null = null;
    for (;;) {
        const page = await deps.proposals.itemsWithApprovedPlan(PAGE, after);
        for (const id of page) {
            try {
                if ((await lookAtItem(id, offer, deps)) === 'offered') looked += 1;
            } catch (e) {
                log.warn(`[Cowork] the steady steps of ${id} were not looked at: ${(e as Error).message}`);
            }
        }
        if (page.length < PAGE) return looked;
        after = page[page.length - 1] ?? null;
    }
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Look every six hours for items whose week is up. Answers whether this start started it. */
export function start(offer: OfferFixedStep, deps?: CheaperDeps): boolean {
    if (timer) return false;
    const pass = () => { weeklyPass(offer, deps).catch((e: Error) => log.warn(`[Cowork] the steady-step pass failed: ${e.message}`)); };
    timer = setInterval(pass, EVERY_MS);
    timer.unref?.();
    log.info('[Cowork] steady-step offers started');
    return true;
}

/** Stop looking (shutdown, tests). */
export function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
}
