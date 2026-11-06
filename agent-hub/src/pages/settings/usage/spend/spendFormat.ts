// Small helpers the Overview and Spend tabs share.

import type { SummaryRow, TimelineRow, UsageMetrics } from '../OverviewTab.types';

/** The cost the page headlines: billed for a customer, else the estimate with the Azure part. */
export function headlineCost(summary: SummaryRow | null, isCustomerView: boolean): number {
    if (isCustomerView) return Number(summary?.billed_cost || 0);
    return Number(summary?.combined_total_cost ?? summary?.total_estimated_cost ?? 0);
}

export function costOf(row: UsageMetrics): number {
    return Number(row.estimated_cost ?? row.billed_cost ?? 0);
}

export function timelineCost(r: TimelineRow, isCustomerView = false): number {
    return Number(isCustomerView ? (r.billed_cost ?? r.total_cost ?? 0) : (r.total_cost ?? r.estimated_cost ?? 0));
}

export function timelineCalls(r: TimelineRow): number {
    return Number(r.total_calls ?? r.calls ?? 0);
}

export function timelineDate(r: TimelineRow): string {
    return String(r.date ?? r.bucket ?? r.period ?? '');
}

/** A model row without a usable name: the provider did not report one, so it cannot be priced. */
export function isUnknownModel(model: string | null | undefined): boolean {
    const m = String(model ?? '').trim().toLowerCase();
    return m === '' || m === 'unknown';
}

/** Percentage change from `prev` to `cur`; null without a positive previous figure. */
export function pctChange(cur: number, prev: number | null | undefined): number | null {
    if (prev == null || !(prev > 0)) return null;
    return ((cur - prev) / prev) * 100;
}

/** A whole-number share of a total. */
export function share(part: number, total: number): number {
    return total > 0 ? Math.round((part / total) * 100) : 0;
}

/**
 * A per-day average over the period. The timeline holds only the days WITH
 * usage, so the period length is the divisor; the row count is the fallback
 * for the "all" preset, where `days` is null.
 */
export function perDay(total: number, days: number | null | undefined, timeline: readonly unknown[]): number {
    const n = days ?? timeline.length;
    return n > 0 ? total / n : 0;
}
