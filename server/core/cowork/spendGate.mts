/**
 * The AI a person starts by hand around a cowork — a try-out (usecases/coworkPlanTry.mts), a replay
 * (usecases/coworkReplay.mts), having a plan made (usecases/coworkPlanner.mts) — counts against the same budgets as
 * its runs: the item's own (./runBudget.mts) and the organisation's (./orgBudget.mts). Here they are only read: at
 * either budget the action is refused with the reason; nothing is paused and nobody is notified, since the person
 * asking sees the answer. A cost that cannot be read lets it go ahead, as for a run.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { HttpError } = nodeRequire('../http/errors.js') as { HttpError: new (status: number, code: string, message: string) => Error };
const log = nodeRequire('../../telemetry/log.js') as { warn: (m: string) => void };

interface Item { id: string; userId: string; monthlyBudget?: number | null }
interface RunCost { byCurrency: Record<string, number> }

export interface SpendDeps {
    itemSpent: (userId: string, since: Date) => Promise<{ byItem: Record<string, RunCost> }>;
    orgOf: (userId: string) => Promise<string | null>;
    orgBudget: (userId: string) => Promise<number | null>;
    orgSpent: (orgId: string, since: Date) => Promise<RunCost>;
}

const defaults = (): SpendDeps => {
    const store = () => nodeRequire('../../stores/coworkStore.js') as { costsSince: SpendDeps['itemSpent']; orgCostSince: SpendDeps['orgSpent'] };
    const policy = nodeRequire('../entitlements/coworkPolicy.mts') as typeof import('../entitlements/coworkPolicy.mts');
    return {
        itemSpent: (u, since) => store().costsSince(u, since),
        orgOf: async (u) => ((await (nodeRequire('../../stores/userStore.js') as { getUser: (id: string) => Promise<{ organizationId?: string | null } | null> }).getUser(u))?.organizationId || null),
        orgBudget: async (u) => (await policy.policyOfOwner(u)).monthlyBudget ?? null,
        orgSpent: (orgId, since) => store().orgCostSince(orgId, since),
    };
};

const used = (message: string) => new HttpError(409, 'cowork_budget_used', message);

/** Throws when the item's or the organisation's AI budget for this month is used up. */
export async function assertSpendLeft(item: Item, now: Date = new Date(), deps: SpendDeps = defaults()): Promise<void> {
    const since = new Date(now.getFullYear(), now.getMonth(), 1);
    try {
        const budget = item.monthlyBudget;
        if (typeof budget === 'number' && Number.isFinite(budget)) {
            const spent = (await deps.itemSpent(item.userId, since)).byItem[item.id]?.byCurrency.EUR ?? 0;
            if (spent >= budget) throw used('This cowork has used its AI budget for this month, so it does not try, replay or plan now. Raise its budget to go on.');
        }
        const orgBudget = await deps.orgBudget(item.userId);
        const orgId = orgBudget === null ? null : await deps.orgOf(item.userId);
        if (orgBudget !== null && orgId && ((await deps.orgSpent(orgId, since)).byCurrency.EUR ?? 0) >= orgBudget) {
            throw used('Your organisation has used its Cowork AI budget for this month, so this does not start now.');
        }
    } catch (e) {
        if ((e as { code?: unknown }).code === 'cowork_budget_used') throw e;
        log.warn(`[Cowork] the budget of ${item.id} could not be read before an action: ${(e as Error).message}`);
    }
}
