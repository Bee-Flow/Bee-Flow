/**
 * The subscription's lifecycle writes. Each answers the bare subscription row
 * (without `billing` or the plan pickers), so instead of adopting it every one
 * re-reads the full subscription before it resolves. None retries.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';

import {
    cancelDowngrade,
    cancelSubscription,
    changePlan,
    previewPlanChange,
    reactivateSubscription,
    shareInvoicePdf,
} from '../api/endpoints';
import { billingKeys } from '../api/keys';
import type { Invoice } from '../model/types';

function requireOrg(orgId: string | null): string {
    if (!orgId) throw new Error('No organisation');
    return orgId;
}

/** A write on the org's subscription that refreshes it (and the invoices) when it lands. */
function useSubscriptionWrite<V>(orgId: string | null, write: (orgId: string, vars: V) => Promise<void>) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (vars: V) => write(requireOrg(orgId), vars),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: billingKeys.all }),
    });
}

/** Step one of a plan change: what it costs today and from when (no write). */
export function usePreviewPlanChange(orgId: string | null) {
    return useMutation({ mutationFn: (planId: string) => previewPlanChange(requireOrg(orgId), planId) });
}

export function useChangePlan(orgId: string | null) {
    return useSubscriptionWrite(orgId, (id, planId: string) => changePlan(id, planId));
}

export function useCancelDowngrade(orgId: string | null) {
    return useSubscriptionWrite<void>(orgId, (id) => cancelDowngrade(id));
}

export function useCancelSubscription(orgId: string | null) {
    return useSubscriptionWrite<void>(orgId, (id) => cancelSubscription(id));
}

export function useReactivateSubscription(orgId: string | null) {
    return useSubscriptionWrite<void>(orgId, (id) => reactivateSubscription(id));
}

export function useShareInvoice() {
    return useMutation({ mutationFn: (invoice: Invoice) => shareInvoicePdf(invoice) });
}
