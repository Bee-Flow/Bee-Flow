// Settings → Usage: the subscription header (customer view), the model-tier
// config (tier badges) and the usage report itself. All three are reads where
// a non-ok answer or a failure is "nothing to show", never an exception.

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../utils/helpers';
import { logger } from '../../utils/logger';

const usageKeys = {
    subscription: ['settings', 'usage', 'subscription'] as const,
    tiers: ['settings', 'usage', 'tiers-for-user'] as const,
    report: (qs: string) => ['settings', 'usage', 'report', qs] as const,
};

const READ = { staleTime: 0, retry: false } as const;

/** The first organisation's subscription (plan, billing, cost cap); null when it cannot be read. */
export function useUsageSubscription() {
    return useQuery<Record<string, unknown> | null, Error>({
        queryKey: usageKeys.subscription,
        queryFn: async () => {
            try {
                const permsRes = await authFetch(`${API_BASE}/auth/my-permissions`);
                if (!permsRes.ok) return null;
                const perms = await permsRes.json();
                const orgId = (perms?.organizations || [])[0];
                if (!orgId) return null;
                const subRes = await authFetch(`${API_BASE}/api/subscriptions/orgs/${orgId}`);
                if (!subRes.ok) return null;
                return await subRes.json();
            } catch (err) { logger.debug('non-fatal', err); return null; }
        },
        ...READ,
    });
}

/** The raw tiers config of the direct-chat task; null when it cannot be read (badges fall back to the model). */
export function useUsageTiers<T>() {
    return useQuery<T | null, Error>({
        queryKey: usageKeys.tiers,
        queryFn: async () => {
            try {
                const res = await authFetch(`${API_BASE}/ai/config/tiers-for-user?taskType=direct_chat`);
                if (!res.ok) return null;
                const d = await res.json();
                return d?.tiers || d?.modelTiers || d;
            } catch (err) { logger.debug('non-fatal — falls back to model-only badges', err); return null; }
        },
        ...READ,
    });
}

/** The usage report for a query string; the previous report stays while the next loads. */
export function useUsageReport<D, A>(qs: string) {
    return useQuery<{ data: D; azure: A } | null, Error>({
        queryKey: usageKeys.report(qs),
        queryFn: async () => {
            try {
                const sj = async (r: Response, fb: unknown) => { try { if (!r.ok) return fb; const d = await r.json(); return d?.error ? fb : d; } catch { return fb; } };
                const sa = async (r: Response) => { const d = await sj(r, []); return Array.isArray(d) ? d : []; };

                const eps = ['summary', 'timeline', 'users', 'sources', 'agents', 'models', 'models-by-agent', 'models-by-user'];
                const results = await Promise.all(eps.map(ep => authFetch(`${API_BASE}/api/usage/${ep}?${qs}`)));
                const data = {
                    summary: await sj(results[0], {}),
                    timeline: await sa(results[1]),
                    users: await sa(results[2]),
                    sources: await sa(results[3]),
                    agents: await sa(results[4]),
                    models: await sa(results[5]),
                    modelsByAgent: await sa(results[6]),
                    modelsByUser: await sa(results[7]),
                };

                // The guardrails/integrations blocks (19 requests) left with
                // the Safety & Integrations tabs — see the Privacy Shield
                // Activity tab, which fetches its two consolidated overviews
                // only when it is actually open.
                const azEps = ['azure-services/summary', 'azure-services/by-type', 'azure-services/by-user'];
                const azResults = await Promise.all(azEps.map(ep => authFetch(`${API_BASE}/api/usage/${ep}?${qs}`)));
                const azure = {
                    summary: await sj(azResults[0], {}),
                    byType: await sa(azResults[1]),
                    byUser: await sa(azResults[2]),
                };
                return { data, azure } as { data: D; azure: A };
            } catch (err) { console.error('Failed to load usage', err); return null; }
        },
        placeholderData: keepPreviousData,
        ...READ,
    });
}
