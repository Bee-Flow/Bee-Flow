/**
 * One full breakdown of the organisation's usage (/org/usage/<report>?range=),
 * every row in a virtualised list with its share of the largest. The range
 * comes from the dashboard and can be changed here too.
 */

import React, { useState } from 'react';
import { FlatList, type ListRenderItem } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useOrgContext } from '@/features/org';
import { useUserRefresh } from '@/shared/patterns';
import { EmptyState, ErrorState, ListSkeleton, Screen, ScreenHeader } from '@/shared/ui';

import { AdminOnly } from '../components/AdminOnly';
import { BreakdownItem, type BreakdownItemProps } from '../components/BreakdownItem';
import { RangePills } from '../components/RangePills';
import { useBreakdown } from '../hooks/queries';
import { isRangePreset, type RangePreset } from '../model/range';
import { isBreakdownReport, reportTitle, shareOf } from '../model/report';
import type { BreakdownReport } from '../model/types';

const renderItem: ListRenderItem<BreakdownItemProps> = ({ item }) => <BreakdownItem {...item} />;
const keyOf = (item: BreakdownItemProps) => item.row.key;

function Report({ report, initialRange }: { report: BreakdownReport; initialRange: RangePreset }) {
    const t = useTranslation();
    const [range, setRange] = useState<RangePreset>(initialRange);
    const rows = useBreakdown(report, range, true);
    const refresh = useUserRefresh(() => rows.refetch());
    const data = rows.data ?? [];
    const items: BreakdownItemProps[] = data.map((row, rank) => ({ report, row, rank, share: shareOf(row.cost, data) }));
    return (
        <Screen edges={['top']} inset>
            <ScreenHeader title={reportTitle(report, t)} subtitle={t('usage.title', 'Usage & Monitoring')} />
            <RangePills value={range} onChange={setRange} />
            {rows.isLoading ? <ListSkeleton rows={6} /> : null}
            {rows.isError ? <ErrorState error={rows.error} onRetry={() => void rows.refetch()} /> : null}
            {rows.data ? (
                <FlatList
                    data={items}
                    keyExtractor={keyOf}
                    renderItem={renderItem}
                    ListEmptyComponent={<EmptyState icon="BarChart3" title={t('usage.no_data', 'No usage data for this period')} />}
                    refreshing={refresh.refreshing}
                    onRefresh={refresh.onRefresh}
                    testID="report-list"
                />
            ) : null}
        </Screen>
    );
}

export function OrgUsageReportScreen({ report, range }: { report: string | undefined; range: string | undefined }) {
    const t = useTranslation();
    const { orgId, isOrgAdmin } = useOrgContext();
    if (!orgId || !isOrgAdmin) return <AdminOnly />;
    if (!isBreakdownReport(report)) {
        return (
            <Screen edges={['top']} inset>
                <ScreenHeader title={t('usage.title', 'Usage & Monitoring')} />
                <EmptyState icon="BarChart3" title={t('mobile.orgUsage.unknown_report', 'There is no such report')} />
            </Screen>
        );
    }
    return <Report report={report} initialRange={isRangePreset(range) ? range : '30d'} />;
}
