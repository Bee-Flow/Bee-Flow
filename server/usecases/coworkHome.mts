/**
 * Cowork's home, in one read (routes/coworkSideRoutes.js serves it; the web page shows it next to "Needs you"):
 *
 *   how       per item, how it works: a plan's make-up ("4 fixed steps, 2 AI") and the level it runs at, or that it
 *             runs a prompt or an agent;
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
import { monthStartOf, type RunCost } from './coworkCosts.mts';

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
}

export interface TodayEntry { kind: 'ran' | 'next'; itemId: string; title: string; at: string | null; status: string | null; runId: string | null }

export interface CoworkHome { how: Record<string, HowItWorks>; today: TodayEntry[]; cost: RunCost | null }

const NONE = { fixed: 0, ai: 0, ask: 0, deliver: 0 };

async function howOf(item: Item, mayAsk: boolean, deps: HomeDeps): Promise<HowItWorks> {
    if (!item.planId) return { kind: item.agentId ? 'agent' : 'prompt', ...NONE, level: null };
    const plan = await deps.getApprovedPlan(item.id).catch((e: unknown) => fallback('usecases/coworkHome:plan', e, null));
    const makeUp = plan ? planViewOf(plan.definition as Definition, deps.lookups).makeUp : NONE;
    let level: Independence | null;
    try { level = effectiveIndependence(item.independence, mayAsk); } catch { level = null; }
    return { kind: 'plan', ...makeUp, level };
}

/** The home of one owner, for the day [from, to) of the owner's clock. */
export async function homeOf(userId: string, day: { from: string; to: string }, now: Date = new Date(), deps: HomeDeps = defaults()): Promise<CoworkHome> {
    const [items, runs, cost, mayAsk] = await Promise.all([
        deps.getSchedules(userId),
        deps.listRunsBetween(userId, day.from, day.to).catch((e: unknown) => fallback('usecases/coworkHome:runs', e, [] as RunRow[])),
        deps.costsSince(userId, monthStartOf(now)).then((m) => m.total).catch((e: unknown) => fallback('usecases/coworkHome:cost', e, null)),
        deps.mayAsk({ userId }).catch(() => false),
    ]);
    const how: Record<string, HowItWorks> = {};
    for (const item of items) how[item.id] = await howOf(item, mayAsk, deps);
    const nowIso = now.toISOString();
    const next: TodayEntry[] = items
        .filter((i) => i.isActive !== false && typeof i.nextRunAt === 'string' && i.nextRunAt >= nowIso && i.nextRunAt < day.to)
        .map((i) => ({ kind: 'next', itemId: i.id, title: i.title ?? '', at: i.nextRunAt ?? null, status: null, runId: null }));
    const ran: TodayEntry[] = runs.map((r) => ({ kind: 'ran', itemId: r.itemId, title: r.title, at: r.at, status: r.status, runId: r.runId }));
    // One timeline, earliest first: what ran, then what is to come.
    const today = [...ran, ...next].sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));
    return { how, today, cost };
}
