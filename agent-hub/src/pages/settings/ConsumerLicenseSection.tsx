import InvoicesPanel from '../../components/billing/InvoicesPanel';
import { useDeploymentMode } from '../../hooks/useDeploymentMode';
import { useTranslation } from '../../hooks/useTranslation';
import { hasPaidBillingRelationship } from '../../utils/billing';
import { API_BASE, authFetch } from '../../utils/helpers';
import { daysUntil } from './consumerLicense/consumerBilling';
import ConsumerPlanPicker from './consumerLicense/ConsumerPlanPicker';
import { CheckoutBanner, ConsumerLicenseSkeleton, PlanLimitsGrid, PlanSummaryCard, UpgradeCta, UsageThisPeriod } from './consumerLicense/ConsumerUsageParts';
import useConsumerBilling from './consumerLicense/useConsumerBilling';

async function fetchInvoices() {
    const res = await authFetch(`${API_BASE}/api/stripe/invoices`);
    if (!res.ok) throw new Error('Failed to load invoices');
    const data = await res.json();
    return data.invoices || [];
}

const fetchInvoicePdf = (invoiceId: string) => authFetch(`${API_BASE}/api/stripe/invoices/${invoiceId}/pdf`);

function scrollToPlans() {
    const el = document.getElementById('consumer-plan-picker');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Settings → Account → License & Usage for a consumer account. */
const ConsumerLicenseSection = (_props: { user?: unknown }) => {
    const { t } = useTranslation();
    const { isSelfHosted } = useDeploymentMode();
    const billing = useConsumerBilling(t);

    // Consumer Stripe checkout is a Bee Flow Cloud feature. On self-hosted
    // installs there are no consumer accounts (loginRoutes.js disables them)
    // and license keys are the paid-access mechanism, so the whole panel is
    // irrelevant.
    if (isSelfHosted) return null;
    if (billing.loading) return <ConsumerLicenseSkeleton />;
    if (billing.error) return (
        <div className="text-center py-12">
            <p className="text-sm text-[var(--text-muted)]">{t('settings.consumer_license.load_failed', 'Failed to load account data.')}</p>
        </div>
    );

    const { limits, usage, billing_period, subscription } = billing.data || {};
    const hasActiveSub = !!subscription && ['active', 'trialing'].includes(subscription.status ?? '');
    // BFSF-241: the Stripe Customer Portal only makes sense for a real paying
    // relationship. Free/trial/no-invoice users got an empty portal showing
    // global payment methods that don't match our checkout, so "Manage
    // Billing" is hidden until they've actually paid. The predicate is shared
    // with OrgInfoPanel and mirrors the server-side gate.
    const hasPaidBilling = hasPaidBillingRelationship(subscription);
    // Customer-facing: marked-up AI usage cost is the only AI figure shown.
    // Backend already applies markup_percent on `total_billed_cost`.
    const billedCost = Number(usage?.total_billed_cost) || 0;
    const costCap = (limits?.max_cost_per_month && limits.max_cost_per_month !== -1) ? limits.max_cost_per_month : null;
    const costPct = costCap ? Math.min(100, Math.round((billedCost / costCap) * 100)) : 0;
    const hasPlans = billing.stripeEnabled && billing.plans.length > 0;

    return (
        <div className="space-y-6 animate-fadeIn">
            <div>
                <h2 className="text-lg font-semibold text-[var(--text-primary)]">
                    {t('settings.license_usage', 'License & Usage')}
                </h2>
                <p className="text-sm text-[var(--text-muted)] mt-1">
                    {t('settings.consumer_license.subtitle', 'Your personal account usage and limits')}
                </p>
            </div>
            {billing.checkoutMessage && (
                <CheckoutBanner message={billing.checkoutMessage} onDismiss={() => billing.setCheckoutMessage(null)} />
            )}
            <PlanSummaryCard
                planName={limits?.plan_name}
                trialing={subscription?.payment_status === 'trialing'}
                hasActiveSub={hasActiveSub}
                daysLeft={daysUntil(billing_period?.end)}
                showPortal={hasPaidBilling}
                portalLoading={billing.portalLoading}
                onPortal={billing.handlePortal}
            />
            {costPct >= 80 && hasPlans && <UpgradeCta costPct={costPct} onUpgrade={scrollToPlans} />}
            {/* Invoices — in-app list with Stripe PDF downloads; no title
                means the panel's own default heading. */}
            {subscription?.stripe_customer_id && <InvoicesPanel fetcher={fetchInvoices} pdfFetcher={fetchInvoicePdf} title={undefined} />}
            <UsageThisPeriod billedCost={billedCost} limits={limits} />
            <PlanLimitsGrid limits={limits} />
            {hasPlans && <ConsumerPlanPicker billing={billing} hasActiveSub={hasActiveSub} currentPlanId={subscription?.plan_id} />}
        </div>
    );
};

export default ConsumerLicenseSection;
