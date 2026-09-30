/**
 * Plans — the plan pickers of OrgLicenseSection.jsx on a screen of their own.
 *
 * - With a Stripe subscription: the server's `changeable_plans`, both ways,
 *   each confirmed against the server's cost preview (no new Checkout: the
 *   subscription is updated in place).
 * - Without one (no plan, or a free or manual one): the plans on sale, each
 *   opening Stripe Checkout in the in-app browser, under the web's recurring
 *   billing notice. The subscription settles when the app is back in front.
 * - On the highest plan, or mid-cancellation or downgrade: why there is
 *   nothing to pick.
 */

import { useRouter } from 'expo-router';
import React from 'react';

import { useTranslation } from '@/core/i18n';
import { OrgSettingsFrame } from '@/features/org';
import { Banner, Group, NoteRow } from '@/shared/ui';

import { ChangePreviewSheet } from '../components/ChangePreviewSheet';
import { HandoffBanners } from '../components/HandoffBanners';
import { PlanOptionRow } from '../components/PlanOptionRow';
import { useStripePlans, useSubscriptionFrame } from '../hooks/queries';
import { useBillingAccess } from '../hooks/useBillingAccess';
import { usePlanChange } from '../hooks/usePlanChange';
import { useStripeHandoff } from '../hooks/useStripeHandoff';
import { canChangePlan, canSubscribe } from '../model/subscription';

export function PlansScreen() {
    const t = useTranslation();
    const router = useRouter();
    const { orgId, allowed, denied, serverOverride } = useBillingAccess();
    const live = allowed && !serverOverride;
    const query = useSubscriptionFrame(allowed ? orgId : null, serverOverride);
    const plans = useStripePlans(live);
    const handoff = useStripeHandoff(orgId);
    const change = usePlanChange(orgId, () => router.back());

    return (
        <OrgSettingsFrame
            title={t('mobile.billing.plans', 'Plans')}
            subtitle={t('org.license_usage', 'License & Usage')}
            allowed={allowed}
            denied={denied}
            query={query}
            onRefresh={() => plans.refetch()}
        >
            {({ sub }) => {
                const onSale = plans.data ?? [];
                const changing = sub !== null && canChangePlan(sub);
                const subscribing = canSubscribe(sub, onSale);
                return (
                    <>
                        <HandoffBanners notice={handoff.notice} settling={handoff.settling} onDismiss={handoff.dismissNotice} />
                        {changing ? (
                            <Group title={t('org.change_plan', 'Change plan')}>
                                <NoteRow>
                                    {t(
                                        'org.change_plan_hint',
                                        'Switching plans takes effect immediately. Stripe will prorate the difference on your next invoice.',
                                    )}
                                </NoteRow>
                            </Group>
                        ) : null}
                        {changing
                            ? (sub?.changeablePlans ?? []).map((plan) => (
                                  <PlanOptionRow
                                      key={plan.id}
                                      plan={plan}
                                      busy={change.previewing === plan.id}
                                      disabled={change.previewing !== null}
                                      onPick={(picked) => void change.pick(picked)}
                                  />
                              ))
                            : null}
                        {subscribing ? (
                            <Banner tone="warning" icon="CreditCard">
                                {`${t('billing.recurring_notice', 'This is a recurring subscription. Your selected payment method is charged automatically at the start of each billing period (automatische incasso) until you cancel.')} ${t('billing.recurring_badge', 'Recurring · automatische incasso')}`}
                            </Banner>
                        ) : null}
                        {subscribing
                            ? onSale.map((plan) => (
                                  <PlanOptionRow
                                      key={plan.id}
                                      plan={plan}
                                      busy={handoff.opening === plan.id}
                                      disabled={handoff.opening !== null || handoff.settling}
                                      onPick={(picked) => void handoff.checkout(picked.id)}
                                  />
                              ))
                            : null}
                        {serverOverride ? (
                            <Banner tone="info" icon="Shield">
                                {t('org.server_license_no_subscription', 'This installation is covered by a server-wide licence, so your organisation does not need a subscription. Usage and billing are managed by the platform operator.')}
                            </Banner>
                        ) : null}
                        {!serverOverride && !changing && !subscribing ? (
                            <Group>
                                <NoteRow>
                                    {`${t('mobile.billing.nothing_to_pick', 'There is no other plan to choose here.')} ${t('org.contact_for_plan', 'Reach out to')} info@beeflow.nl.`}
                                </NoteRow>
                            </Group>
                        ) : null}
                        <ChangePreviewSheet
                            target={change.target}
                            preview={change.quote}
                            busy={change.confirming}
                            onConfirm={() => void change.confirm()}
                            onClose={change.close}
                        />
                    </>
                );
            }}
        </OrgSettingsFrame>
    );
}
