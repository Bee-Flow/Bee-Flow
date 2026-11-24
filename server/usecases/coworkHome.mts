/**
 * Cowork's home, in one read (routes/coworkSideRoutes.js serves it; the web page shows it next to "Needs you"):
 *
 *   how       per item, how it works: a plan's make-up ("4 fixed steps, 2 AI") and the level it runs at, or that it
 *             runs a prompt or an agent; and for an item with a goal, its latest count ("46 of 49 this week");
 *   today     what ran in the owner's day so far and what is still to come in it (the client says where its day
 *             starts and ends: the owner's clock, not the server's);
 *   cost      what the owner's Cowork runs cost in AI this calendar month (null: it could not be read).
 *
 * Titles, statuses and times; never what a run read or produced. The owner's own items only.
 */

import { createRequire } from 'node:module';
import type { Definition, ToolLookups } from '../core/cowork/plan/planTypes.mts';
import { planViewOf } from '../core/cowork/plan/planView.mts';
import { toolLookups } from '../core/cowork/plan/planLookups.mts';
import { effectiveIndependence, type Independence } from '../core/cowork/plan/planIndependence.mts';
import { mayAskByLicence, type MayAsk } from '../core/cowork/plan/planLicence.mts';
import { capLevel, OPEN_POLICY, policyOfOwner, type CoworkPolicy } from '../core/entitlements/coworkPolicy.mts';
import { monthStartOf, type RunCost } from './coworkCosts.mts';
import type { GoalCount } from '../stores/coworkGoals.mts';

const nodeRequire = createRequire(import.meta.url);
const { fallback } = nodeRequire('../utils/bestEffort.js') as { fallback: <T>(label: string, err: unknown, value: T) => T };

interface Item { id: string; title?: string | null; isActive?: boolean; nextRunAt?: string | null; planId?: string | null; agentId?: string | null; independence?: string | null }
interface RunRow { runId: string; itemId: string; title: string; status: string; at: string | null }

export interface HomeDeps {
    getSchedules: (userId: string) => Promise<Item[]>;
    getApprovedPlan: (scheduleId: string) => Promise<{ definition: unknown } | null>;
    listRunsBetween: (userId: string, from: string, to: string, limit?: number) => Promise<RunRow[]>;
    costsSince: (userId: string, since: Date) => Promise<{ total: RunCost }>;
    mayAsk: MayAsk;
    lookups: ToolLookups;
    /** The owner's organisation and its Cowork policy: the home shows the level a run really uses, under the ceiling. */
    orgOf?: (userId: string) => Promise<string | null>;
    policyOf?: (userId: string) => Promise<CoworkPolicy>;
    /** The owner's goals with their latest good count (stores/coworkGoals.mts); without it, no item shows a goal. */
    goalCounts?: (userId: string) => Promise<GoalCount[]>;
}

const defaults = (): HomeDeps => {
    const store = () => nodeRequire('../stores/coworkStore.js') as Omit<HomeDeps, 'mayAsk' | 'lookups'>;
    return {
        getSchedules: (u) => store().getSchedules(u),
        getApprovedPlan: (id) => store().getApprovedPlan(id),
        listRunsBetween: (u, f, t, l) => store().listRunsBetween(u, f, t, l),
        costsSince: (u, s) => store().costsSince(u, s),
        mayAsk: mayAskByLicence,
        lookups: toolLookups(),
        orgOf: async (u) => ((await (nodeRequire('../stores/userStore.js') as { getUser: (id: string) => Promise<{ organizationId?: string | null } | null> }).getUser(u))?.organizationId || null),
        policyOf: (u) => policyOfOwner(u),
        goalCounts: (u) => (nodeRequire('../stores/coworkGoals.mts') as typeof import('../stores/coworkGoals.mts')).coworkGoals().countsOfOwner(u),
    };
};

export interface HowItWorks {
    kind: 'plan' | 'agent' | 'prompt';
    fixed: number;
    ai: number;
    ask: number;
    deliver: number;
    /** The level a plan's next run uses; null for a prompt or an agent, or a plan that cannot run as chosen. */
    level: Independence | null;
    /** The item's goal and its latest count; absent without a goal. Its met and total are null before a first count. */
    goal?: GoalLine;
}

export interface GoalLine { sentence: string; targetPercent: number; met: number | null; total: number | null; period: string | null; measuredAt: string | null }

export interface TodayEntry { kind: 'ran' | 'next'; itemId: string; title: string; at: string | null; status: string | null; runId: string | null }

export interface CoworkHome { how: Record<string, HowItWorks>; today: TodayEntry[]; cost: RunCost | null }

const NONE = { fixed: 0, ai: 0, ask: 0, deliver: 0 };

async function howOf(item: Item, mayAsk: boolean, ceiling: CoworkPolicy['ceiling'], deps: HomeDeps): Promise<HowItWorks> {
    if (!item.planId) return { kind: item.agentId ? 'agent' : 'prompt', ...NONE, level: null };
    const plan = await deps.getApprovedPlan(item.id).catch((e: unknown) => fallback('usecases/coworkHome:plan', e, null));
    const makeUp = plan ? planViewOf(plan.definition as Definition, deps.lookups).makeUp : NONE;
    let level: Independence | null;
    try { level = effectiveIndependence(capLevel(effectiveIndependence(item.independence, mayAsk), ceiling), mayAsk); } catch { level = null; }
    return { kind: 'plan', ...makeUp, level };
}

/** The owner's goals by item; an unreadable list shows no goal rather than no home. */
async function goalsOf(userId: string, deps: HomeDeps): Promise<Map<string, GoalLine>> {
    const counts = deps.goalCounts ? await deps.goalCounts(userId).catch((e: unknown) => fallback('usecases/coworkHome:goals', e, [] as GoalCount[])) : [];
    return new Map(counts.map((c) => [c.scheduleId, { sentence: c.sentence, targetPercent: c.targetPercent, met: c.met, total: c.total, period: c.period, measuredAt: c.measuredAt }]));
}

/** The home of one owner, for the day [from, to) of the owner's clock. */
export async function homeOf(userId: string, day: { from: string; to: string }, now: Date = new Date(), deps: HomeDeps = defaults()): Promise<CoworkHome> {
    const organizationId = deps.orgOf ? await deps.orgOf(userId).catch((e: unknown) => fallback('usecases/coworkHome:org', e, null)) : null;
    const [items, runs, cost, mayAsk, policy] = await Promise.all([
        deps.getSchedules(userId),
        deps.listRunsBetween(userId, day.from, day.to).catch((e: unknown) => fallback('usecases/coworkHome:runs', e, [] as RunRow[])),
        deps.costsSince(userId, monthStartOf(now)).then((m) => m.total).catch((e: unknown) => fallback('usecases/coworkHome:cost', e, null)),
        deps.mayAsk({ userId, organizationId }).catch(() => false),
        deps.policyOf ? deps.policyOf(userId) : Promise.resolve(OPEN_POLICY),
    ]);
    const goals = await goalsOf(userId, deps);
    const how: Record<string, HowItWorks> = {};
    for (const item of items) {
        const works = await howOf(item, mayAsk, policy.ceiling, deps);
        const goal = goals.get(item.id);
        // Additive: an item without a goal answers exactly what it always did.
        how[item.id] = goal ? { ...works, goal } : works;
    }
    const nowIso = now.toISOString();
    const next: TodayEntry[] = items
        .filter((i) => i.isActive !== false && typeof i.nextRunAt === 'string' && i.nextRunAt >= nowIso && i.nextRunAt < day.to)
        .map((i) => ({ kind: 'next', itemId: i.id, title: i.title ?? '', at: i.nextRunAt ?? null, status: null, runId: null }));
    const ran: TodayEntry[] = runs.map((r) => ({ kind: 'ran', itemId: r.itemId, title: r.title, at: r.at, status: r.status, runId: r.runId }));
    // One timeline, earliest first: what ran, then what is to come.
    const today = [...ran, ...next].sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));
    return { how, today, cost };
}
