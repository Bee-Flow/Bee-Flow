/**
 * The monthly AI budget of one item: what its runs may spend on AI in a calendar month, in euros. At the budget, the
 * item pauses itself and tells its owner once; the run that found it does not start. The owner raises the budget, or
 * switches it on again next month.
 *
 * Measured from the usage ledger (stores/coworkRunCosts.mts), in euros only: a cost in another currency does not count
 * towards it. A cost that cannot be read does not stop a run: the budget guards spending, not access.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const log = nodeRequire('../../telemetry/log.js') as { warn: (m: string) => void };

interface Task { id: string; userId: string; title?: string | null; monthlyBudget?: number | null }
interface RunCost { byCurrency: Record<string, number>; calls: number }

export interface BudgetDeps {
    costsSince: (userId: string, since: Date) => Promise<{ byItem: Record<string, RunCost> }>;
    pause: (id: string) => Promise<unknown>;
    notify: (n: { userId: string; taskId: string; category: string; title: string; message: string; link: string }) => Promise<unknown>;
}

const defaults = (): BudgetDeps => {
    const store = () => nodeRequire('../../stores/coworkStore.js') as { costsSince: BudgetDeps['costsSince']; updateSchedule: (id: string, u: Record<string, unknown>) => Promise<unknown> };
    return {
        costsSince: (userId, since) => store().costsSince(userId, since),
        pause: (id) => store().updateSchedule(id, { isActive: false }),
        notify: (n) => (nodeRequire('../../stores/notificationStore') as { createNotification: BudgetDeps['notify'] }).createNotification(n),
    };
};

const euros = (n: number): string => `€${n.toFixed(2)}`;

/** Why this run does not start (the budget is reached, and the item paused itself), or null. */
export async function budgetRefusal(task: Task, now: Date = new Date(), deps: BudgetDeps = defaults()): Promise<string | null> {
    const budget = task.monthlyBudget;
    if (budget === null || budget === undefined || !Number.isFinite(budget)) return null;
    let spent: number;
    try {
        const month = await deps.costsSince(task.userId, new Date(now.getFullYear(), now.getMonth(), 1));
        spent = month.byItem[task.id]?.byCurrency.EUR ?? 0;
    } catch (e) {
        log.warn(`[Cowork] the budget of ${task.id} could not be checked: ${(e as Error).message}`);
        return null;
    }
    if (spent < budget) return null;
    const reason = `This cowork reached its AI budget of ${euros(budget)} for this month (${euros(spent)} spent), so it paused itself. Raise the budget, or switch it on again next month.`;
    await deps.pause(task.id);
    await deps.notify({ userId: task.userId, taskId: task.id, category: 'cowork', title: `${task.title ?? 'A cowork'} paused itself`, message: reason, link: `/app/cowork/${task.id}` })
        .catch((e: Error) => log.warn(`[Cowork] could not tell the owner of ${task.id} about its budget: ${e.message}`));
    return reason;
}
