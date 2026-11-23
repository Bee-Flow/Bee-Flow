/**
 * "Needs you": everything in Cowork that waits for its owner, in one list (routes/coworkSideRoutes.js serves it; the
 * web app shows it at the top of Cowork, the phone and the daily mail read the same list).
 *
 *   decision   a plan run waits for the owner's decision (an approval step: decided under Approvals)
 *   review     an agent run asked the owner to look at something
 *   sign_in    an app needs its owner to sign in again; the item paused itself
 *   plan       a plan waits for its first approval, changed and may do more than approved, or cannot run as it is
 *
 * Nothing here reads what the runs read: titles, statuses and the review's own reason, never a mail or a result. The
 * owner's own items only.
 */

import { createRequire } from 'node:module';
import type { PlanState } from './coworkPlan.mts';

const nodeRequire = createRequire(import.meta.url);
const { fallback } = nodeRequire('../utils/bestEffort.js') as { fallback: <T>(label: string, err: unknown, value: T) => T };

export type NeedKind = 'decision' | 'review' | 'sign_in' | 'plan';
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
}

interface Item { id: string; userId: string; title?: string | null; lastStatus?: string | null; isActive?: boolean; planAutomationId?: string | null; planId?: string | null; triggerKind?: string | null }
interface WaitingRun { runId: string; itemId: string; title: string; status: string; since: string | null; reason: string | null }

export interface NeedsYouDeps {
    getSchedules: (userId: string) => Promise<Item[]>;
    listRunsWaitingForOwner: (userId: string, limit?: number) => Promise<WaitingRun[]>;
    planStateOf: (item: Item) => Promise<PlanState>;
}

const defaults = (): NeedsYouDeps => {
    const store = () => nodeRequire('../stores/coworkStore.js') as Pick<NeedsYouDeps, 'getSchedules' | 'listRunsWaitingForOwner'>;
    return {
        getSchedules: (userId) => store().getSchedules(userId),
        listRunsWaitingForOwner: (userId, limit) => store().listRunsWaitingForOwner(userId, limit),
        planStateOf: (item) => (nodeRequire('./coworkPlan.mts') as { planStateOf: NeedsYouDeps['planStateOf'] }).planStateOf(item),
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

const ORDER: Readonly<Record<NeedKind, number>> = { decision: 0, review: 1, sign_in: 2, plan: 3 };

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
        if (!item.planAutomationId) continue;
        // One plan that cannot be read costs its own entry, never the list.
        const state = await deps.planStateOf(item).catch((e: unknown) => fallback('usecases/coworkNeedsYou:planState', e, null));
        const need = state ? planNeedOf(state) : null;
        if (state && need) needs.push({ kind: 'plan', itemId: item.id, title: item.title ?? '', runId: null, since: null, reason: planReasonOf(state, need), plan: need });
    }
    return needs.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || String(b.since ?? '').localeCompare(String(a.since ?? '')));
}
