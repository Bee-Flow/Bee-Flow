/**
 * ownerGate.mts: may this automation's owner still have it run?
 *
 * A run acts with its owner's standing (connections, datatables, organisation),
 * so it needs an owner whose account is plainly active
 * (auth/accountStatusGate.isActiveAccount) and whose organisation still has
 * the `automations` capability: the rule the scheduler applies before a tick
 * (scheduler/ticks.js ownerMayRun), asked here by executeAutomation for every
 * trigger kind (webhook, app event, form, manual, agent call, ...).
 *
 * It refuses on what it finds: an owner row that is not active, or one
 * without the capability. A lookup that fails falls through, the way the
 * session lookup next to it does; an erased account has no automations left
 * (erasure removes them).
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

export interface OwnerRef {
    userId: string;
    organizationId?: string | null;
}

interface OwnerRow {
    status?: string | null;
}

export interface OwnerGateDeps {
    getUser: (userId: string) => Promise<OwnerRow | null>;
    isActiveAccount: (row: OwnerRow | null) => boolean;
    hasCapability: (capId: string, ctx: { userId: string; orgId: string | null }) => Promise<boolean>;
}

function defaultDeps(): OwnerGateDeps {
    return {
        getUser: (userId) => nodeRequire('../../stores/userStore.js').getUser(userId),
        isActiveAccount: (row) => nodeRequire('../../auth/accountStatusGate.js').isActiveAccount(row),
        hasCapability: (capId, ctx) => nodeRequire('../entitlements/entitlements.js').hasCapability(capId, ctx),
    };
}

/** executeAutomation's gate: a refusal reason for an owner that was found and may not run, else null. */
export async function ownerRefusal(a: OwnerRef, deps: Partial<OwnerGateDeps> = {}): Promise<'inactive' | 'not_entitled' | null> {
    const d = { ...defaultDeps(), ...deps };
    if (!a || !a.userId) return null;
    let owner: OwnerRow | null;
    try { owner = await d.getUser(a.userId); } catch { return null; }
    if (!owner) return null;
    if (!d.isActiveAccount(owner)) return 'inactive';
    const entitled = await d.hasCapability('automations', { userId: a.userId, orgId: a.organizationId ?? null });
    return entitled ? null : 'not_entitled';
}
