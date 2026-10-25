import { useCallback, useEffect, useRef, useState } from 'react';
import { takePendingPlan } from '../../../components/billing/pendingPlan';
import type { TranslateFn } from '../../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../../utils/helpers';
import { isPaidPlan, type CheckoutMessage, type ConsumerPlan, type ConsumerUsageData } from './consumerBilling';
import { errorMessage } from '../../../utils/caughtError';
import { request, RefusedError } from '../../../api/mutate';

/** The checkout result Stripe sends back on the URL, read once and cleaned off. */
function readCheckoutResult(): CheckoutMessage | null {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get('checkout');
    if (outcome !== 'success' && outcome !== 'cancelled') return null;
    const url = new URL(window.location.href);
    url.searchParams.delete('checkout');
    if (outcome === 'success') url.searchParams.delete('session_id');
    window.history.replaceState({}, '', url.toString());
    return outcome === 'success'
        ? { type: 'success', text: 'Subscription activated! Your plan will be updated shortly.' }
        : { type: 'cancelled', text: 'Checkout was cancelled. You can try again anytime.' };
}

/**
 * A plan chosen on the public pricing page (`?plan=<id>`), carried across the
 * sign-in redirect. Highlighted and scrolled to rather than checked out
 * automatically — a paid plan still needs the withdrawal waiver ticked
 * deliberately, so that consent step must not be skipped.
 */
function usePreselectedPlan(plans: ConsumerPlan[]) {
    const [preselectedPlanId, setPreselectedPlanId] = useState<string | null>(null);
    const preselectedRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        if (!plans.length || preselectedPlanId) return;
        const pending = takePendingPlan();
        if (pending && plans.some(p => p.id === pending)) setPreselectedPlanId(pending);
    }, [plans, preselectedPlanId]);
    useEffect(() => {
        if (!preselectedPlanId || !preselectedRef.current) return;
        preselectedRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, [preselectedPlanId]);
    return { preselectedPlanId, preselectedRef };
}

/** POST to a Stripe redirect endpoint and follow the URL it answers with. */
async function redirectVia(path: string, body: Record<string, unknown>, fallbackError: string): Promise<CheckoutMessage | null> {
    try {
        const res = await authFetch(`${API_BASE}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const result = await res.json();
        if (res.ok && result.url) {
            window.location.href = result.url;
            return null;
        }
        return { type: 'error', text: result.error || fallbackError };
    } catch {
        return { type: 'error', text: 'Connection error. Please try again.' };
    }
}

/** Usage, plans and the Stripe checkout / portal round-trips of a consumer account. */
export default function useConsumerBilling(t: TranslateFn) {
    const [data, setData] = useState<ConsumerUsageData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null | undefined>(null);
    const [plans, setPlans] = useState<ConsumerPlan[]>([]);
    const [stripeEnabled, setStripeEnabled] = useState(false);
    const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null); // planId being loaded
    const [portalLoading, setPortalLoading] = useState(false);
    const [checkoutMessage, setCheckoutMessage] = useState<CheckoutMessage | null>(null); // success/cancel banner
    const [waiverAccepted, setWaiverAccepted] = useState<Record<string, boolean>>({}); // planId → withdrawal-waiver tick
    const preselection = usePreselectedPlan(plans);

    useEffect(() => {
        const result = readCheckoutResult();
        if (result) setCheckoutMessage(result);
    }, []);

    const fetchData = useCallback(async () => {
        try {
            setLoading(true);
            const [usageRes, statusRes] = await Promise.all([
                authFetch(`${API_BASE}/api/subscriptions/consumer/usage`),
                authFetch(`${API_BASE}/api/stripe/status`),
            ]);
            if (usageRes.ok) setData(await usageRes.json());
            else throw new Error('Failed to load usage data');
            if (statusRes.ok) {
                const status = await statusRes.json();
                setStripeEnabled(status.enabled);
                if (status.enabled) {
                    const plansRes = await request(`${API_BASE}/api/stripe/plans?type=consumer`).catch((err: unknown) => {
                        if (err instanceof RefusedError) return null;
                        throw err;
                    });
                    if (plansRes) setPlans(await plansRes.json());
                }
            }
        } catch (e) {
            console.error('[ConsumerLicense] fetch error:', e);
            setError(errorMessage(e));
        } finally {
            setLoading(false);
        }
    }, []);
    useEffect(() => { fetchData(); }, [fetchData]);

    const handleCheckout = async (plan: ConsumerPlan) => {
        const planId = plan.id;
        const isPaid = isPaidPlan(plan);
        // Paid digital service started immediately → consumer must have waived
        // the 14-day right of withdrawal (CRD art. 16(m) / BW 6:230p).
        if (isPaid && !waiverAccepted[planId]) {
            setCheckoutMessage({ type: 'error', text: t('checkout.withdrawal_waiver_required', 'Please confirm the waiver to start your paid plan immediately.') });
            return;
        }
        setCheckoutLoading(planId);
        const message = await redirectVia('/api/stripe/checkout', {
            planId,
            origin: window.location.origin,
            ...(isPaid ? { withdrawalWaiver: { accepted: true } } : {}),
        }, 'Failed to start checkout');
        if (message) setCheckoutMessage(message);
        setCheckoutLoading(null);
    };

    const handlePortal = async () => {
        setPortalLoading(true);
        const message = await redirectVia('/api/stripe/portal', { origin: window.location.origin }, 'Failed to open billing portal');
        if (message) setCheckoutMessage(message);
        setPortalLoading(false);
    };

    const setWaiver = (planId: string, accepted: boolean) => setWaiverAccepted(prev => ({ ...prev, [planId]: accepted }));

    return {
        data, loading, error, plans, stripeEnabled, checkoutLoading, portalLoading,
        checkoutMessage, setCheckoutMessage, waiverAccepted, setWaiver, handleCheckout, handlePortal, ...preselection,
    };
}

export type ConsumerBilling = ReturnType<typeof useConsumerBilling>;
