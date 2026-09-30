/**
 * Pure helpers behind the usage screens: words for the stored values, the
 * share each row has of a report, the feedback filters and the terminations
 * per period. `t` comes in as a parameter so these stay testable.
 */

import type { TranslateFn } from '@/core/i18n';
import { shortDay } from '@/features/usage';

import type { BreakdownReport, FeedbackItem, FeedbackSummary, TerminationPoint } from './types';

export const BREAKDOWN_REPORTS: readonly BreakdownReport[] = [
    'users',
    'models',
    'sources',
    'agents',
    'models-by-agent',
    'models-by-user',
    'azure',
];

export function isBreakdownReport(value: unknown): value is BreakdownReport {
    return typeof value === 'string' && (BREAKDOWN_REPORTS as readonly string[]).includes(value);
}

export function reportTitle(report: BreakdownReport, t: TranslateFn): string {
    switch (report) {
        case 'users': return t('usage.top_users', 'Top Users');
        case 'models': return t('usage.by_model', 'By Model');
        case 'sources': return t('usage.by_app_area', 'By app area');
        case 'agents': return t('mobile.orgUsage.by_agent', 'By agent');
        case 'models-by-agent': return t('usage.models_per_agent', 'Models per Agent');
        case 'models-by-user': return t('usage.model_usage_by_user', 'Model Usage by User');
        default: return t('usage.azure_services', 'Azure Services');
    }
}

/** usage/widgets.jsx SOURCE_MAP; an unknown source passes through. */
export function sourceLabel(source: string, t: TranslateFn): string {
    switch (source) {
        case 'agent':
        case 'chat': return t('mobile.orgUsage.source_agent', 'Agent Chat');
        case 'direct': return t('mobile.orgUsage.source_direct', 'Direct Chat');
        case 'notebook': return t('mobile.orgUsage.source_notebook', 'Notebooks');
        case 'research': return t('mobile.orgUsage.source_research', 'Research');
        case 'template': return t('mobile.orgUsage.source_template', 'Templates');
        case 'designer': return t('mobile.orgUsage.source_designer', 'App Designer');
        case 'agent_stream': return t('mobile.orgUsage.source_agent_stream', 'Agent Stream');
        case 'other': return t('mobile.orgUsage.source_other', 'Other');
        default: return source;
    }
}

/** Each row's fraction of the largest cost, for the bars beside a list. */
export function shareOf(cost: number, rows: readonly { cost: number }[]): number {
    const top = rows.reduce((max, r) => Math.max(max, r.cost), 0);
    return top > 0 ? Math.max(0, Math.min(1, cost / top)) : 0;
}

export type FeedbackFilter = 'all' | 'positive' | 'negative' | 'comments';

export function filterFeedback(items: readonly FeedbackItem[], filter: FeedbackFilter): FeedbackItem[] {
    switch (filter) {
        case 'positive': return items.filter((f) => f.rating === 'up');
        case 'negative': return items.filter((f) => f.rating === 'down');
        case 'comments': return items.filter((f) => Boolean(f.comment));
        default: return [...items];
    }
}

/** Positive share as a fraction, or null with nothing to go on. */
export function positiveRate(summary: FeedbackSummary): number | null {
    return summary.total > 0 ? summary.up / summary.total : null;
}

/** OrgFeedbackPanel's alert: under 60% positive on at least 5 items. */
export function feedbackNeedsReview(summary: FeedbackSummary): boolean {
    const rate = positiveRate(summary);
    return rate !== null && summary.total >= 5 && rate < 0.6;
}

/** Terminations per period, all types stacked into one total, oldest first. */
export function terminationsPerPeriod(points: readonly TerminationPoint[]): { period: string; count: number }[] {
    const totals = new Map<string, number>();
    for (const p of points) totals.set(p.period, (totals.get(p.period) ?? 0) + p.count);
    return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([period, count]) => ({ period, count }));
}

/** An x-axis label: "14:00" for an hourly period, the day otherwise. */
export function periodLabel(period: string): string {
    return period.length > 10 ? period.slice(11) : shortDay(period);
}

export function terminationTypeLabel(type: string, t: TranslateFn): string {
    switch (type) {
        case 'max_tokens': return t('org.terminations_kpi_max_tokens', 'Max tokens');
        case 'max_iterations': return t('org.terminations_kpi_max_iterations', 'Max iterations');
        case 'error': return t('org.terminations_kpi_errors', 'Errors');
        case 'aborted': return t('org.terminations_kpi_aborted', 'Aborted');
        default: return type;
    }
}
