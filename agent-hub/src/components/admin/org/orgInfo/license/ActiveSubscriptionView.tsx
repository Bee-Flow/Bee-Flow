import { useEffect, useRef } from 'react';
import { useLicenseText } from './licenseShared';
import type { OrgSubscription } from './licenseShared';
import { ChangePlanPicker, PlanSummaryCard } from './PlanChange';
import { UpgradeToPaidOffers } from './PlanOffers';
import { BillingCard, PlanLimitsCard, UsageCard } from './SubscriptionCards';
import { HighestPlanNotice, ScheduledCancelBanner, ScheduledDowngradeBanner, UsageUpgradeCta } from './SubscriptionNotices';
import type { OrgSubscriptionState } from './useOrgSubscription';
import { cloudFetch } from '../../../../../utils/cloudFetch';
import { API_BASE } from '../../../../../utils/helpers';
import InvoicesPanel from '../../../../billing/InvoicesPanel';

interface ActiveSubscriptionViewProps {
    sub: OrgSubscription;
    billing: OrgSubscriptionState;
    isCloud: boolean;
    deploymentMode: string;
    goToUsersPanel: () => void;
}

/** What the page derives from the subscription to decide what to offer. */
function deriveSubscriptionFacts(sub: OrgSubscription, isCloud: boolean) {
    const limits = sub.effective_limits || {};
    const usage = sub.current_usage || {};
    // Member-facing org view always shows marked-up cost — message/token
    // counts are deliberately hidden. The upgrade CTA fires when AI usage
    // cost approaches the plan's cost cap (if one is set).
    const orgCostPct = (limits.max_cost_per_month && limits.max_cost_per_month !== -1)
        ? Math.min(100, Math.round(((usage.cost || 0) / limits.max_cost_per_month) * 100))
        : 0;
    const changeable = Array.isArray(sub.changeable_plans) ? sub.changeable_plans : null;
    // The in-page plan picker exists only for a Stripe-managed subscription
    // with a plan to move to, and not while a cancel or downgrade is pending.
    const canChangePlan = !!(isCloud && sub.stripe_subscription_id && changeable
        && changeable.length > 0 && !sub.cancel_at_period_end && !sub.pending_plan_id);
    // The near-cap banner's "Upgrade plan" opens that picker, so it needs an
    // actual upgrade in it.
    const canUpgradePlan = canChangePlan && !!changeable?.some(p => p.direction !== 'downgrade');
    // Per-seat subscriptions carry "Add user" and the seat hint in the billing
    // card; the plan-limits card repeats them only when that card is absent.
    const billingCardHasSeats = !!(sub.billing && Number(sub.billing.subscription_total) > 0 && sub.billing.per_seat);
    // Highest-plan message: only when there's a paying sub and the server has
    // no changeable plans (and we're not mid-cancel/pending).
    const onHighestPlan = !!(isCloud && sub.stripe_subscription_id && (sub.billing?.subscription_total as number || 0) > 0
        && changeable && changeable.length === 0 && !sub.cancel_at_period_end && !sub.pending_plan_id);
    return { limits, usage, orgCostPct, canChangePlan, canUpgradePlan, billingCardHasSeats, onHighestPlan };
}

/** The License & Usage page for an org that has a subscription. */
export default function ActiveSubscriptionView({ sub, billing, isCloud, deploymentMode, goToUsersPanel }: ActiveSubscriptionViewProps) {
    const { t } = useLicenseText();
    const { limits, usage, orgCostPct, canChangePlan, canUpgradePlan, billingCardHasSeats, onHighestPlan } = deriveSubscriptionFacts(sub, isCloud);
    const { showChangePlan, setShowChangePlan, availablePlans, checkoutLoading, handleCheckout, cancelBusy } = billing;
    // The picker opens above the banner that asks for it, so bring it into view.
    const changePlanRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        if (showChangePlan) changePlanRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    }, [showChangePlan]);
    const openUpgradePicker = () => {
        setShowChangePlan(true);
        // Already open: the effect will not run again, so scroll here too.
        changePlanRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    };

    return (
        <>
            <PlanSummaryCard sub={sub} limits={limits} canChangePlan={canChangePlan} billing={billing} />

            {/* Invoices — in-app list with Stripe PDF downloads */}
            {sub.stripe_customer_id && (
                <InvoicesPanel
                    title={undefined}
                    fetcher={async () => {
                        const res = await cloudFetch(deploymentMode, `${API_BASE}/api/stripe/invoices`);
                        if (!res.ok) throw new Error(t('billing.invoices_load_failed', 'Failed to load invoices'));
                        const data = await res.json();
                        return data.invoices || [];
                    }}
                    pdfFetcher={(invoiceId: string) => cloudFetch(deploymentMode, `${API_BASE}/api/stripe/invoices/${invoiceId}/pdf`) as Promise<Response>}
                />
            )}

            {showChangePlan && canChangePlan && (
                <ChangePlanPicker
                    plans={sub.changeable_plans || []}
                    pickerRef={changePlanRef}
                    handleSelectChange={billing.handleSelectChange}
                    previewLoading={billing.previewLoading}
                    changeTarget={billing.changeTarget}
                />
            )}

            {sub.pending_plan_id && (
                <ScheduledDowngradeBanner sub={sub} busy={cancelBusy} onUndo={billing.handleCancelDowngrade} />
            )}

            {onHighestPlan && <HighestPlanNotice />}

            {isCloud && !sub.stripe_subscription_id && availablePlans.length > 0 && (
                <UpgradeToPaidOffers plans={availablePlans} checkoutLoading={checkoutLoading} onCheckout={handleCheckout} />
            )}

            {sub.cancel_at_period_end && (
                <ScheduledCancelBanner sub={sub} busy={cancelBusy} onUndo={billing.handleReactivateSubscription} />
            )}

            {/* Subscription billing card */}
            {sub.billing && Number(sub.billing.subscription_total) > 0 && (
                <BillingCard
                    sub={sub}
                    billing={sub.billing}
                    cancelBusy={cancelBusy}
                    onCancel={billing.handleCancelSubscription}
                    onAddUser={goToUsersPanel}
                />
            )}

            {orgCostPct >= 80 && (
                <UsageUpgradeCta pct={orgCostPct} onUpgrade={canUpgradePlan ? openUpgradePicker : null} />
            )}

            <UsageCard used={usage.cost || 0} limit={limits.max_cost_per_month} />

            <PlanLimitsCard sub={sub} limits={limits} billingCardHasSeats={billingCardHasSeats} onAddUser={goToUsersPanel} />
        </>
    );
}
