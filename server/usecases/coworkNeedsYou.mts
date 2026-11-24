/**
 * "Needs you": everything in Cowork that waits for its owner, in one list (routes/coworkSideRoutes.js serves it; the
 * web app shows it at the top of Cowork, the phone and the daily mail read the same list).
 *
 *   decision   a plan run waits for the owner's decision (an approval step: decided under Approvals)
 *   review     an agent run asked the owner to look at something
 *   sign_in    an app needs its owner to sign in again; the item paused itself
 *   repair     Cowork worked out a repair of a plan that kept failing, or of a goal that stayed under target
 *              (usecases/coworkProposals.mts); it changes nothing until the owner approves it
 *   incomplete the item's last run did not do its work: a step that works through a list found none
 *              (core/cowork/runOutcome.mts), and no fix was applied by itself (core/cowork/repairs/autoResolve.mts)
 *   ai_failed  the item's last run failed because its own AI said it could not do the work (decision 0050)
 *   plan       a plan waits for its first approval, changed and may do more than approved, or cannot run as it is
 *
 * Nothing here reads what the runs read: titles, statuses and the review's own reason, never a mail or a result. The
 * owner's own items only.
 */

import { createRequire } from 'node:module';
import type { PlanState } from './coworkPlan.mts';

const nodeRequire = createRequire(import.meta.url);
const { fallback } = nodeRequire('../utils/bestEffort.js') as { fallback: <T>(label: string, err: unknown, value: T) => T };

export type NeedKind = 'decision' | 'review' | 'sign_in' | 'repair' | 'incomplete' | 'ai_failed' | 'plan';
export type PlanNeed = 'first' | 'changed' | 'blocked' | 'gone';

export interface Need {
    kind: NeedKind;
    itemId: string;
    title: string;
    /** The run it is about, for a decision or a review. */
    runId: string | null;
    /** When it started waiting, when known. */
    since: string | null;
    /** A review: the reason the agent gave. A plan: what is wrong with it. */
    reason: string | null;
    /** A plan: where it stands. */
    plan: PlanNeed | null;
    /** A repair: the proposal, why it was made, and the step it is about as the approved plan names it. */
    repair?: OpenRepair | null;
}

export interface OpenRepair { proposalId: string; reasonCode: string; stepTitle: string | null }

interface Item { id: string; userId: string; title?: string | null; lastStatus?: string | null; isActive?: boolean; planAutomationId?: string | null; planId?: string | null; triggerKind?: string | null }
interface WaitingRun { runId: string; itemId: string; title: string; status: string; since: string | null; reason: string | null }

export interface NeedsYouDeps {
    getSchedules: (userId: string) => Promise<Item[]>;
    listRunsWaitingForOwner: (userId: string, limit?: number) => Promise<WaitingRun[]>;
    planStateOf: (item: Item) => Promise<PlanState>;
    /** The open repair of an item that fits its approved plan (usecases/coworkProposals.mts). */
    openRepairOf?: (item: Item, approvedFingerprint: string | null) => Promise<OpenRepair | null>;
    /** The owner's items whose last run did not do its work (stores/coworkRunOutcomes.mts). */
    lastRunProblems?: (userId: string) => Promise<RunProblem[]>;
}

interface RunProblem { itemId: string; runId: string; kind: 'incomplete' | 'ai_failed'; since: string | null }

const defaults = (): NeedsYouDeps => {
    const store = () => nodeRequire('../stores/coworkStore.js') as Pick<NeedsYouDeps, 'getSchedules' | 'listRunsWaitingForOwner'>;
    return {
        getSchedules: (userId) => store().getSchedules(userId),
        listRunsWaitingForOwner: (userId, limit) => store().listRunsWaitingForOwner(userId, limit),
        planStateOf: (item) => (nodeRequire('./coworkPlan.mts') as { planStateOf: NeedsYouDeps['planStateOf'] }).planStateOf(item),
        openRepairOf: (item, fingerprint) => (nodeRequire('./coworkProposals.mts') as typeof import('./coworkProposals.mts')).openRepairOf(item, fingerprint),
        lastRunProblems: (userId) => (nodeRequire('../stores/coworkRunOutcomes.mts') as typeof import('../stores/coworkRunOutcomes.mts')).coworkRunOutcomes().lastRunProblems(userId),
    };
};

/** Where a plan stands, when it needs its owner; null when it does not. */
export function planNeedOf(state: PlanState): PlanNeed | null {
    if (!state.automationId) return null;
    if (!state.draft) return 'gone';
    if (state.draft.findings.length > 0) return state.approved && !state.upToDate ? null : 'blocked';
    if (state.upToDate) return null;
    if (!state.approved) return 'first';
    return state.widens.length > 0 ? 'changed' : null;
}

/** What a plan's need says, as the first reason the owner should read. */
function planReasonOf(state: PlanState, need: PlanNeed): string | null {
    if (need === 'blocked') return state.draft?.findings[0]?.message ?? null;
    if (need === 'changed') return state.widens[0] ?? null;
    return null;
}

const ORDER: Readonly<Record<NeedKind, number>> = { decision: 0, review: 1, sign_in: 2, repair: 3, incomplete: 4, ai_failed: 4, plan: 5 };

/** The runs that did not do their work, as needs; an item with a repair ready says so through the repair instead. */
async function problemNeeds(userId: string, items: Item[], needs: Need[], deps: NeedsYouDeps): Promise<Need[]> {
    if (!deps.lastRunProblems) return [];
    const problems = await deps.lastRunProblems(userId).catch((e: unknown) => fallback('usecases/coworkNeedsYou:problems', e, [] as RunProblem[]));
    const titles = new Map(items.map((i) => [i.id, i.title ?? '']));
    const repaired = new Set(needs.filter((n) => n.kind === 'repair').map((n) => n.itemId));
    return problems
        .filter((p) => titles.has(p.itemId) && !repaired.has(p.itemId))
        .map((p) => ({ kind: p.kind, itemId: p.itemId, title: titles.get(p.itemId) ?? '', runId: p.runId, since: p.since, reason: null, plan: null }));
}

/** What an item's plan waits for: its approval, and a repair that is ready. One that cannot be read costs its own entry. */
async function planNeedsOf(item: Item, deps: NeedsYouDeps): Promise<Need[]> {
    const out: Need[] = [];
    const title = item.title ?? '';
    const state = await deps.planStateOf(item).catch((e: unknown) => fallback('usecases/coworkNeedsYou:planState', e, null));
    const need = state ? planNeedOf(state) : null;
    if (state && need) out.push({ kind: 'plan', itemId: item.id, title, runId: null, since: null, reason: planReasonOf(state, need), plan: need });
    const fingerprint = state?.approved?.fingerprint ?? null;
    const repair = fingerprint && deps.openRepairOf
        ? await deps.openRepairOf(item, fingerprint).catch((e: unknown) => fallback('usecases/coworkNeedsYou:repair', e, null))
        : null;
    if (repair) out.push({ kind: 'repair', itemId: item.id, title, runId: null, since: null, reason: null, plan: null, repair });
    return out;
}

/** The needs of one owner: the most urgent kind first, and within a kind the newest first. */
export async function needsYou(userId: string, deps: NeedsYouDeps = defaults()): Promise<Need[]> {
    const [items, runs] = await Promise.all([deps.getSchedules(userId), deps.listRunsWaitingForOwner(userId)]);
    const needs: Need[] = runs.map((r) => ({
        kind: r.status === 'waiting' ? 'decision' : 'review', itemId: r.itemId, title: r.title, runId: r.runId, since: r.since,
        reason: r.status === 'waiting' ? null : r.reason, plan: null,
    }));
    for (const item of items) {
        if (item.lastStatus === 'needs_reauth') {
            needs.push({ kind: 'sign_in', itemId: item.id, title: item.title ?? '', runId: null, since: null, reason: null, plan: null });
        }
        if (item.planAutomationId) needs.push(...await planNeedsOf(item, deps));
    }
    needs.push(...await problemNeeds(userId, items, needs, deps));
    return needs.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || String(b.since ?? '').localeCompare(String(a.since ?? '')));
}
