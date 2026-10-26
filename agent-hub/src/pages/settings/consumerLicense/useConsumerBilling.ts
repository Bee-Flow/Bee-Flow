import { useEffect, useRef, useState } from 'react';
import { takePendingPlan } from '@/components/billing/pendingPlan';
import type { TranslateFn } from '@/hooks/useTranslation';
import { API_BASE } from '@/utils/helpers';
import { useConsumerBillingData } from '@/api/queries/settingsConsumer';
import { isPaidPlan, type CheckoutMessage, type ConsumerPlan, type ConsumerUsageData } from './consumerBilling';
import { mutate, errorBody, RefusedError } from '@/api/mutate';

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

const NO_PLANS: ConsumerPlan[] = [];

/** POST to a Stripe redirect endpoint and follow the URL it answers with. */
async function redirectVia(path: string, body: Record<string, unknown>, fallbackError: string): Promise<CheckoutMessage | null> {
    try {
        const res = await mutate(`${API_BASE}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const result = await res.json();
        if (result.url) {
            window.location.href = result.url;
            return null;
        }
        return { type: 'error', text: result.error || fallbackError };
    } catch (err) {
        // A refusal answers with its own JSON (error text); anything unreadable is a connection problem.
        const refused = err instanceof RefusedError ? errorBody(err) : null;
        if (refused) return { type: 'error', text: refused.error || fallbackError };
        return { type: 'error', text: 'Connection error. Please try again.' };
    }
}

/** Usage, plans and the Stripe checkout / portal round-trips of a consumer account. */
export default function useConsumerBilling(t: TranslateFn) {
    const query = useConsumerBillingData<ConsumerUsageData, ConsumerPlan>();
    const data = query.data?.data ?? null;
    const loading = query.isPending;
    const error = query.data?.error ?? null;
    const plans = query.data?.plans ?? NO_PLANS;
    const stripeEnabled = !!query.data?.stripeEnabled;
    const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null); // planId being loaded
    const [portalLoading, setPortalLoading] = useState(false);
    const [checkoutMessage, setCheckoutMessage] = useState<CheckoutMessage | null>(readCheckoutResult); // success/cancel banner (read once, off the URL, on mount)
    const [waiverAccepted, setWaiverAccepted] = useState<Record<string, boolean>>({}); // planId → withdrawal-waiver tick
    const preselection = usePreselectedPlan(plans);

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
