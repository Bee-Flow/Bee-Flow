/**
 * The plan card (OrgLicenseSection.jsx "Plan Card"): the plan and its status,
 * when the cycle started and the cost cap (AI usage as a share of that cap is
 * the meter under "Usage this period"). Under it the card's own
 * actions: change plan, the Stripe portal, the invoices.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { absoluteDate } from '@/shared/lib/display';
import { Badge, Group, InfoRow, ListRow, SettingRow, type Tone } from '@/shared/ui';

import { subscriptionStatusLabel } from '../model/status';
import { canChangePlan, costCapSet, hasPaidBillingRelationship, money } from '../model/subscription';
import type { Subscription } from '../model/types';

function statusTone(status: string): Tone {
    if (status === 'active') return 'success';
    if (status === 'suspended') return 'error';
    return 'neutral';
}

export interface PlanSummaryActions {
    onChangePlan: () => void;
    onPortal: () => void;
    onInvoices: () => void;
    portalOpening: boolean;
}

export function PlanSummaryGroup({ sub, actions }: { sub: Subscription; actions: PlanSummaryActions }) {
    const t = useTranslation();
    return (
        <Group>
            <ListRow
                title={sub.planName || t('mobile.billing.custom_plan', 'Custom')}
                subtitle={t('org.billing_started', 'Billing cycle started {date}', {
                    date: sub.billingCycleStart ? absoluteDate(sub.billingCycleStart) : 'N/A',
                })}
                trailing={sub.status ? <Badge label={subscriptionStatusLabel(sub.status, t)} tone={statusTone(sub.status)} /> : undefined}
                wrapTitle
            />
            {costCapSet(sub.limits) ? (
                <InfoRow
                    label={t('org.cost_cap_month', 'cost cap / month')}
                    value={money(sub.limits.maxCostPerMonth as number, 'EUR')}
                />
            ) : null}
            {canChangePlan(sub) ? (
                <SettingRow testID="billing-change-plan" label={t('org.change_plan', 'Change plan')} onPress={actions.onChangePlan} />
            ) : null}
            {hasPaidBillingRelationship(sub) ? (
                <SettingRow
                    testID="billing-portal"
                    label={t('org.manage_billing', 'Manage Billing')}
                    value={actions.portalOpening ? '…' : undefined}
                    disabled={actions.portalOpening}
                    onPress={actions.onPortal}
                />
            ) : null}
            {sub.stripeCustomerId ? (
                <SettingRow testID="billing-invoices" label={t('billing.invoices', 'Invoices')} onPress={actions.onInvoices} />
            ) : null}
        </Group>
    );
}
