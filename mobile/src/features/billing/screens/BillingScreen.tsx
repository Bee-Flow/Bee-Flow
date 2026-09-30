/**
 * License & Usage (web: orgInfo/OrgLicenseSection.jsx with the handlers of
 * OrgInfoPanel.jsx). The organisation's Stripe subscription: the plan and its
 * status, scheduled changes and their undo, what a cycle costs, AI usage
 * against the cap, the plan's limits and the usage-sharing switch.
 *
 * Choosing or changing a plan has its own screen (Plans), and so do the
 * invoices. Checkout and the Customer Portal open in the in-app browser; the
 * screen settles a Checkout when the app comes back to the foreground (see
 * hooks/useStripeHandoff.ts). Cloud only, org admins only.
 */

import { useRouter } from 'expo-router';
import React from 'react';

import { useTranslation } from '@/core/i18n';
import { OrgSettingsFrame, useOrganization } from '@/features/org';
import { Banner } from '@/shared/ui';

import { HandoffBanners } from '../components/HandoffBanners';
import { NoSubscriptionGroup } from '../components/NoSubscriptionGroup';
import { SubscriptionBody } from '../components/SubscriptionBody';
import { UsageSharingGroup } from '../components/UsageSharingGroup';
import { useStripePlans, useSubscriptionFrame } from '../hooks/queries';
import { useBillingAccess } from '../hooks/useBillingAccess';
import { useBillingActions } from '../hooks/useBillingActions';
import { useStripeHandoff } from '../hooks/useStripeHandoff';
import { isPaidSubscription, showUsageSharing } from '../model/subscription';
import type { Subscription } from '../model/types';

export function BillingScreen() {
    const t = useTranslation();
    const router = useRouter();
    const { orgId, allowed, denied, serverOverride } = useBillingAccess();
    const live = allowed && !serverOverride;
    const query = useSubscriptionFrame(allowed ? orgId : null, serverOverride);
    const plans = useStripePlans(live);
    const org = useOrganization(allowed ? orgId : null);
    const handoff = useStripeHandoff(orgId);
    const actions = useBillingActions(orgId);
    const sub: Subscription | null = query.data?.sub ?? null;
    const planList = plans.data ?? [];

    return (
        <OrgSettingsFrame
            title={
                isPaidSubscription(sub)
                    ? t('org.subscription_usage', 'Subscription & Usage')
                    : t('org.license_usage', 'License & Usage')
            }
            subtitle={t('org.license_subtitle', 'Your current plan and usage for this billing period')}
            allowed={allowed}
            denied={denied}
            query={query}
            onRefresh={() => plans.refetch()}
        >
            {({ sub: current }) => (
                <>
                    <HandoffBanners notice={handoff.notice} settling={handoff.settling} onDismiss={handoff.dismissNotice} />
                    {serverOverride ? (
                        <Banner tone="info" icon="Shield">
                            {`${t('license.server_override_title', 'Tier is managed server-wide')}. ${t('org.server_license_no_subscription', 'This installation is covered by a server-wide licence, so your organisation does not need a subscription. Usage and billing are managed by the platform operator.')}`}
                        </Banner>
                    ) : null}
                    {!serverOverride && !current ? (
                        <NoSubscriptionGroup plansOnSale={planList.length > 0} onChoosePlan={() => router.push('/org/billing/plans')} />
                    ) : null}
                    {!serverOverride && current ? (
                        <SubscriptionBody
                            sub={current}
                            plans={planList}
                            actions={{
                                busy: actions.busy,
                                portalOpening: handoff.opening === 'portal',
                                onChangePlan: () => router.push('/org/billing/plans'),
                                onPortal: () => void handoff.portal(),
                                onInvoices: () => router.push('/org/billing/invoices'),
                                onKeepPlan: () => void actions.keepPlan(),
                                onKeepSubscription: () => void actions.keepSubscription(),
                                onCancel: () => void actions.cancel(),
                                onAddUser: () => router.push('/org/invitations?new=1'),
                            }}
                        />
                    ) : null}
                    {!serverOverride && showUsageSharing(current) ? (
                        <UsageSharingGroup
                            pooled={org.data?.usagePooled ?? current?.billing?.usagePooled ?? true}
                            saving={actions.pooledSaving}
                            onChange={(pooled) => void actions.setPooled(pooled)}
                        />
                    ) : null}
                </>
            )}
        </OrgSettingsFrame>
    );
}
