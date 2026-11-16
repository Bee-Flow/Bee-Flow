// "Cost per day": an area chart of the cost timeline, with its peak and a few
// date ticks. Drawn as one SVG whose colours are theme variables.

import { useId } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { useLocaleFormat, type LocaleFormat } from '@/hooks/useLocaleFormat';
import { fMoney } from '../adoption/format';
import type { TimelineRow } from '../OverviewTab.types';
import { timelineCost, timelineDate } from './spendFormat';

interface CostPerDayChartProps {
    timeline: TimelineRow[];
    currency: string;
    isCustomerView?: boolean;
}

const TICKS = 5;

const DAY_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "11 Nov" in the app's language; a bare 'YYYY-MM-DD' is a calendar day (no time zone shifts it). */
function shortDate(raw: string, lf: LocaleFormat): string {
    const day = DAY_ONLY.exec(raw);
    const d = day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])) : new Date(raw);
    return lf.day(d, { year: false }) || raw;
}

/** Up to `TICKS` evenly spaced timeline dates, first and last included. */
function tickDates(timeline: TimelineRow[], lf: LocaleFormat): string[] {
    if (timeline.length <= TICKS) return timeline.map(r => shortDate(timelineDate(r), lf));
    return Array.from({ length: TICKS }, (_, i) => shortDate(timelineDate(timeline[Math.round((i / (TICKS - 1)) * (timeline.length - 1))]), lf));
}

export function CostPerDayChart({ timeline, currency, isCustomerView = false }: CostPerDayChartProps) {
    const { t } = useTranslation();
    const lf = useLocaleFormat();
    const gradientId = useId();
    const label = t('usage.spend_cost_per_day', 'Cost per day');
    if (timeline.length === 0) {
        return (
            <div className="flex flex-col gap-2">
                <p className="m-0 text-[11px] font-semibold uppercase tracking-[.06em] text-[var(--text-muted)]">{label}</p>
                <div className="flex h-[140px] items-center justify-center rounded-lg bg-[var(--bg-secondary)] text-xs text-[var(--text-muted)]">{t('usage.no_data')}</div>
            </div>
        );
    }
    const values = timeline.map(r => timelineCost(r, isCustomerView));
    const max = Math.max(...values, 0.0001);
    const peakIndex = values.indexOf(Math.max(...values));
    const x = (i: number) => (i / Math.max(timeline.length - 1, 1)) * 100;
    const points = values.map((v, i) => `${x(i).toFixed(2)},${(100 - (v / max) * 96).toFixed(2)}`).join(' ');
    const peak = t('usage.spend_peak', 'peak {cost} on {date}', { cost: fMoney(values[peakIndex], currency), date: shortDate(timelineDate(timeline[peakIndex]), lf) });
    // One day is no trend: a line from that day's cost down to the corner read as a fall.
    if (timeline.length === 1) {
        return (
            <div className="flex min-w-0 flex-col gap-2">
                <p className="m-0 text-[11px] font-semibold uppercase tracking-[.06em] text-[var(--text-muted)]">{label}</p>
                <div className="flex h-[140px] flex-col items-center justify-center gap-1 rounded-lg bg-[var(--bg-secondary)] text-center" data-testid="cost-per-day-single">
                    <span className="text-sm font-semibold tabular-nums text-[var(--text-primary)]">{fMoney(values[0], currency)}</span>
                    <span className="text-[11px] text-[var(--text-muted)]">{shortDate(timelineDate(timeline[0]), lf)}</span>
                    <span className="mt-1 max-w-xs text-[11px] text-[var(--text-secondary)]">{t('admin_polish.trend_one_day', 'One day of data in this period. The trend appears from two days on.')}</span>
                </div>
            </div>
        );
    }
    return (
        <div className="flex min-w-0 flex-col gap-2">
            <div className="flex items-baseline justify-between gap-2">
                <p className="m-0 text-[11px] font-semibold uppercase tracking-[.06em] text-[var(--text-muted)]">{label}</p>
                <span className="text-xs text-[var(--text-muted)]">{peak}</span>
            </div>
            <div role="img" aria-label={`${label}: ${peak}`} className="h-[140px] w-full border-b border-[var(--border-default)]">
                <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full overflow-visible">
                    <defs>
                        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="var(--accent-primary)" stopOpacity="0.25" />
                            <stop offset="100%" stopColor="var(--accent-primary)" stopOpacity="0" />
                        </linearGradient>
                    </defs>
                    <polygon points={`0,100 ${points} 100,100`} fill={`url(#${gradientId})`} />
                    <polyline points={points} className="fill-none stroke-[var(--accent-primary)] stroke-[2] [stroke-linecap:round] [stroke-linejoin:round] [vector-effect:non-scaling-stroke]" />
                </svg>
            </div>
            <div className="flex justify-between text-[11px] text-[var(--text-muted)]" aria-hidden="true">
                {tickDates(timeline, lf).map((d, i) => <span key={i}>{d}</span>)}
            </div>
        </div>
    );
}
