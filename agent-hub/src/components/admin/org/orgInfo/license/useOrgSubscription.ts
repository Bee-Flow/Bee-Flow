import { useCallback, useEffect, useState, useEffectEvent } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { BillingPlan, OrgSubscription, SubMessage } from './licenseShared';
import type { TranslateFn } from '@/hooks/useTranslation';
import { cloudFetch } from '@/api/cloudFetch';
import { API_BASE } from '@/utils/helpers';
import useSubscriptionActions from './useSubscriptionActions';
import type { SubscriptionActions } from './useSubscriptionActions';
import { logger } from '@/utils/logger';

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

        const sessionId = params.get('session_id');
        let cancelled = false;
        setCheckoutSettling(true);
        const deadline = Date.now() + 30000;
        (async () => {
            while (!cancelled && Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 1500));
                try {
                    // Reconcile straight from the Stripe session so activation
                    // doesn't depend on the webhook landing in time (or at all).
                    if (sessionId) {
                        await cloudFetch(deploymentMode, `${API_BASE}/api/stripe/sessions/${encodeURIComponent(sessionId)}`).catch(() => {});
                    }
                    const res = await cloudFetch(deploymentMode, `${API_BASE}/api/subscriptions/orgs/${orgId}`);
                    if (res?.ok) {
                        const fresh: OrgSubscription | null = await res.json();
                        if (fresh && (fresh.status === 'active' || fresh.status === 'trialing')) {
                            if (cancelled) return;
                            setSubscription(fresh);
                            setCheckoutSettling(false);
                            setSubMessage({ type: 'success', text: t('org.subscription_activated', 'Subscription activated!') });
                            clearCheckoutParams();
                            return;
                        }
                    }
                } catch (err) { logger.debug('keep polling', err); }
            }
            if (!cancelled) {
                setCheckoutSettling(false);
                setSubMessage({
                    type: 'error',
                    text: t('org.activation_delayed', 'Payment received, but activation is taking longer than expected. Refresh in a minute or email info@beeflow.nl.'),
                });
                clearCheckoutParams();
            }
        })();
        return () => { cancelled = true; };
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
    const [subscription, setSubscription] = useState<OrgSubscription | null>(null);
    const [subLoading, setSubLoading] = useState(false);
    const [availablePlans, setAvailablePlans] = useState<BillingPlan[]>([]);
    const [stripeEnabled, setStripeEnabled] = useState(false);
    // Kept apart from the org form's own message so a subscription result
    // never appears in the org-info save bar, and stays until it is read.
    const [subMessage, setSubMessage] = useState<SubMessage | null>(null);

    const fetchSubscription = useCallback(async (id: string) => {
        if (!id) return;
        setSubLoading(true);
        try {
            const res = await cloudFetch(deploymentMode, `${API_BASE}/api/subscriptions/orgs/${id}`);
            if (res?.ok) {
                setSubscription(await res.json());
            } else {
                // 403 = user not in org or no subscription assigned — expected, handle silently.
                // skipped = self-hosted (no /api/subscriptions mount).
                setSubscription(null);
            }
        } catch (err) {
            // Network error — not a 403, log it
            console.warn('[OrgInfoPanel] Failed to fetch subscription:', err);
            setSubscription(null);
        } finally {
            setSubLoading(false);
        }
    }, [deploymentMode]);

    // Fetch available Stripe plans and status
    const fetchStripePlans = useCallback(async () => {
        try {
            const [statusRes, plansRes] = await Promise.all([
                cloudFetch(deploymentMode, `${API_BASE}/api/stripe/status`),
                cloudFetch(deploymentMode, `${API_BASE}/api/stripe/plans`),
            ]);
            if (statusRes?.ok) {
                const statusData = await statusRes.json();
                setStripeEnabled(statusData.enabled);
            }
            if (plansRes?.ok) {
                setAvailablePlans(await plansRes.json());
            }
        } catch (err) {
            console.warn('[OrgInfoPanel] Failed to fetch Stripe plans:', err);
        }
    }, [deploymentMode]);

    useEffect(() => {
        if (orgId) {
            fetchSubscription(orgId);
        }
        fetchStripePlans();
    }, [orgId, fetchSubscription, fetchStripePlans]);

    const checkoutSettling = useCheckoutReturn(orgId, deploymentMode, t, setSubscription, setSubMessage);
    const actions = useSubscriptionActions({ orgId, deploymentMode, t, setSubscription, setSubMessage });

    return {
        subscription, subLoading, availablePlans, stripeEnabled,
        subMessage, setSubMessage, checkoutSettling,
        ...actions,
    };
}
