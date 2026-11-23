/**
 * What all coworks of an organisation may spend on AI in a calendar month, set by its administrators
 * (core/entitlements/coworkPolicy.mts `monthlyBudget`, in euros), and the subscription's own monthly limits
 * (core/entitlements/limits.js). At either, a run does not start, until the next month or until an administrator
 * raises the limit. No item is paused: nothing has to be switched back on afterwards.
 *
 * Telling people, without noise: the first refused run of an item in a month fails with the reason (its owner is
 * notified like any failed run); a later moment of that item in the same month that the scheduler finds due moves on
 * without a failed run. A run someone starts by hand always says why it did not run. The organisation's
 * administrators are told once a month.
 *
 * Measured from the usage ledger (stores/coworkRunCosts.mts), in euros only. A cost that cannot be read does not
 * stop a run: the budget guards spending, not access.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const log = nodeRequire('../../telemetry/log.js') as { warn: (m: string) => void };

interface Task { id: string; userId: string; title?: string | null }
interface RunCost { byCurrency: Record<string, number>; calls: number }

export interface OrgBudgetDeps {
    orgOf: (userId: string) => Promise<string | null>;
    orgCostSince: (orgId: string, since: Date) => Promise<RunCost>;
    subscriptionRefusal: (orgId: string, userId: string) => Promise<string | null>;
    /** Claim a once-only notice; false when it was claimed before (stores/user claimNotification). */
    claimOnce: (targetType: string, targetId: string, kind: string) => Promise<boolean>;
    adminIds: (orgId: string) => Promise<string[]>;
    notify: (n: { userId: string; category: string; title: string; message: string; link: string }) => Promise<unknown>;
}

export interface OrgRefusal {
    reason: string;
    /** The scheduler may move on without a failed run: the owner already heard this month. */
    quiet: boolean;
}

const defaults = (): OrgBudgetDeps => {
    type UserStore = {
        getUser: (id: string) => Promise<{ organizationId?: string | null } | null>;
        claimNotification: (type: string, id: string, kind: string, userId: string | null, payload: unknown) => Promise<boolean>;
    };
    const users = () => nodeRequire('../../stores/userStore.js') as UserStore;
    type Db = { getAll: (sql: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>> };
    return {
        orgOf: async (userId) => (await users().getUser(userId))?.organizationId || null,
        orgCostSince: (orgId, since) => (nodeRequire('../../stores/coworkStore.js') as { orgCostSince: OrgBudgetDeps['orgCostSince'] }).orgCostSince(orgId, since),
        subscriptionRefusal: (orgId, userId) => (nodeRequire('../entitlements/limits.js') as { checkSubscriptionLimits: (o: string, t: string, u: string) => Promise<string | null> }).checkSubscriptionLimits(orgId, 'chat', userId),
        claimOnce: (type, id, kind) => users().claimNotification(type, id, kind, null, {}),
        adminIds: async (orgId) => (await (nodeRequire('../../db.js') as Db).getAll(
            `SELECT id FROM users WHERE "organizationId" = $1 AND (role = 'admin' OR "orgRole" IN ('org_admin', 'admin')) AND COALESCE(status, 'active') = 'active' LIMIT 5`,
            [orgId],
        )).map((r) => String(r.id)),
        notify: (n) => (nodeRequire('../../stores/notificationStore') as { createNotification: OrgBudgetDeps['notify'] }).createNotification(n),
    };
};

const euros = (n: number): string => `€${n.toFixed(2)}`;
const monthKey = (now: Date): string => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

/** What the organisation spent on Cowork this month, in euros; null when it cannot be read. */
async function spentThisMonth(orgId: string, now: Date, deps: OrgBudgetDeps): Promise<number | null> {
    try {
        return (await deps.orgCostSince(orgId, new Date(now.getFullYear(), now.getMonth(), 1))).byCurrency.EUR ?? 0;
    } catch (e) {
        log.warn(`[Cowork] the organisation budget of ${orgId} could not be checked: ${(e as Error).message}`);
        return null;
    }
}

/** Why the organisation's limits stop this run, or null. Never throws. */
async function limitReason(task: Task, orgId: string, budget: number | null, now: Date, deps: OrgBudgetDeps): Promise<{ reason: string; budgetHit: boolean } | null> {
    if (budget !== null) {
        const spent = await spentThisMonth(orgId, now, deps);
        if (spent !== null && spent >= budget) {
            return {
                budgetHit: true,
                reason: `Your organisation's Cowork budget of ${euros(budget)} for this month is used up (${euros(spent)} spent), so this run did not start. An administrator can raise it; otherwise coworks run again on the 1st.`,
            };
        }
    }
    const refusal = await deps.subscriptionRefusal(orgId, task.userId).catch((e: Error) => {
        log.warn(`[Cowork] the subscription limits of ${orgId} could not be checked: ${e.message}`);
        return null;
    });
    return refusal ? { reason: refusal, budgetHit: false } : null;
}

/** Tell the organisation's administrators, once a month. */
async function tellAdmins(orgId: string, budget: number, now: Date, deps: OrgBudgetDeps): Promise<void> {
    try {
        if (!(await deps.claimOnce('organization', orgId, `cowork_org_budget:${monthKey(now)}`))) return;
        const message = `The coworks of your organisation reached this month's AI budget of ${euros(budget)}. They run again on the 1st, or as soon as the budget is raised.`;
        for (const userId of await deps.adminIds(orgId)) {
            await deps.notify({ userId, category: 'cowork', title: 'Cowork budget reached', message, link: '/app/admin' });
        }
    } catch (e) {
        log.warn(`[Cowork] could not tell the administrators of ${orgId} about the budget: ${(e as Error).message}`);
    }
}

/**
 * Why the organisation stops this run, or null. `monthlyBudget` is the policy's (null: no budget of its own; the
 * subscription limits still count).
 */
export async function orgBudgetRefusal(task: Task, monthlyBudget: number | null, now: Date = new Date(), deps: OrgBudgetDeps = defaults()): Promise<OrgRefusal | null> {
    let orgId: string | null;
    try {
        orgId = await deps.orgOf(task.userId);
    } catch (e) {
        log.warn(`[Cowork] the organisation of ${task.userId} could not be read for its budget: ${(e as Error).message}`);
        return null;
    }
    if (!orgId) return null;
    const hit = await limitReason(task, orgId, monthlyBudget, now, deps);
    if (!hit) return null;
    if (hit.budgetHit && monthlyBudget !== null) await tellAdmins(orgId, monthlyBudget, now, deps);
    const first = await deps.claimOnce('cowork_item', task.id, `cowork_org_limit:${monthKey(now)}`).catch(() => true);
    return { reason: hit.reason, quiet: !first };
}
