/**
 * What Cowork runs cost in AI, as the routes hand it out (routes/cowork.js): per run in the history, and this
 * calendar month per item. The amounts are the usage ledger's own pricing (stores/coworkRunCosts.mts).
 *
 * A cost is never guessed and never stands in the way: a read that fails gives no figure (null), not zero, and the
 * history and the figures still answer.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { fallback } = nodeRequire('../utils/bestEffort.js') as { fallback: <T>(label: string, err: unknown, value: T) => T };

export interface RunCost { byCurrency: Record<string, number>; calls: number }

export interface CostStore {
    costsOfRuns?: (scheduleId: string, runIds: string[]) => Promise<Record<string, RunCost>>;
    costsSince?: (userId: string, since: Date) => Promise<{ total: RunCost; byItem: Record<string, RunCost> }>;
}

/** The runs of one item, each with what it cost; a run whose cost is unknown or nothing carries null. */
export async function withRunCosts<R extends { id: string }>(scheduleId: string, runs: R[], store: CostStore): Promise<Array<R & { cost: RunCost | null }>> {
    const none: Record<string, RunCost> = {};
    const costs: Record<string, RunCost> = await Promise.resolve()
        .then(() => (store.costsOfRuns ? store.costsOfRuns(scheduleId, runs.map((r) => r.id)) : none))
        .catch((e: unknown) => fallback('usecases/coworkCosts:withRunCosts', e, {} as Record<string, RunCost>));
    return runs.map((r) => ({ ...r, cost: costs[r.id] ?? null }));
}

/** The first moment of the calendar month `now` is in, on the server's clock. */
export function monthStartOf(now: Date): Date {
    return new Date(now.getFullYear(), now.getMonth(), 1);
}

/** What this item's runs cost this month: none is a measured zero ({ calls: 0 }), unreadable is null. */
export async function monthCostOf(userId: string, scheduleId: string, store: CostStore, now: Date = new Date()): Promise<RunCost | null> {
    const month = await Promise.resolve()
        .then(() => (store.costsSince ? store.costsSince(userId, monthStartOf(now)) : null))
        .catch((e: unknown) => fallback('usecases/coworkCosts:monthCostOf', e, null));
    if (!month) return null;
    return month.byItem[scheduleId] ?? { byCurrency: {}, calls: 0 };
}
