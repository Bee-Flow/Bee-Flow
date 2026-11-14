/**
 * SubscriptionContext — single source of truth for the org's current
 * Stripe subscription, used by the App shell to gate access when no
 * active plan is in place.
 *
 * `hasActiveSub` is the gate signal:
 *   - true  → org has status `active` or `trialing`
 *   - false → no subscription, expired, suspended, cancelled → app
 *             shell should redirect non-admin users to the License page.
 *
 * The fetch is best-effort and tolerant: 404s/network errors leave the
 * state at "no subscription" which is the safe default for the gate.
 */

import { createContext, useContext } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { OrgSubscription } from '../admin/org/orgInfo/license/licenseShared';
import { cloudFetch } from '../../api/cloudFetch';
import { apiUrl } from '@/api/typedRequest';

export interface Subscription extends OrgSubscription {
    status: string;
}

interface SubscriptionContextValue {
    sub: Subscription | null;
    loading: boolean;
    hasActiveSub: boolean;
    refresh: () => void;
}

interface SubscriptionUser {
    organizationId?: string;
    orgId?: string;
    featureFlags?: { deploymentMode?: string };
}

interface SubscriptionProviderProps {
    children?: ReactNode;
    user?: SubscriptionUser | null;
}

const SubscriptionContext = createContext<SubscriptionContextValue>({
    sub: null,
    loading: true,
    hasActiveSub: false,
    refresh: () => {},
});

export function SubscriptionProvider({ children, user }: SubscriptionProviderProps) {
    // Consumer accounts (no org) and the platform-operator user fall
    // through with no subscription state — the gate ignores them.
    const orgId = user?.organizationId || user?.orgId;
    const deploymentMode = user?.featureFlags?.deploymentMode || 'cloud';
    const query = useQuery<Subscription | null>({
        queryKey: ['subscription', 'org', orgId, deploymentMode],
        enabled: !!orgId,
        staleTime: 0,
        retry: false,
        queryFn: async () => {
            try {
                const r = await cloudFetch(deploymentMode, apiUrl('GET /api/subscriptions/orgs/{orgId}', { params: { orgId: orgId as string } }));
                return (r?.ok ? await r.json() : null) || null;
            } catch {
                return null;
            }
        },
    });
    const sub = orgId ? query.data ?? null : null;
    const loading = !!orgId && query.isFetching;
    const { refetch } = query;

    const hasActiveSub = !!sub && ['active', 'trialing'].includes(sub.status);
    const value = { sub, loading, hasActiveSub, refresh: () => { void refetch(); } };

    return (
        <SubscriptionContext.Provider value={value}>
            {children}
        </SubscriptionContext.Provider>
    );
}

export function useSubscriptionContext() {
    return useContext(SubscriptionContext);
}

