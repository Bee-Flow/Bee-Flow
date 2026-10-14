import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { BillingPlan, ChangePreview, OrgSubscription, SubMessage } from './licenseShared';
import type { TranslateFn } from '../../../../../hooks/useTranslation';
import { cloudFetch } from '../../../../../utils/cloudFetch';
import { API_BASE } from '../../../../../utils/helpers';

export interface SubscriptionActions {
    checkoutLoading: string | null;
    handleCheckout: (planId: string) => Promise<void>;
    portalLoading: boolean;
    handleManageBilling: () => Promise<void>;
    /** Inline plan picker for an org that is already subscribed. */
    showChangePlan: boolean;
    setShowChangePlan: Dispatch<SetStateAction<boolean>>;
    handleSelectChange: (plan: BillingPlan) => Promise<void>;
    previewLoading: boolean;
    changeTarget: BillingPlan | null;
    setChangeTarget: Dispatch<SetStateAction<BillingPlan | null>>;
    changePreview: ChangePreview | null;
    setChangePreview: Dispatch<SetStateAction<ChangePreview | null>>;
    changeBusy: boolean;
    handleConfirmChange: () => Promise<void>;
    cancelBusy: boolean;
    handleCancelDowngrade: () => Promise<void>;
    handleReactivateSubscription: () => Promise<void>;
    /** Opens the in-app confirmation; doCancelSubscription is what cancels. */
    handleCancelSubscription: () => void;
    doCancelSubscription: () => Promise<void>;
    showCancelConfirm: boolean;
    setShowCancelConfirm: Dispatch<SetStateAction<boolean>>;
}

interface UseSubscriptionActionsOptions {
    orgId: string | undefined;
    deploymentMode: string;
    t: TranslateFn;
    setSubscription: Dispatch<SetStateAction<OrgSubscription | null>>;
    setSubMessage: Dispatch<SetStateAction<SubMessage | null>>;
}

interface ApiError {
    message?: string;
    error?: string;
}

const errorText = (e: unknown) => (e as Error).message;

/** POST without a body; the answer is the updated subscription. Throws the server's wording on refusal. */
async function postSubscriptionAction(deploymentMode: string, orgId: string, action: string, fallback: string): Promise<OrgSubscription> {
    const res = await cloudFetch(deploymentMode, `${API_BASE}/api/subscriptions/orgs/${orgId}/${action}`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as ApiError).message || (data as ApiError).error || fallback);
    return data;
}

/** POST to a Stripe redirect endpoint and follow the URL it answers with. */
async function redirectThroughStripe(deploymentMode: string, path: string, body: Record<string, unknown>): Promise<string | null> {
    const res = await cloudFetch(deploymentMode, `${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = 'skipped' in res && res.skipped ? {} : await res.json();
    if (res.ok && data.url) {
        window.location.href = data.url;
        return null;
    }
    return data.error || '';
}

/** Checkout and the Billing Portal: both leave the app for Stripe. */
function useStripeRedirects({ deploymentMode, t, setSubMessage }: Pick<UseSubscriptionActionsOptions, 'deploymentMode' | 't' | 'setSubMessage'>) {
    const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);
    const [portalLoading, setPortalLoading] = useState(false);

    const handleCheckout = async (planId: string) => {
        setCheckoutLoading(planId);
        try {
            const err = await redirectThroughStripe(deploymentMode, '/api/stripe/checkout', { planId, origin: window.location.origin });
            if (err !== null) setSubMessage({ type: 'error', text: err || t('org.checkout_failed', 'Failed to start checkout') });
        } catch {
            setSubMessage({ type: 'error', text: t('org.payment_service_unreachable', 'Failed to connect to payment service') });
        } finally {
            setCheckoutLoading(null);
        }
    };

    const handleManageBilling = async () => {
        setPortalLoading(true);
        try {
            const err = await redirectThroughStripe(deploymentMode, '/api/stripe/portal', { origin: window.location.origin });
            if (err !== null) setSubMessage({ type: 'error', text: err || t('org.billing_portal_failed', 'Failed to open billing portal') });
        } catch {
            setSubMessage({ type: 'error', text: t('org.billing_portal_unreachable', 'Failed to connect to billing portal') });
        } finally {
            setPortalLoading(false);
        }
    };

    return { checkoutLoading, handleCheckout, portalLoading, handleManageBilling };
}

/** Moving to another plan: preview the prorated cost, then commit. */
function usePlanChange({ orgId, deploymentMode, t, setSubscription, setSubMessage }: UseSubscriptionActionsOptions) {
    const [showChangePlan, setShowChangePlan] = useState(false);
    const [changeTarget, setChangeTarget] = useState<BillingPlan | null>(null);
    const [changePreview, setChangePreview] = useState<ChangePreview | null>(null);
    const [previewLoading, setPreviewLoading] = useState(false);
    const [changeBusy, setChangeBusy] = useState(false);

    // Step 1: select a target and fetch the prorated cost preview. Opens the
    // confirmation modal once the preview resolves.
    const handleSelectChange = async (plan: BillingPlan) => {
        if (!orgId) return;
        setChangeTarget(plan);
        setChangePreview(null);
        setPreviewLoading(true);
        try {
            const res = await cloudFetch(deploymentMode, `${API_BASE}/api/subscriptions/orgs/${orgId}/preview-change`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ planId: plan.id }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.message || data.error || t('org.change_preview_failed', 'Could not preview this change'));
            setChangePreview(data);
        } catch (e) {
            setSubMessage({ type: 'error', text: errorText(e) });
            setChangeTarget(null);
        } finally {
            setPreviewLoading(false);
        }
    };

    // Step 2: commit. Same endpoint handles both directions — upgrades apply
    // now (prorated), downgrades are scheduled at period end by the server.
    const handleConfirmChange = async () => {
        if (!orgId || !changeTarget) return;
        setChangeBusy(true);
        try {
            const res = await cloudFetch(deploymentMode, `${API_BASE}/api/subscriptions/orgs/${orgId}/upgrade`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ planId: changeTarget.id }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                const friendly = data.message
                    || ({
                        payment_required: t('org.change_card_declined', 'Your card was declined. Update your payment method via "Manage Billing".'),
                        interval_mismatch: t('org.change_interval_mismatch', 'Switching between monthly and yearly billing is not available here. Contact info@beeflow.nl.'),
                    } as Record<string, string>)[data.error]
                    || data.error
                    || t('org.change_failed', 'Plan change failed');
                throw new Error(friendly);
            }
            setSubscription(data);
            const msg = changeTarget.direction === 'downgrade'
                ? t('org.downgrade_scheduled_msg', 'Downgrade scheduled for the end of this period.')
                : t('org.upgrade_done_msg', 'Plan upgraded. Stripe invoiced the prorated difference.');
            setSubMessage({ type: 'success', text: msg });
            setShowChangePlan(false);
            setChangeTarget(null);
            setChangePreview(null);
        } catch (e) {
            setSubMessage({ type: 'error', text: errorText(e) });
        } finally {
            setChangeBusy(false);
        }
    };

    return {
        showChangePlan, setShowChangePlan, handleSelectChange, previewLoading,
        changeTarget, setChangeTarget, changePreview, setChangePreview, changeBusy, handleConfirmChange,
    };
}

/** Cancelling, undoing a cancel, and undoing a scheduled downgrade. */
function useCancellation({ orgId, deploymentMode, t, setSubscription, setSubMessage }: UseSubscriptionActionsOptions) {
    const [cancelBusy, setCancelBusy] = useState(false);
    // In-app cancel confirmation (replaces the native window.confirm dialog).
    const [showCancelConfirm, setShowCancelConfirm] = useState(false);

    const run = async (action: string, fallback: string, success: string, after?: () => void) => {
        if (!orgId) return;
        setCancelBusy(true);
        try {
            setSubscription(await postSubscriptionAction(deploymentMode, orgId, action, fallback));
            setSubMessage({ type: 'success', text: success });
        } catch (e) {
            setSubMessage({ type: 'error', text: errorText(e) });
        } finally {
            setCancelBusy(false);
            after?.();
        }
    };

    const handleCancelDowngrade = () => run('cancel-downgrade',
        t('org.cancel_downgrade_failed', 'Could not cancel the scheduled change'),
        t('org.downgrade_cancelled_msg', 'Scheduled downgrade cancelled — you stay on your current plan.'));
    const doCancelSubscription = () => run('cancel',
        t('org.cancel_failed', 'Cancel failed'),
        t('org.cancel_scheduled_msg', 'Cancellation scheduled.'),
        () => setShowCancelConfirm(false));
    const handleReactivateSubscription = () => run('reactivate',
        t('org.reactivate_failed', 'Reactivate failed'),
        t('org.reactivated_msg', 'Subscription will continue.'));
    const handleCancelSubscription = () => setShowCancelConfirm(true);

    return {
        cancelBusy, handleCancelDowngrade, handleReactivateSubscription, handleCancelSubscription,
        doCancelSubscription, showCancelConfirm, setShowCancelConfirm,
    };
}

/** Every write on the subscription; each reports its outcome through setSubMessage. */
export default function useSubscriptionActions(opts: UseSubscriptionActionsOptions): SubscriptionActions {
    return {
        ...useStripeRedirects(opts),
        ...usePlanChange(opts),
        ...useCancellation(opts),
    };
}
