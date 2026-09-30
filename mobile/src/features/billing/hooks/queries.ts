/**
 * Reads for the License & Usage screens. Each asks only when the screen may
 * use the answer: an org admin on a cloud deployment (the screens decide).
 */

import { useQuery } from '@tanstack/react-query';

import { getOrgSubscription, getStripePlans, getStripeStatus, listInvoices } from '../api/endpoints';
import { billingKeys } from '../api/keys';

export function subscriptionQuery(orgId: string) {
    return {
        queryKey: billingKeys.subscription(orgId),
        queryFn: ({ signal }: { signal?: AbortSignal }) => getOrgSubscription(orgId, signal),
    };
}

/** Null data is "no subscription": the plans to choose from are offered instead. */
export function useSubscription(orgId: string | null) {
    return useQuery({ ...subscriptionQuery(orgId ?? 'none'), enabled: Boolean(orgId), retry: false });
}

export function useStripeStatus(enabled: boolean) {
    return useQuery({
        queryKey: billingKeys.stripeStatus,
        queryFn: ({ signal }) => getStripeStatus(signal),
        enabled,
        staleTime: 5 * 60_000,
    });
}

/** The plans on sale; an empty list when Stripe is off. */
export function useStripePlans(enabled: boolean) {
    return useQuery({
        queryKey: billingKeys.plans,
        queryFn: ({ signal }) => getStripePlans(signal),
        enabled,
        staleTime: 5 * 60_000,
    });
}

export function useInvoices(enabled: boolean) {
    return useQuery({ queryKey: billingKeys.invoices, queryFn: ({ signal }) => listInvoices(signal), enabled });
}

/**
 * The subscription as the org settings frame reads it: `{ sub }`, where a null
 * `sub` is "no subscription" (an answer, not an error). Under a server-wide
 * licence nothing is asked and the frame gets that answer at once.
 */
export function useSubscriptionFrame(orgId: string | null, serverOverride: boolean) {
    const query = useSubscription(serverOverride ? null : orgId);
    if (serverOverride) return { ...query, isLoading: false, isError: false, data: { sub: null } };
    return { ...query, data: query.data === undefined ? undefined : { sub: query.data } };
}
