/**
 * The usage, licence and plan endpoints. Several answer 403 or 402 by design
 * (org plans have no consumer caps; monitoring can be licence-gated), so the
 * gated ones go through `optional` and a refusal reads as null.
 */

import { api } from '@/core/api/client';
import { optional } from '@/core/api/optional';

import {
    readConsumerUsage,
    readCostTimeline,
    readLicenseStatus,
    readModelUsage,
    readUsageSummary,
} from './readers';
import type {
    ConsumerUsage,
    CostPoint,
    LicenseStatus,
    ModelUsage,
    UsageScope,
    UsageSummary,
} from '../model/types';

export async function getLicenseStatus(signal?: AbortSignal): Promise<LicenseStatus | null> {
    return readLicenseStatus(await api.get<unknown>('/api/license/status', { signal }));
}

export async function getConsumerUsage(signal?: AbortSignal): Promise<ConsumerUsage | null> {
    return optional(async () =>
        readConsumerUsage(await api.get<unknown>('/api/subscriptions/consumer/usage', { signal })),
    );
}

/** `?user=<id>` narrows to one person; see UsageScope for why that matters. */
function usageQuery({ days, userId }: UsageScope): Record<string, string | number> {
    return userId ? { days, user: userId } : { days };
}

export async function getUsageSummary(
    scope: UsageScope,
    signal?: AbortSignal,
): Promise<UsageSummary | null> {
    return readUsageSummary(
        await api.get<unknown>('/api/usage/summary', { signal, query: usageQuery(scope) }),
    );
}

export async function getCostTimeline(scope: UsageScope, signal?: AbortSignal): Promise<CostPoint[]> {
    return readCostTimeline(
        await api.get<unknown>('/api/usage/cost-timeline', {
            signal,
            query: { ...usageQuery(scope), interval: 'day' },
        }),
    );
}

export async function getUsageByModel(scope: UsageScope, signal?: AbortSignal): Promise<ModelUsage[]> {
    return readModelUsage(
        await api.get<unknown>('/api/usage/by-model', { signal, query: usageQuery(scope) }),
    );
}
