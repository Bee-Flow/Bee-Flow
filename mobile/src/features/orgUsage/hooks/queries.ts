/** The usage reports' reads. Screens call these, never useQuery directly. */

import { useQuery } from '@tanstack/react-query';

import { getBreakdown, getFeedback, getTerminations, getUsageOverview } from '../api/endpoints';
import { orgUsageKeys } from '../api/keys';
import type { RangePreset } from '../model/range';
import type { BreakdownReport } from '../model/types';

export function useUsageOverview(range: RangePreset, enabled: boolean) {
    return useQuery({
        queryKey: orgUsageKeys.overview(range),
        queryFn: ({ signal }) => getUsageOverview(range, signal),
        enabled,
    });
}

export function useBreakdown(report: BreakdownReport, range: RangePreset, enabled: boolean) {
    return useQuery({
        queryKey: orgUsageKeys.breakdown(report, range),
        queryFn: ({ signal }) => getBreakdown(report, range, signal),
        enabled,
    });
}

/** Only while the tab is open and the licence allows it (the route 403s otherwise). */
export function useOrgFeedback(range: RangePreset, enabled: boolean) {
    return useQuery({
        queryKey: orgUsageKeys.feedback(range),
        queryFn: ({ signal }) => getFeedback(range, signal),
        enabled,
    });
}

export function useOrgTerminations(range: RangePreset, enabled: boolean) {
    return useQuery({
        queryKey: orgUsageKeys.terminations(range),
        queryFn: ({ signal }) => getTerminations(range, signal),
        enabled,
    });
}
