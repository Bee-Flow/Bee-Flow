/**
 * What the administrators' Organisation panel in Cowork needs beyond the policy itself (routes/coworkPolicyRoutes.js):
 *
 *   orgOverview     the caller's organisation, and what all its members' Cowork runs cost in AI this calendar month
 *                   (euros; null when that cannot be read), for the budget meter;
 *   receiptsAudit   every item's receipt chain of the organisation checked at once: how many items and receipts, and
 *                   which chains do not hold. Names, counts and ids only, never what a run read or wrote.
 */

import { createRequire } from 'node:module';
import { receiptsOf, type ReceiptsDeps } from './coworkReceipts.mts';
import type { ChainProblem } from '../core/cowork/receipts/verifyReceipts.mts';

const nodeRequire = createRequire(import.meta.url);

/** The audit reads at most this many items; more is said in the answer, never hidden. */
export const AUDIT_ITEM_LIMIT = 5000;

export interface OrgOverview { orgId: string; name: string; spent: number | null }
export interface OrgOverviewDeps {
    orgOf: (userId: string) => Promise<{ id: string; name: string } | null>;
    orgCostSince: (orgId: string, since: Date) => Promise<{ byCurrency: Record<string, number> }>;
}

export interface ReceiptsAudit {
    checkedAt: string;
    items: number;
    receipts: number;
    unsigned: number;
    /** Closed runs that never got a receipt (after the grace time). */
    missing: number;
    /** The chains that do not hold: the item and the first receipt that fails. */
    problems: Array<{ itemId: string; seq: number; kind: ChainProblem }>;
    /** More items than the audit reads: it checked the first ones only. */
    truncated: boolean;
    ok: boolean;
}
export interface AuditDeps extends ReceiptsDeps { itemIdsOfOrg: (orgId: string, limit: number) => Promise<string[]> }

/** The caller's own organisation (id and name); null for someone without one. */
export async function ownOrgOf(userId: string): Promise<{ id: string; name: string } | null> {
    type Users = { getUser: (id: string) => Promise<{ organizationId?: string | null } | null>; getOrganization: (id: string) => Promise<{ name?: string | null } | null> };
    const users = nodeRequire('../stores/userStore.js') as Users;
    const orgId = (await users.getUser(userId))?.organizationId;
    if (!orgId) return null;
    return { id: orgId, name: (await users.getOrganization(orgId))?.name || orgId };
}

const overviewDefaults = (): OrgOverviewDeps => ({
    orgOf: ownOrgOf,
    orgCostSince: (orgId, since) => (nodeRequire('../stores/coworkStore.js') as { orgCostSince: OrgOverviewDeps['orgCostSince'] }).orgCostSince(orgId, since),
});

const auditDefaults = (): AuditDeps => {
    const store = () => (nodeRequire('../stores/coworkReceipts.mts') as typeof import('../stores/coworkReceipts.mts')).coworkReceipts();
    const { receiptKey } = nodeRequire('../core/cowork/receipts/receiptKey.mts') as typeof import('../core/cowork/receipts/receiptKey.mts');
    return {
        listReceipts: (id) => store().listReceipts(id),
        receiptOfRun: (id, runId) => store().receiptOfRun(id, runId),
        countMissing: (id, before) => store().countMissing(id, before),
        signingKey: () => receiptKey(),
        itemIdsOfOrg: (orgId, limit) => store().itemIdsOfOrg(orgId, limit),
    };
};

/** The caller's organisation and this month's AI spend of all its Cowork runs; null for someone without an organisation. */
export async function orgOverview(userId: string, now: Date = new Date(), deps: OrgOverviewDeps = overviewDefaults()): Promise<OrgOverview | null> {
    const org = await deps.orgOf(userId);
    if (!org) return null;
    const spent = await deps.orgCostSince(org.id, new Date(now.getFullYear(), now.getMonth(), 1)).then((c) => c.byCurrency.EUR ?? 0, () => null);
    return { orgId: org.id, name: org.name, spent };
}

/** Check the receipt chain of every item of the organisation. */
export async function receiptsAudit(orgId: string, now: Date = new Date(), deps: AuditDeps = auditDefaults()): Promise<ReceiptsAudit> {
    const ids = await deps.itemIdsOfOrg(orgId, AUDIT_ITEM_LIMIT + 1);
    const checked = ids.slice(0, AUDIT_ITEM_LIMIT);
    const audit: ReceiptsAudit = { checkedAt: now.toISOString(), items: checked.length, receipts: 0, unsigned: 0, missing: 0, problems: [], truncated: ids.length > AUDIT_ITEM_LIMIT, ok: true };
    for (const id of checked) {
        const view = await receiptsOf({ id, userId: '' }, now, deps);
        audit.receipts += view.verdict.count;
        audit.unsigned += view.verdict.unsigned;
        audit.missing += view.missingRuns;
        if (view.verdict.problem) audit.problems.push({ itemId: id, ...view.verdict.problem });
    }
    audit.ok = audit.problems.length === 0 && audit.missing === 0;
    return audit;
}
