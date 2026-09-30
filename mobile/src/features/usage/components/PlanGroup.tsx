/**
 * A consumer plan's caps, as meters. A null cap means "no limit" and is shown
 * as such — never as an empty or a full bar.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { humanise } from '@/shared/lib/display';
import { Group, InfoRow, Meter } from '@/shared/ui';

import { compactNumber, currency, fractionOfLimit, num } from '../model/format';
import type { ConsumerUsage, UsageSummary } from '../model/types';

export function PlanGroup({
    plan,
    summary,
}: {
    plan: ConsumerUsage;
    summary: UsageSummary | null | undefined;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const capOf = (limit: number | null, format: (value: number) => string) =>
        limit ? t('mobile.usage.cap_of', 'of {cap}', { cap: format(limit) }) : t('mobile.usage.no_limit', 'no limit');
    const { limits, usage, subscription } = plan;
    return (
        <Group
            title={t('billing.your_plan', 'Your plan')}
            footer={t('mobile.usage.plan_footer', 'When a limit is reached Bee Flow refuses new work with a clear message rather than silently degrading.')}
        >
            <View style={styles.meters}>
                <Meter
                    label={t('mobile.usage.spend_period', 'Spend this period')}
                    valueLabel={currency(usage.total_billed_cost)}
                    fraction={fractionOfLimit(usage.total_billed_cost, limits.max_cost_per_month)}
                    capLabel={capOf(limits.max_cost_per_month, currency)}
                />
                <Meter
                    label={t('mobile.usage.messages_period', 'Messages this period')}
                    valueLabel={compactNumber(summary?.total_calls)}
                    fraction={fractionOfLimit(num(summary?.total_calls), limits.max_messages_per_month)}
                    capLabel={capOf(limits.max_messages_per_month, compactNumber)}
                />
                <Meter
                    label={t('mobile.usage.tokens_period', 'Tokens this period')}
                    valueLabel={compactNumber(summary?.total_tokens)}
                    fraction={fractionOfLimit(num(summary?.total_tokens), limits.max_tokens_per_month)}
                    capLabel={capOf(limits.max_tokens_per_month, compactNumber)}
                />
            </View>
            <InfoRow label={t('license.plan', 'Plan')} value={limits.plan_name} />
            {subscription ? (
                <InfoRow
                    label={t('org.subscription', 'Subscription')}
                    value={humanise(subscription.status)}
                    tone={subscription.status === 'active' ? 'success' : 'warning'}
                />
            ) : null}
        </Group>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        meters: { padding: theme.spacing.lg, gap: theme.spacing.lg },
    });
