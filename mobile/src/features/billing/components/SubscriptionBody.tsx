/**
 * License & Usage with a subscription (OrgLicenseSection.jsx, `sub` branch),
 * in the web's order: the plan card, the scheduled-change banners, the
 * highest-plan note, the way to a paid plan from a free one, the billing card,
 * usage and limits.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { Group, NoteRow, SettingRow } from '@/shared/ui';

import { BillingCycleGroup } from './BillingCycleGroup';
import { PlanSummaryGroup, type PlanSummaryActions } from './PlanSummaryGroup';
import { TermsBanners } from './TermsBanners';
import { UsageLimitsGroup } from './UsageLimitsGroup';
import { canChangePlan, canSubscribe, onHighestPlan } from '../model/subscription';
import type { Plan, Subscription } from '../model/types';

export interface SubscriptionBodyActions extends PlanSummaryActions {
    busy: boolean;
    onKeepPlan: () => void;
    onKeepSubscription: () => void;
    onCancel: () => void;
    onAddUser: () => void;
}

export function SubscriptionBody({
    sub,
    plans,
    actions,
}: {
    sub: Subscription;
    plans: readonly Plan[];
    actions: SubscriptionBodyActions;
}) {
    const t = useTranslation();
    const billing = sub.billing && sub.billing.subscriptionTotal > 0 ? sub.billing : null;
    const upgradePath = canChangePlan(sub) || canSubscribe(sub, plans) ? actions.onChangePlan : null;
    return (
        <>
            <PlanSummaryGroup sub={sub} actions={actions} />
            <TermsBanners
                sub={sub}
                busy={actions.busy}
                onKeepPlan={actions.onKeepPlan}
                onKeepSubscription={actions.onKeepSubscription}
            />
            {onHighestPlan(sub) ? (
                <Group>
                    <NoteRow>
                        {`${t('org.on_highest_plan', "You're on the highest plan — contact")} info@beeflow.nl ${t('org.for_custom_pricing', 'for custom pricing.')}`}
                    </NoteRow>
                </Group>
            ) : null}
            {canSubscribe(sub, plans) ? (
                <Group
                    footer={t(
                        'org.upgrade_to_paid_hint',
                        "You're on a free plan. Subscribe to unlock higher usage and more features — you'll be taken to secure Stripe checkout.",
                    )}
                >
                    <SettingRow
                        testID="billing-upgrade-to-paid"
                        label={t('org.upgrade_to_paid', 'Upgrade to a paid plan')}
                        onPress={actions.onChangePlan}
                    />
                </Group>
            ) : null}
            {billing ? (
                <BillingCycleGroup
                    sub={sub}
                    billing={billing}
                    busy={actions.busy}
                    onAddUser={actions.onAddUser}
                    onCancel={actions.onCancel}
                />
            ) : null}
            <UsageLimitsGroup sub={sub} onUpgrade={upgradePath} />
        </>
    );
}
