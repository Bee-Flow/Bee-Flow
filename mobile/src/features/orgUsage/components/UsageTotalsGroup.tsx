/**
 * The window at a glance: cost, calls, tokens and active people, then the
 * cost per period. In the redacted customer view the server strips calls and
 * tokens, so those tiles are not shown rather than shown as zero.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { compactNumber, currency } from '@/features/usage';
import { BarChart, Divider, Group, Stat } from '@/shared/ui';

import { periodLabel } from '../model/report';
import type { TimelinePoint, UsageTotals } from '../model/types';

export function UsageTotalsGroup({ totals, timeline }: { totals: UsageTotals; timeline: TimelinePoint[] }) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const columns = timeline.map((p) => ({ label: periodLabel(p.period), value: p.cost }));
    const split =
        totals.inputCost !== null && totals.outputCost !== null
            ? t('mobile.orgUsage.cost_split', 'In {input} · out {output}', { input: currency(totals.inputCost), output: currency(totals.outputCost) })
            : undefined;
    return (
        <Group>
            <View style={styles.stats}>
                <Stat label={t('usage.total_cost', 'Total Cost')} value={currency(totals.cost)} caption={totals.azureCost > 0 ? t('mobile.orgUsage.includes_azure', 'Includes Azure services') : split} tone="accent" />
                <Stat label={t('usage.active_users', 'Active Users')} value={String(totals.activeUsers)} />
            </View>
            {totals.calls !== null ? (
                <View style={styles.stats}>
                    <Stat label={t('usage.ai_calls', 'AI Calls')} value={compactNumber(totals.calls)} />
                    <Stat label={t('mobile.orgUsage.tokens', 'Tokens')} value={totals.tokens === null ? '—' : compactNumber(totals.tokens)} />
                </View>
            ) : null}
            <Divider inset={theme.spacing.lg} />
            <View style={styles.chart}>
                <BarChart
                    columns={columns}
                    tint={theme.chart[0]}
                    summary={t('mobile.orgUsage.chart_summary', 'Cost per period, {total} in total', { total: currency(totals.cost) })}
                />
            </View>
        </Group>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        stats: { flexDirection: 'row', gap: theme.spacing.md, paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.sm },
        chart: { padding: theme.spacing.lg },
    });
