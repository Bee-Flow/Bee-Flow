/**
 * The one Microsoft tenant an organisation is verifiably linked to, for
 * organisation-wide Teams import (option B). Only the links that already
 * exist and that a platform administrator set count; an organisation admin
 * can never type a tenant:
 *
 *   1. the directory sync binding (`azure_group_sync_binding`) names this
 *      organisation and a tenant GUID. When the configured sign-in tenant is a
 *      GUID too, it must be the same one (else `tenant_mismatch_sso`);
 *   2. else the configured sign-in tenant is a GUID and this is the only
 *      organisation on the server;
 *   3. else `tenant_not_bound` (several organisations without a binding:
 *      option B is not available).
 *
 * A tenant therefore maps to at most one organisation: the binding names one
 * organisation, and rule 2 holds only with exactly one. Never `common`,
 * `organizations` or `consumers`.
 *
 * Memoised per organisation for 60 seconds in this process (the poller asks
 * per user); `fresh` skips the memo, and a failed read throws and is never
 * memoised, so callers refuse on it.
 */

import { createRequire } from 'node:module';
import { GUID, normalizeTenantId } from '../../../auth/oauth/microsoftConnections.mts';
import type { MicrosoftProviderConfig } from '../../../auth/oauth/microsoftConnections.mts';

const nodeRequire = createRequire(import.meta.url);

export type OrgTenant =
    | { ok: true; tenantId: string; source: 'directory_binding' | 'single_org' }
    | { ok: false; reason: 'tenant_not_bound' | 'tenant_mismatch_sso' };

type AuthConfigLike = { providers?: { microsoft?: MicrosoftProviderConfig } } | null | undefined;

interface OrgTenantDeps {
    getSyncBinding: () => Promise<unknown>;
    loadConfig: () => Promise<AuthConfigLike>;
    getAllOrganizations: () => Promise<{ id?: unknown }[]>;
}

type LazyDeps<T> = { deps: T; init: (overrides?: Partial<T>) => void };
const { lazyDeps } = nodeRequire('../lazyDeps.js') as { lazyDeps: <T>(loaders: Record<string, () => unknown>) => LazyDeps<T> };
const lazy = lazyDeps<OrgTenantDeps>({
    getSyncBinding: () => {
        const configStore = nodeRequire('../../../stores/configStore.js') as { getConfigFresh: (key: string) => Promise<unknown> };
        return () => configStore.getConfigFresh('azure_group_sync_binding');
    },
    loadConfig: () => (nodeRequire('../../../auth/permissions.js') as Pick<OrgTenantDeps, 'loadConfig'>).loadConfig,
    getAllOrganizations: () => {
        const userStore = nodeRequire('../../../stores/userStore.js') as Pick<OrgTenantDeps, 'getAllOrganizations'>;
        return () => userStore.getAllOrganizations();
    },
});

export const ORG_TENANT_MEMO_MS = 60_000;
const memo = new Map<string, { at: number; value: OrgTenant }>();

/** Test seam: swap collaborators (the rest stay the real ones); also forgets the memo. */
export function init(overrides: Partial<OrgTenantDeps> = {}): void {
    lazy.init(overrides);
    memo.clear();
}

/** Forget every memoised answer. */
export function resetOrgTenantMemo(): void { memo.clear(); }

const lower = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/** The configured sign-in tenant when it is a directory GUID, else null. */
function configuredGuid(config: AuthConfigLike): string | null {
    const tid = normalizeTenantId(config?.providers?.microsoft?.tenantId);
    return tid && GUID.test(tid) ? tid : null;
}

async function resolve(orgId: string): Promise<OrgTenant> {
    const [binding, config] = await Promise.all([lazy.deps.getSyncBinding(), lazy.deps.loadConfig()]);
    const configured = configuredGuid(config);
    const b = (binding && typeof binding === 'object' ? binding : {}) as { syncOrganizationId?: unknown; syncTenantId?: unknown };
    const boundTenant = lower(b.syncTenantId);
    if (b.syncOrganizationId === orgId && GUID.test(boundTenant)) {
        if (configured && configured !== boundTenant) return { ok: false, reason: 'tenant_mismatch_sso' };
        return { ok: true, tenantId: boundTenant, source: 'directory_binding' };
    }
    if (configured) {
        const orgs = await lazy.deps.getAllOrganizations();
        if (Array.isArray(orgs) && orgs.length === 1 && orgs[0]?.id === orgId) return { ok: true, tenantId: configured, source: 'single_org' };
    }
    return { ok: false, reason: 'tenant_not_bound' };
}

/**
 * The verified tenant of `orgId`. Throws when the binding, the auth config or
 * the organisations cannot be read: a refusal, never a guess.
 */
export async function orgVerifiedTenant(orgId: string | null | undefined, { fresh = false, now = Date.now() }: { fresh?: boolean; now?: number } = {}): Promise<OrgTenant> {
    if (!orgId || typeof orgId !== 'string') return { ok: false, reason: 'tenant_not_bound' };
    if (!fresh) {
        const hit = memo.get(orgId);
        if (hit && now - hit.at < ORG_TENANT_MEMO_MS) return hit.value;
    }
    const value = await resolve(orgId);
    memo.set(orgId, { at: now, value });
    return value;
}
