/** The usage and plan queries. Screens call these, never useQuery directly. */

import { useQuery } from '@tanstack/react-query';

import {
    getConsumerUsage,
    getCostTimeline,
    getLicenseStatus,
    getUsageByModel,
    getUsageSummary,
} from '../api/endpoints';
import { usageKeys } from '../api/keys';

/**
 * The licence tier. Cheap and cached; `retry: false` because a refusal is an
 * answer, and a screen showing the tier must not fail because of it.
 */
export function useLicenseStatus() {
    return useQuery({
        queryKey: usageKeys.license,
        queryFn: ({ signal }) => getLicenseStatus(signal),
        staleTime: 5 * 60_000,
        retry: false,
    });
}

/** Only a consumer account has a plan with hard caps; org plans are billed
 *  through the subscription and this endpoint 403s for them. */
export function useConsumerUsage() {
    return useQuery({
        queryKey: usageKeys.consumerUsage,
        queryFn: ({ signal }) => getConsumerUsage(signal),
        staleTime: 5 * 60_000,
        retry: false,
    });
}

export function useUsageSummary(days: number, userId: string | null) {
    return useQuery({
        queryKey: usageKeys.summary(days, userId),
        queryFn: ({ signal }) => getUsageSummary({ days, userId }, signal),
    });
}

export function useCostTimeline(days: number, userId: string | null) {
    return useQuery({
        queryKey: usageKeys.costTimeline(days, userId),
        queryFn: ({ signal }) => getCostTimeline({ days, userId }, signal),
    });
}

export function useUsageByModel(days: number, userId: string | null) {
    return useQuery({
        queryKey: usageKeys.byModel(days, userId),
        queryFn: ({ signal }) => getUsageByModel({ days, userId }, signal),
    });
}
