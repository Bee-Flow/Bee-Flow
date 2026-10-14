import { useId } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import ActiveSubscriptionView from './license/ActiveSubscriptionView';
import { CancelSubscriptionDialog, ChangePlanDialog } from './license/LicenseDialogs';
import { useLicenseText } from './license/licenseShared';
import type { OrgUsageData } from './license/licenseShared';
import { NoSubscriptionOffers } from './license/PlanOffers';
import { CheckoutSettlingNotice, ServerOverrideNotice, SubMessageBanner } from './license/SubscriptionNotices';
import UsageSharingToggle from './license/UsageSharingToggle';
import type { OrgSubscriptionState } from './license/useOrgSubscription';

interface OrgLicenseSectionProps<T extends OrgUsageData> {
    /** The licence context; only whether a server-wide licence overrides the org is read. */
    licenseCtx: { serverOverride?: boolean } | null | undefined;
    /** The org runs on a licence key, so it is not offered a subscription. */
    hasActiveLicenseKey: boolean;
    isCloud: boolean;
    deploymentMode: string;
    orgData: T | null;
    setOrgData: Dispatch<SetStateAction<T | null>>;
    /** The subscription and every action on it (useOrgSubscription). */
    billing: OrgSubscriptionState;
    goToUsersPanel: () => void;
}

function SubscriptionSkeleton() {
    return (
        <div className="space-y-4 animate-pulse">
            <div className="h-28 rounded-2xl bg-[var(--bg-tertiary)]" />
            <div className="h-40 rounded-2xl bg-[var(--bg-tertiary)]" />
        </div>
    );
}

// ── License & Usage section. The subscription state lives in useOrgSubscription
// on the parent (OrgInfoPanel) and arrives as `billing`.
const OrgLicenseSection = <T extends OrgUsageData>({
    licenseCtx,
    hasActiveLicenseKey,
    isCloud,
    deploymentMode,
    orgData,
    setOrgData,
    billing,
    goToUsersPanel,
}: OrgLicenseSectionProps<T>) => {
    const { t } = useLicenseText();
    const { subscription: sub, subLoading, subMessage, setSubMessage, checkoutSettling, availablePlans, checkoutLoading, handleCheckout } = billing;
    const { changeTarget, changePreview, showCancelConfirm } = billing;
    const limits = sub?.effective_limits || {};
    const serverOverride = !!licenseCtx?.serverOverride;
    // The two confirmations below are labelled by their headings.
    const dialogIds = useId();

    const renderSubscription = () => {
        if (subLoading) return <SubscriptionSkeleton />;
        // The org runs on a licence key (managed under Admin → Server licence /
        // License keys), so the Stripe "No subscription" placeholder and plan
        // list would only confuse it.
        if (!sub && hasActiveLicenseKey) return null;
        if (!sub) {
            return <NoSubscriptionOffers isCloud={isCloud} plans={availablePlans} checkoutLoading={checkoutLoading} onCheckout={handleCheckout} />;
        }
        return <ActiveSubscriptionView sub={sub} billing={billing} isCloud={isCloud} deploymentMode={deploymentMode} goToUsersPanel={goToUsersPanel} />;
    };

    return (
        <div className="max-w-3xl space-y-6 animate-fadeIn">
            <div>
                {/* Heading reflects whether this org is on a real paid subscription:
                    "Subscription & Usage" when it is, "License & Usage" otherwise. */}
                <h2 className="text-lg font-semibold text-[var(--text-primary)]">
                    {(sub?.stripe_subscription_id || (sub?.billing?.subscription_total as number || 0) > 0)
                        ? t('org.subscription_usage', 'Subscription & Usage')
                        : t('org.license_usage')}
                </h2>
                <p className="mt-1 text-sm text-[var(--text-muted)]">{t('org.license_subtitle')}</p>
            </div>

            {subMessage && <SubMessageBanner message={subMessage} onDismiss={() => setSubMessage(null)} />}

            {serverOverride && <ServerOverrideNotice />}

            {!serverOverride && checkoutSettling && <CheckoutSettlingNotice />}

            {!serverOverride && renderSubscription()}

            {/* ── AI usage sharing (moved here from Org Info) ──
                Only shown when a subscription with a real cost
                budget is bound to the org; the toggle merely splits
                that budget, so it's meaningless (and hidden) on the
                free Community / no-subscription tier. */}
            {!serverOverride && orgData && sub
                && limits.max_cost_per_month != null && limits.max_cost_per_month !== -1 && (
                <UsageSharingToggle orgData={orgData} setOrgData={setOrgData} />
            )}

            {/* ── Change-plan confirmation modal ── */}
            {changeTarget && changePreview && (
                <ChangePlanDialog
                    target={changeTarget}
                    preview={changePreview}
                    labelId={dialogIds + '-change'}
                    setChangeTarget={billing.setChangeTarget}
                    setChangePreview={billing.setChangePreview}
                    changeBusy={billing.changeBusy}
                    handleConfirmChange={billing.handleConfirmChange}
                />
            )}

            {/* ── Cancel-subscription confirmation modal (in-app, not window.confirm) ── */}
            {showCancelConfirm && (
                <CancelSubscriptionDialog
                    labelId={dialogIds + '-cancel'}
                    cancelBusy={billing.cancelBusy}
                    setShowCancelConfirm={billing.setShowCancelConfirm}
                    doCancelSubscription={billing.doCancelSubscription}
                />
            )}
        </div>
    );
};

export default OrgLicenseSection;
