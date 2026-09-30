/**
 * The period at a glance: messages, what it cost, and the daily cost chart.
 *
 * The chart is drawn by hand in react-native-svg (shared/ui/BarChart.tsx) —
 * no charting library is installed, and thirty rectangles do not justify one.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { BarChart, Divider, Group, ListSkeleton, Stat, type Column } from '@/shared/ui';

import { compactNumber, currency, num } from '../model/format';
import type { UsageSummary } from '../model/types';

export function UsageTotalsGroup({
    days,
    summary,
    totalCost,
    flatRate,
    planName,
    columns,
    chartLoading,
}: {
    days: number;
    summary: UsageSummary | null | undefined;
    totalCost: number;
    /** A flat-rate plan bills per seat, so no euro figure is shown for it. */
    flatRate: boolean;
    planName: string | undefined;
    columns: Column[];
    chartLoading: boolean;
}) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    return (
        <Group title={t('mobile.usage.last_days', 'Last {n} days', { n: days })}>
            <View style={styles.stats}>
                <Stat
                    label={t('org.messages', 'Messages')}
                    value={compactNumber(summary?.total_calls)}
                    caption={t('mobile.usage.tokens_count', '{n} tokens', { n: compactNumber(summary?.total_tokens) })}
                />
                {flatRate ? (
                    <Stat
                        label={t('license.plan', 'Plan')}
                        value={planName ?? t('mobile.usage.flat_rate', 'Flat rate')}
                        caption={t('mobile.usage.per_seat', 'Billed per seat, not per token')}
                    />
                ) : (
                    <Stat
                        label={t('org.cost', 'Cost')}
                        value={currency(totalCost)}
                        caption={
                            num(summary?.azure_services_total_cost) > 0
                                ? t('mobile.usage.includes_azure', 'Includes Azure services')
                                : t('mobile.usage.estimated', 'Estimated')
                        }
                        tone="accent"
                    />
                )}
            </View>

            <Divider inset={theme.spacing.lg} />

            <View style={styles.chart}>
                {chartLoading ? (
                    <ListSkeleton rows={2} />
                ) : (
                    <BarChart
                        columns={columns}
                        summary={t('mobile.usage.chart_summary', 'Daily cost over the last {n} days, totalling {total}', { n: days, total: currency(totalCost) })}
                    />
                )}
            </View>
        </Group>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        stats: { flexDirection: 'row', paddingHorizontal: theme.spacing.lg, gap: theme.spacing.md },
        chart: { padding: theme.spacing.lg },
    });
