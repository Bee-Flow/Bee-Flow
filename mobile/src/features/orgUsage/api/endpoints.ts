/**
 * The organisation's usage reports. Verified against:
 *   - server/routes/usage.js — GET /api/usage/{summary,timeline,users,sources,
 *     agents,models,models-by-agent,models-by-user} and
 *     /azure-services/{summary,by-type,by-user}; UsageQuery (days, startDate +
 *     endDate together, interval); scoped to the session's organisation;
 *     redacted for cloud customers (maybeRedact);
 *   - server/routes/feedback.js — GET /api/feedback/org and /org/summary:
 *     requireOwnOrgAdmin + requireAdvancedMonitoring, a STRICT query of
 *     startDate/endDate (+ limit); nothing means all time;
 *   - server/routes/terminations.js — GET /api/terminations/org,
 *     /org/summary, /org/timeline, /org/by-agent: org admin, strict
 *     TerminationsQuery (days|startDate|endDate|interval|limit), `{ rows }`.
 */

import { api } from '@/core/api/client';

import {
    readAzureTotal,
    readBreakdown,
    readFeedback,
    readFeedbackSummary,
    readTerminationSummary,
    readTerminationTimeline,
    readTerminations,
    readTerminationsByAgent,
    readTimeline,
    readUsageTotals,
} from './readers';
import { deriveRangeParams, usageQuery, windowQuery, type RangePreset } from '../model/range';
import type {
    BreakdownReport,
    BreakdownRow,
    FeedbackItem,
    FeedbackSummary,
    Termination,
    TerminationPoint,
    TerminationSummary,
    TerminationsByAgent,
    TimelinePoint,
    UsageTotals,
} from '../model/types';

/** The report → its path under /api/usage. */
export const BREAKDOWN_PATHS: Readonly<Record<BreakdownReport, string>> = {
    users: '/api/usage/users',
    models: '/api/usage/models',
    sources: '/api/usage/sources',
    agents: '/api/usage/agents',
    'models-by-agent': '/api/usage/models-by-agent',
    'models-by-user': '/api/usage/models-by-user',
    azure: '/api/usage/azure-services/by-type',
};

export async function getUsageOverview(
    preset: RangePreset,
    signal?: AbortSignal,
): Promise<{ totals: UsageTotals; timeline: TimelinePoint[]; azureTotal: number }> {
    const range = deriveRangeParams(preset);
    const query = usageQuery(range);
    const [summary, timeline, azure] = await Promise.all([
        api.get<unknown>('/api/usage/summary', { signal, query }),
        api.get<unknown>('/api/usage/timeline', { signal, query: { ...query, interval: range.interval } }),
        api.get<unknown>('/api/usage/azure-services/summary', { signal, query }),
    ]);
    return { totals: readUsageTotals(summary), timeline: readTimeline(timeline), azureTotal: readAzureTotal(azure) };
}

export async function getBreakdown(report: BreakdownReport, preset: RangePreset, signal?: AbortSignal): Promise<BreakdownRow[]> {
    const query = usageQuery(deriveRangeParams(preset));
    return readBreakdown(report, await api.get<unknown>(BREAKDOWN_PATHS[report], { signal, query }));
}

export async function getFeedback(
    preset: RangePreset,
    signal?: AbortSignal,
): Promise<{ summary: FeedbackSummary; items: FeedbackItem[] }> {
    const query = windowQuery(deriveRangeParams(preset));
    const [items, summary] = await Promise.all([
        api.get<unknown>('/api/feedback/org', { signal, query }),
        api.get<unknown>('/api/feedback/org/summary', { signal, query }),
    ]);
    return { summary: readFeedbackSummary(summary), items: readFeedback(items) };
}

export interface TerminationsReport {
    summary: TerminationSummary;
    timeline: TerminationPoint[];
    rows: Termination[];
    byAgent: TerminationsByAgent[];
}

export async function getTerminations(preset: RangePreset, signal?: AbortSignal): Promise<TerminationsReport> {
    const range = deriveRangeParams(preset);
    const query = windowQuery(range);
    const [summary, timeline, rows, byAgent] = await Promise.all([
        api.get<unknown>('/api/terminations/org/summary', { signal, query }),
        api.get<unknown>('/api/terminations/org/timeline', { signal, query: { ...query, interval: range.interval } }),
        api.get<unknown>('/api/terminations/org', { signal, query: { ...query, limit: 200 } }),
        api.get<unknown>('/api/terminations/org/by-agent', { signal, query }),
    ]);
    return {
        summary: readTerminationSummary(summary),
        timeline: readTerminationTimeline(timeline),
        rows: readTerminations(rows),
        byAgent: readTerminationsByAgent(byAgent),
    };
}
