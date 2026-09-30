/**
 * The subscription billing card (OrgLicenseSection.jsx "Subscription billing
 * card"): what each cycle costs, the seats on a per-seat plan with the way to
 * add one (inviting a member adds a billed seat), and the muted cancel.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { Group, InfoRow, NoteRow, SettingRow } from '@/shared/ui';

import { canCancel, money } from '../model/subscription';
import type { Subscription, SubscriptionBilling } from '../model/types';

function perSeatLine(billing: SubscriptionBilling, perSeat: string): string {
    return `${billing.seatQuantity ?? 0} × ${money(billing.planPrice ?? 0, billing.planCurrency)} ${perSeat}`;
}

export function BillingCycleGroup({
    sub,
    billing,
    busy,
    onAddUser,
    onCancel,
}: {
    sub: Subscription;
    billing: SubscriptionBilling;
    busy: boolean;
    onAddUser: () => void;
    onCancel: () => void;
}) {
    const t = useTranslation();
    const interval = billing.billingInterval === 'yearly' ? t('org.year', 'year') : t('org.month', 'month');
    const seats = billing.seatQuantity ?? 0;
    return (
        <Group title={t('org.subscription', 'Subscription')}>
            <InfoRow
                label={t('org.billed_per_cycle', 'Billed per cycle')}
                value={`${money(billing.subscriptionTotal, billing.planCurrency)} / ${interval}`}
                tone="primary"
            />
            {billing.perSeat ? (
                <InfoRow
                    label={perSeatLine(billing, t('org.per_seat', '/ seat'))}
                    value={`${seats} ${seats === 1 ? t('org.seat', 'seat') : t('org.seats', 'seats')}`}
                />
            ) : null}
            {billing.perSeat ? (
                <SettingRow testID="billing-add-user" label={t('org.add_user', 'Add user')} onPress={onAddUser} />
            ) : null}
            {billing.perSeat ? (
                <NoteRow>
                    {`${t('org.add_user_hint', 'Inviting a user adds a seat to your plan. Extra seats are billed per user per month and prorated for the current period.')} ${t('org.seats_proration_note', 'Stripe prorates the difference on your next invoice.')}`}
                </NoteRow>
            ) : null}
            {canCancel(sub) ? (
                <SettingRow
                    testID="billing-cancel"
                    label={t('org.cancel_subscription', 'Cancel subscription')}
                    disabled={busy}
                    destructive
                    onPress={onCancel}
                />
            ) : null}
        </Group>
    );
}
