/**
 * Everything the usage screen reads for one window and scope, and what it
 * derives: the chart's columns, the total cost and whether the plan is
 * flat-rate.
 */

import { useMemo } from 'react';

import { useUserRefresh } from '@/shared/patterns';

import {
    useConsumerUsage,
    useCostTimeline,
    useLicenseStatus,
    useUsageByModel,
    useUsageSummary,
} from './queries';
import { num, shortDay } from '../model/format';

export function useUsageOverview(days: number, userId: string | null) {
    const summary = useUsageSummary(days, userId);
    const timeline = useCostTimeline(days, userId);
    const models = useUsageByModel(days, userId);
    const license = useLicenseStatus();
    const plan = useConsumerUsage();

    const columns = useMemo(
        () =>
            (timeline.data ?? []).map((point) => ({
                label: shortDay(point.period),
                value: num(point.total_cost),
            })),
        [timeline.data],
    );
    const totals = summary.data;
    const totalCost = num(totals?.combined_total_cost ?? totals?.total_estimated_cost ?? 0);

    const refresh = useUserRefresh(() => Promise.all([summary.refetch(), timeline.refetch(), models.refetch()]));

    return {
        summary,
        timeline,
        models,
        license,
        plan,
        columns,
        totalCost,
        // A flat-rate plan bills per seat, not per token. Showing a euro figure
        // there invites "why am I being charged this?" about a number nobody
        // is charged.
        flatRate: plan.data?.billing_model === 'fixed',
        refresh,
    };
}
