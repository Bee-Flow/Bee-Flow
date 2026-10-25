// The reads behind the consumer Settings sections (beta features, integrations,
// privacy shield, usage). Each goes through `authFetch` inside queryFn: a
// non-ok answer is a state the section renders (empty / defaults), never an
// exception, exactly like the effects these replace.

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../utils/helpers';
import { errorMessage } from '../../utils/caughtError';
import { request, RefusedError } from '../mutate';

const consumerKeys = {
    betaFeatures: ['settings', 'consumer-beta-features'] as const,
    userSettings: ['settings', 'consumer-user-settings'] as const,
    shield: ['settings', 'consumer-shield'] as const,
    guardStatus: ['settings', 'consumer-guard-status'] as const,
    billing: ['settings', 'consumer-billing'] as const,
    usage: (days: number) => ['settings', 'consumer-usage', days] as const,
};

const READ = { staleTime: 0, retry: false } as const;

interface ConsumerFeatures {
    allowedBetaFeatures?: unknown;
    betaRegistry?: unknown;
}

/** GET /auth/me/consumer-features: the allow-list and the registry ([] / [] when it cannot be read). */
export function useConsumerBetaFeatures<F>() {
    return useQuery<{ allowed: string[]; registry: F[] }, Error>({
        queryKey: consumerKeys.betaFeatures,
        queryFn: async () => {
            try {
                const res = await authFetch(`${API_BASE}/auth/me/consumer-features`);
                if (res.ok) {
                    const data: ConsumerFeatures = await res.json();
                    return {
                        allowed: Array.isArray(data.allowedBetaFeatures) ? data.allowedBetaFeatures : [],
                        registry: Array.isArray(data.betaRegistry) ? data.betaRegistry : [],
                    };
                }
            } catch (e) {
                console.error('[ConsumerBeta] load error:', e);
            }
            return { allowed: [], registry: [] };
        },
        ...READ,
    });
}

/** GET /ai/user-settings: `enabledApps` (null = all enabled), or null when it cannot be read. */
export function useConsumerEnabledApps() {
    return useQuery<{ enabledApps: string[] | null } | null, Error>({
        queryKey: consumerKeys.userSettings,
        queryFn: async () => {
            try {
                const res = await authFetch(`${API_BASE}/ai/user-settings`);
                if (res.ok) {
                    const data = await res.json();
                    return { enabledApps: Array.isArray(data.enabledApps) ? data.enabledApps : null };
                }
            } catch (e) {
                console.error('[ConsumerIntegrations] load error:', e);
            }
            return null;
        },
        ...READ,
    });
}

/** GET /api/org-privacy-shield/user/me: the stored config (null when it cannot be read). */
export function useConsumerShieldConfig<C>() {
    return useQuery<(C & { implicitDefault?: boolean }) | null, Error>({
        queryKey: consumerKeys.shield,
        queryFn: async () => {
            try {
                const res = await authFetch(`${API_BASE}/api/org-privacy-shield/user/me`);
                if (res.ok) return await res.json();
            } catch (e) {
                console.error('[ConsumerPrivacy] fetch error:', e);
            }
            return null;
        },
        ...READ,
    });
}

/** GET /api/org-privacy-shield/user/guard-status (null when it cannot be read). */
export function useConsumerGuardStatus<G>() {
    return useQuery<G | null, Error>({
        queryKey: consumerKeys.guardStatus,
        queryFn: async () => {
            try {
                const res = await authFetch(`${API_BASE}/api/org-privacy-shield/user/guard-status`);
                if (res.ok) return await res.json();
            } catch (e) {
                console.error('[ConsumerPrivacy] guard-status error:', e);
            }
            return null;
        },
        ...READ,
    });
}

/** The four usage reads for a window of `days`; the previous window stays on screen while the next loads. */
export function useConsumerUsage<S, R, C>(days: number) {
    return useQuery<{ summary: S | null; costTimeline: C[]; byModel: R[]; bySource: R[] }, Error>({
        queryKey: consumerKeys.usage(days),
        queryFn: async () => {
            try {
                const [s, ct, m, src] = await Promise.all([
                    authFetch(`${API_BASE}/api/usage/summary?days=${days}`).then(r => r.ok ? r.json() : null),
                    authFetch(`${API_BASE}/api/usage/cost-timeline?days=${days}`).then(r => r.ok ? r.json() : []),
                    authFetch(`${API_BASE}/api/usage/by-model?days=${days}`).then(r => r.ok ? r.json() : []),
                    authFetch(`${API_BASE}/api/usage/sources?days=${days}`).then(r => r.ok ? r.json() : []),
                ]);
                return {
                    summary: s,
                    costTimeline: Array.isArray(ct) ? ct : [],
                    byModel: Array.isArray(m) ? m : [],
                    bySource: Array.isArray(src) ? src : [],
                };
            } catch (e) {
                console.error('[ConsumerUsage] load error:', e);
                return { summary: null, costTimeline: [], byModel: [], bySource: [] };
            }
        },
        placeholderData: keepPreviousData,
        ...READ,
    });
}

interface BillingSnapshot<U, P> {
    data: U | null;
    stripeEnabled: boolean;
    plans: P[];
    /** Set when a step failed; what was read before it stays in the snapshot. */
    error: string | null | undefined;
}

/** Consumer usage, whether Stripe is on, and the consumer plans: the three reads of Settings → Licence. */
export function useConsumerBillingData<U, P>() {
    return useQuery<BillingSnapshot<U, P>, Error>({
        queryKey: consumerKeys.billing,
        queryFn: async () => {
            const snapshot: BillingSnapshot<U, P> = { data: null, stripeEnabled: false, plans: [], error: null };
            try {
                const [usageRes, statusRes] = await Promise.all([
                    authFetch(`${API_BASE}/api/subscriptions/consumer/usage`),
                    authFetch(`${API_BASE}/api/stripe/status`),
                ]);
                if (usageRes.ok) snapshot.data = await usageRes.json();
                else throw new Error('Failed to load usage data');
                if (statusRes.ok) {
                    const status = await statusRes.json();
                    snapshot.stripeEnabled = status.enabled;
                    if (status.enabled) {
                        const plansRes = await request(`${API_BASE}/api/stripe/plans?type=consumer`).catch((err: unknown) => {
                            if (err instanceof RefusedError) return null;
                            throw err;
                        });
                        if (plansRes) snapshot.plans = await plansRes.json();
                    }
                }
            } catch (e) {
                console.error('[ConsumerLicense] fetch error:', e);
                snapshot.error = errorMessage(e);
            }
            return snapshot;
        },
        ...READ,
    });
}
