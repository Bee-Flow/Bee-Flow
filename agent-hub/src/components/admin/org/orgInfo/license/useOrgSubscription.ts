import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState, useEffectEvent } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { BillingPlan, OrgSubscription, SubMessage } from './licenseShared';
import type { TranslateFn } from '@/hooks/useTranslation';
import useSubscriptionActions from './useSubscriptionActions';
import type { SubscriptionActions } from './useSubscriptionActions';
import { orgSubscriptionKey, useOrgSubscriptionQuery, useSettleCheckout, useStripeOfferQuery } from '@/api/queries/orgSubscription';

export interface OrgSubscriptionState extends SubscriptionActions {
    subscription: OrgSubscription | null;
    subLoading: boolean;
    availablePlans: BillingPlan[];
    stripeEnabled: boolean;
    /** Subscription actions (upgrade/downgrade/cancel/checkout/portal) report here. */
    subMessage: SubMessage | null;
    setSubMessage: Dispatch<SetStateAction<SubMessage | null>>;
    /** True between landing on ?checkout=success and the subscription turning active. */
    checkoutSettling: boolean;
}

/** Strip ?checkout=… once it has been answered, so a reload does not answer it again. */
function clearCheckoutParams() {
    window.history.replaceState({}, '', window.location.pathname);
}

/**
 * Handle the Stripe checkout return URL. The success branch polls every 1.5s
 * for up to 30s until the subscription flips to active/trialing — a single
 * setTimeout left the UI showing "no subscription" when the webhook took
 * longer than 2s, which is the common path on first checkout (Stripe issues
 * the event after the redirect).
 */
function useCheckoutReturn(
    orgId: string | undefined,
    deploymentMode: string,
    t: TranslateFn,
    setSubscription: Dispatch<SetStateAction<OrgSubscription | null>>,
    setSubMessage: Dispatch<SetStateAction<SubMessage | null>>,
): boolean {
    const [checkoutSettling, setCheckoutSettling] = useState(false);
    const { mutate: settle } = useSettleCheckout<OrgSubscription>();
    const settleCheckout = useEffectEvent(() => {
        if (!orgId) return;
        const params = new URLSearchParams(window.location.search);
        const status = params.get('checkout');
        if (status === 'cancelled') {
            setSubMessage({ type: 'error', text: t('org.checkout_cancelled', 'Checkout was cancelled. No changes were made.') });
            clearCheckoutParams();
            return;
        }
        if (status !== 'success') return;

        const leaving = new AbortController();
        setCheckoutSettling(true);
        settle({ orgId, deploymentMode, sessionId: params.get('session_id'), signal: leaving.signal }, {
            onSuccess: (fresh) => {
                if (leaving.signal.aborted) return;
                setCheckoutSettling(false);
                if (fresh) {
                    setSubscription(fresh);
                    setSubMessage({ type: 'success', text: t('org.subscription_activated', 'Subscription activated!') });
                } else {
                    setSubMessage({
                        type: 'error',
                        text: t('org.activation_delayed', 'Payment received, but activation is taking longer than expected. Refresh in a minute or email info@beeflow.nl.'),
                    });
                }
                clearCheckoutParams();
            },
        });
        return () => leaving.abort();
    });
    useEffect(() => { return settleCheckout(); }, [orgId]);
    return checkoutSettling;
}

/**
 * The organisation's Stripe subscription: what it is on, what it could buy,
 * and every action on it. Reads go through cloudFetch, so a self-hosted
 * install (no subscription routes) simply has no subscription.
 */
export default function useOrgSubscription(orgId: string | undefined, deploymentMode: string, t: TranslateFn): OrgSubscriptionState {
    const queryClient = useQueryClient();
    const subscriptionQuery = useOrgSubscriptionQuery<OrgSubscription>(orgId, deploymentMode);
    const offer = useStripeOfferQuery<BillingPlan>(deploymentMode).data;
    // Kept apart from the org form's own message so a subscription result
    // never appears in the org-info save bar, and stays until it is read.
    const [subMessage, setSubMessage] = useState<SubMessage | null>(null);

    // An action's answer (a plan change, a cancellation, the return from checkout) is the subscription from then on.
    const subscriptionKey = useMemo(() => orgSubscriptionKey(deploymentMode, orgId), [deploymentMode, orgId]);
    const setSubscription: Dispatch<SetStateAction<OrgSubscription | null>> = useCallback((next) => {
        queryClient.setQueryData<OrgSubscription | null>(subscriptionKey, (prev) => (typeof next === 'function' ? next(prev ?? null) : next));
    }, [queryClient, subscriptionKey]);

    const checkoutSettling = useCheckoutReturn(orgId, deploymentMode, t, setSubscription, setSubMessage);
    const actions = useSubscriptionActions({ orgId, deploymentMode, t, setSubscription, setSubMessage });

    return {
        subscription: subscriptionQuery.data ?? null,
        subLoading: !!orgId && subscriptionQuery.isFetching,
        availablePlans: offer?.plans ?? NO_PLANS,
        stripeEnabled: offer?.enabled ?? false,
        subMessage, setSubMessage, checkoutSettling,
        ...actions,
    };
}

const NO_PLANS: BillingPlan[] = [];
