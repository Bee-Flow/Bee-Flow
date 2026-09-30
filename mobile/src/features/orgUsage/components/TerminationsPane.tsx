/**
 * Tasks that ended early (OrgTerminationsPanel.jsx): the totals by kind, how
 * many per period, the agents that stop most, and the latest 200 stops in a
 * virtualised list. Only sanitised metadata; messages are never logged.
 */

import React from 'react';
import { FlatList, StyleSheet, View, type ListRenderItem } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { shortModel } from '@/features/usage';
import { absoluteDate } from '@/shared/lib/display';
import { useUserRefresh } from '@/shared/patterns';
import { BarChart, EmptyState, ErrorState, Group, InfoRow, ListRow, ListSkeleton, Stat } from '@/shared/ui';

import { useOrgTerminations } from '../hooks/queries';
import type { RangePreset } from '../model/range';
import { periodLabel, terminationTypeLabel, terminationsPerPeriod } from '../model/report';
import type { Termination } from '../model/types';

function TerminationRow({ row }: { row: Termination }) {
    const t = useTranslation();
    const what = [row.agentName, row.model ? shortModel(row.model) : null, row.errorCode].filter(Boolean).join(' · ');
    return (
        <ListRow
            title={terminationTypeLabel(row.type, t)}
            subtitle={row.errorLine ? `${what} — ${row.errorLine}` : what || undefined}
            meta={absoluteDate(row.timestamp)}
        />
    );
}

const renderItem: ListRenderItem<Termination> = ({ item }) => <TerminationRow row={item} />;
const keyOf = (item: Termination) => String(item.id);

export function TerminationsPane({ range }: { range: RangePreset }) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const report = useOrgTerminations(range, true);
    const refresh = useUserRefresh(() => report.refetch());
    if (report.isLoading) return <ListSkeleton rows={5} />;
    if (report.isError || !report.data) return <ErrorState error={report.error} onRetry={() => void report.refetch()} />;
    const { summary, timeline, rows, byAgent } = report.data;
    const columns = terminationsPerPeriod(timeline).map((p) => ({
        label: periodLabel(p.period),
        value: p.count,
    }));
    const header = (
        <View style={styles.header}>
            <Group>
                <View style={styles.stats}>
                    <Stat label={t('org.terminations_kpi_total', 'Total')} value={String(summary.total)} />
                    <Stat label={t('org.terminations_kpi_errors', 'Errors')} value={String(summary.byType.error)} tone={summary.byType.error > 0 ? 'warning' : 'primary'} />
                </View>
                <InfoRow label={t('org.terminations_kpi_max_tokens', 'Max tokens')} value={String(summary.byType.max_tokens)} />
                <InfoRow label={t('org.terminations_kpi_max_iterations', 'Max iterations')} value={String(summary.byType.max_iterations)} />
                <InfoRow label={t('org.terminations_kpi_aborted', 'Aborted')} value={String(summary.byType.aborted)} />
            </Group>
            <Group title={t('org.terminations_over_time', 'Terminations over time')}>
                <View style={styles.chart}>
                    <BarChart columns={columns} tint={theme.chart[1]} />
                </View>
            </Group>
            {byAgent.length > 0 ? (
                <Group title={t('org.terminations_by_agent', 'By agent')}>
                    {byAgent.slice(0, 10).map((a) => (
                        <InfoRow key={a.agentId ?? a.agentName ?? '—'} label={a.agentName ?? a.agentId ?? '—'} value={String(a.total)} />
                    ))}
                </Group>
            ) : null}
        </View>
    );
    return (
        <FlatList
            data={rows}
            keyExtractor={keyOf}
            renderItem={renderItem}
            ListHeaderComponent={header}
            ListEmptyComponent={<EmptyState icon="CircleCheck" title={t('org.terminations_empty', 'No terminations match the filters')} />}
            refreshing={refresh.refreshing}
            onRefresh={refresh.onRefresh}
        />
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        header: { gap: theme.spacing.md, paddingVertical: theme.spacing.lg },
        stats: { flexDirection: 'row', gap: theme.spacing.md, paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.sm },
        chart: { padding: theme.spacing.lg },
    });
