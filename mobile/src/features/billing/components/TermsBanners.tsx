/**
 * The two "something is scheduled" banners of OrgLicenseSection.jsx: a
 * downgrade that lands at the period end (undo: keep the current plan), and a
 * cancellation that does (undo: keep the subscription). Both keep access until
 * the date they name.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { absoluteDate } from '@/shared/lib/display';
import { Banner, Button, Text } from '@/shared/ui';

import type { Subscription } from '../model/types';

const styles = StyleSheet.create({ body: { gap: 6 } });

export function TermsBanners({
    sub,
    busy,
    onKeepPlan,
    onKeepSubscription,
}: {
    sub: Subscription;
    busy: boolean;
    onKeepPlan: () => void;
    onKeepSubscription: () => void;
}) {
    const t = useTranslation();
    const periodEnd = t('org.period_end', 'the end of this period');
    return (
        <>
            {sub.pendingPlanId ? (
                <Banner tone="info" icon="Clock">
                    <View style={styles.body}>
                        <Text variant="subheading">
                            {`${t('org.downgrade_scheduled', 'Downgrade to')} ${sub.pendingPlanName || t('org.a_lower_plan', 'a lower plan')} ${t('org.downgrade_scheduled_on', 'on')} ${sub.pendingPlanEffective ? absoluteDate(sub.pendingPlanEffective) : periodEnd}.`}
                        </Text>
                        <Text variant="caption" tone="secondary">
                            {t('org.downgrade_keeps_access', 'You keep your current plan until then.')}
                        </Text>
                        <Button
                            testID="billing-keep-plan"
                            label={t('org.keep_current_plan', 'Keep current plan')}
                            variant="secondary"
                            size="sm"
                            loading={busy}
                            onPress={onKeepPlan}
                        />
                    </View>
                </Banner>
            ) : null}
            {sub.cancelAtPeriodEnd ? (
                <Banner tone="info" icon="TriangleAlert">
                    <View style={styles.body}>
                        <Text variant="subheading">
                            {`${t('org.cancel_scheduled', 'Subscription cancels on')} ${sub.cancelAt ? absoluteDate(sub.cancelAt) : periodEnd}.`}
                        </Text>
                        <Text variant="caption" tone="secondary">
                            {t('org.cancel_keeps_access', 'You keep access until that date.')}
                        </Text>
                        <Button
                            testID="billing-keep-subscription"
                            label={t('org.keep_subscription', 'Keep subscription')}
                            variant="secondary"
                            size="sm"
                            loading={busy}
                            onPress={onKeepSubscription}
                        />
                    </View>
                </Banner>
            ) : null}
        </>
    );
}
