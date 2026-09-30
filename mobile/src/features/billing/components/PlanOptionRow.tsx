/**
 * One plan in a picker (OrgLicenseSection.jsx plan cards): its name with the
 * trial or direction chip, the description, the caps it sets, the price per
 * interval (and per seat), and the one action — Subscribe, Upgrade or
 * Downgrade. A plan without a Stripe price cannot be bought here, so its
 * action is off, as on the web.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { Badge, Button, Card, Text } from '@/shared/ui';

import { money, planCaps } from '../model/subscription';
import type { Plan } from '../model/types';

const styles = StyleSheet.create({
    card: { gap: 8 },
    head: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
    foot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
    price: { flexShrink: 1 },
});

function capsLine(plan: Plan, t: TranslateFn): string {
    const caps = planCaps(plan);
    return [
        caps.users ? t('mobile.billing.cap_users', '{n} users', { n: caps.users }) : null,
        caps.agents ? t('mobile.billing.cap_agents', '{n} agents', { n: caps.agents }) : null,
        caps.knowledge ? t('mobile.billing.cap_knowledge', '{n} KB sources', { n: caps.knowledge }) : null,
    ]
        .filter(Boolean)
        .join(' · ');
}

function chip(plan: Plan, t: TranslateFn) {
    if (plan.direction === 'downgrade') return <Badge label={t('org.downgrade', 'Downgrade')} />;
    if (plan.direction === 'upgrade') return <Badge label={t('org.upgrade', 'Upgrade')} tone="info" />;
    if (plan.trialDays > 0) {
        return <Badge label={t('mobile.billing.trial', '{n}d free trial', { n: plan.trialDays })} tone="success" />;
    }
    return null;
}

function actionLabel(plan: Plan, t: TranslateFn): string {
    if (plan.direction === 'downgrade') return t('org.downgrade', 'Downgrade');
    if (plan.direction === 'upgrade') return t('org.upgrade_button', 'Upgrade');
    return t('org.subscribe', 'Subscribe');
}

export function PlanOptionRow({
    plan,
    busy,
    disabled,
    onPick,
}: {
    plan: Plan;
    busy: boolean;
    disabled: boolean;
    onPick: (plan: Plan) => void;
}) {
    const t = useTranslation();
    const caps = capsLine(plan, t);
    const perSeat = plan.perSeat ? ` ${t('org.per_seat', '/ seat')}` : '';
    return (
        <Card style={styles.card} testID={`plan-${plan.id}`}>
            <View style={styles.head}>
                <Text variant="subheading">{plan.name}</Text>
                {chip(plan, t)}
            </View>
            {plan.description ? (
                <Text variant="caption" tone="secondary">
                    {plan.description}
                </Text>
            ) : null}
            {caps ? (
                <Text variant="caption" tone="tertiary">
                    {caps}
                </Text>
            ) : null}
            <View style={styles.foot}>
                <Text variant="subheading" style={styles.price}>
                    {`${money(plan.price, plan.currency)} / ${plan.billingInterval}${perSeat}`}
                </Text>
                <Button
                    testID={`plan-${plan.id}-pick`}
                    label={actionLabel(plan, t)}
                    variant={plan.direction === 'downgrade' ? 'secondary' : 'primary'}
                    size="sm"
                    iconName="ArrowRight"
                    loading={busy}
                    disabled={disabled || !plan.hasStripePrice}
                    onPress={() => onPick(plan)}
                />
            </View>
        </Card>
    );
}
