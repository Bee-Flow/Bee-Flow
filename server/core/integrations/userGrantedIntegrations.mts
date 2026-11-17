/**
 * The integrations the app pickers (chat composer, Cowork) may offer this
 * person: the organisation-wide list, plus what one of their groups was
 * granted.
 *
 * `resolveOrgIntegrations` answers only the organisation-wide grant. Grants
 * stack (All members OR a group the person is in), and the runtime gate
 * (runtimeAppGate.js) already reads them through the entitlement resolver,
 * so an app granted to a group ran, but the pickers hid it and the person
 * could never switch it on. This adds the resolver's effective list, which is
 * the licence ceiling intersected with those grants: it only adds what the
 * person is entitled to, and the runtime gate still decides every call.
 *
 * Unknown stays as it was: a degraded or failing resolver adds nothing, and an
 * org list of null ("no restriction") is returned unchanged.
 */

import { createRequire } from 'node:module';

type Snapshot = { degraded?: boolean; effective?: { integration?: Iterable<string> | null } | null } | null | undefined;
type Resolve = (ctx: { userId: string; orgId: string | null; session?: unknown; req?: unknown }) => Promise<Snapshot>;

const nodeRequire = createRequire(import.meta.url);

function defaultResolve(): Resolve {
    return (nodeRequire('../entitlements/entitlements.js') as { resolveEntitlements: Resolve }).resolveEntitlements;
}

export async function withGroupGrants(
    orgList: string[] | null,
    ctx: { userId: string; orgId: string | null; session?: unknown; req?: unknown },
    resolve: Resolve = defaultResolve(),
): Promise<string[] | null> {
    if (!Array.isArray(orgList)) return orgList;
    let snap: Snapshot = null;
    try { snap = await resolve(ctx); } catch { return orgList; }
    if (!snap || snap.degraded || !snap.effective?.integration) return orgList;
    return [...new Set([...orgList, ...Array.from(snap.effective.integration)])];
}

/** resolveOrgIntegrations for the person's home organisation, with their group grants added. */
export async function pickerIntegrations(ctx: { userId: string; orgId: string; session?: unknown; req?: unknown }): Promise<string[] | null> {
    const { resolveOrgIntegrations } = nodeRequire('./enabledIntegrations.js') as { resolveOrgIntegrations: (orgId: string) => Promise<string[] | null> };
    return withGroupGrants(await resolveOrgIntegrations(ctx.orgId), ctx);
}
