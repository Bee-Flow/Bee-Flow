/**
 * The Overview report: totals and the cost trend, the top five people and
 * models, and a row into every full breakdown (each its own virtualised
 * screen at /org/usage/<report>).
 */

import { useRouter } from 'expo-router';
import React from 'react';

import { useTranslation } from '@/core/i18n';
import { useUserRefresh } from '@/shared/patterns';
import { ErrorState, Group, GroupedScroll, ListSkeleton, NavRow, NoteRow, Text } from '@/shared/ui';

import { BreakdownItem } from './BreakdownItem';
import { UsageTotalsGroup } from './UsageTotalsGroup';
import { useBreakdown, useUsageOverview } from '../hooks/queries';
import type { RangePreset } from '../model/range';
import { BREAKDOWN_REPORTS, reportTitle, shareOf } from '../model/report';
import type { BreakdownReport } from '../model/types';

const PREVIEW = 5;

function Preview({ report, range }: { report: BreakdownReport; range: RangePreset }) {
    const t = useTranslation();
    const rows = useBreakdown(report, range, true);
    const data = rows.data ?? [];
    return (
        <Group title={reportTitle(report, t)}>
            {rows.isLoading ? <ListSkeleton rows={2} /> : null}
            {!rows.isLoading && data.length === 0 ? (
                <NoteRow>
                    <Text variant="caption" tone="tertiary">{t('usage.no_data_short', 'No data')}</Text>
                </NoteRow>
            ) : null}
            {data.slice(0, PREVIEW).map((row, i) => (
                <BreakdownItem key={row.key} report={report} row={row} rank={i} share={shareOf(row.cost, data)} />
            ))}
        </Group>
    );
}

export function OverviewPane({ range }: { range: RangePreset }) {
    const t = useTranslation();
    const router = useRouter();
    const overview = useUsageOverview(range, true);
    const refresh = useUserRefresh(() => overview.refetch());
    if (overview.isLoading) return <ListSkeleton rows={5} />;
    if (overview.isError || !overview.data) {
        return <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />;
    }
    const { totals, timeline, azureTotal } = overview.data;
    return (
        <GroupedScroll refresh={refresh}>
            <UsageTotalsGroup totals={totals} timeline={timeline} />
            <Preview report="users" range={range} />
            <Preview report="models" range={range} />
            <Group title={t('mobile.orgUsage.all_reports', 'All reports')}>
                {BREAKDOWN_REPORTS.filter((r) => r !== 'azure' || azureTotal > 0).map((report) => (
                    <NavRow
                        key={report}
                        label={reportTitle(report, t)}
                        onPress={() => router.push(`/org/usage/${report}?range=${range}`)}
                        testID={`report-${report}`}
                    />
                ))}
            </Group>
        </GroupedScroll>
    );
}
