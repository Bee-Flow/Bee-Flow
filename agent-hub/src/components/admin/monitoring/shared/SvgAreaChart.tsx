import { useId, useState } from 'react';
import { CHART_SERIES } from '@/components/shared/charts/chartChrome';
import { useTranslation } from '@/hooks/useTranslation';
import { useLocaleFormat, type LocaleFormat } from '@/hooks/useLocaleFormat';
import type { ChartPoint, EmptyProps, SvgAreaChartProps } from '../shared.types';

const DAY_PERIOD = /^(\d{4})-(\d{2})-(\d{2})$/;
const HOUR_PERIOD = /^\d{4}-\d{2}-\d{2}[ T](\d{2}:\d{2})/;

/**
 * A timeline period ('YYYY-MM-DD' per day, 'YYYY-MM-DD HH:00' per hour) for an
 * axis: "11 Nov" in the language on screen, or the hour. Anything else keeps
 * the old month-day cut.
 */
export function periodLabel(period: string | undefined, lf: LocaleFormat): string {
    if (!period) return '';
    const hour = HOUR_PERIOD.exec(period);
    if (hour) return hour[1];
    const day = DAY_PERIOD.exec(period);
    // A bare day is a calendar day, not UTC midnight: built from its parts so no time zone moves it.
    if (day) return lf.day(new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])), { year: false });
    return period.slice(5);
}

/** One point is no trend: its value and the period, said plainly instead of a line from one corner to the other. */
function SinglePoint({ point, yKey, formatY, color }: { point: ChartPoint; yKey: NonNullable<SvgAreaChartProps['yKey']>; formatY: NonNullable<SvgAreaChartProps['formatY']>; color: string }) {
    const { t } = useTranslation();
    const lf = useLocaleFormat();
    const hourly = HOUR_PERIOD.test(point.period || '');
    return (
        <div className="flex min-h-[140px] flex-col items-center justify-center gap-1 text-center" data-testid="chart-single-point">
            <svg aria-hidden="true" viewBox="0 0 10 10" className="h-2.5 w-2.5"><circle cx="5" cy="5" r="5" fill={color} /></svg>
            <span className="text-sm font-semibold tabular-nums text-[var(--text-primary)]">{formatY(point[yKey] || 0)}</span>
            <span className="text-[11px] text-[var(--text-tertiary)]">{periodLabel(point.period, lf)}</span>
            <span className="mt-1 max-w-xs text-[11px] text-[var(--text-secondary)]">
                {hourly
                    ? t('admin_polish.trend_one_hour', 'One hour of data in this period. The trend appears from two hours on.')
                    : t('admin_polish.trend_one_day', 'One day of data in this period. The trend appears from two days on.')}
            </span>
        </div>
    );
}

export function fmt(n: number | null | undefined) {
    if (n == null) return '0';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return String(Math.round(n));
}

/**
 * The AI Monitor's series colours by role, on the theme's chart slots
 * (`--chart-1..8`, components/shared/charts/chartChrome): one validated
 * categorical palette per surface lightness, no purple. Input tokens and the
 * token trend are slot 1, output and cost slot 4, billed cost slot 3. Text,
 * axes and tooltips stay on the text/border tokens.
 */
export const SERIES = Object.freeze({
    tokens: CHART_SERIES[0],
    input: CHART_SERIES[0],
    output: CHART_SERIES[3],
    cost: CHART_SERIES[3],
    billed: CHART_SERIES[2],
});

/** A quiet "nothing here" line inside a card or table. */
export function Empty({ text }: EmptyProps) {
    return (
        <div className="rounded-lg border border-dashed border-[var(--border-default)] px-4 py-8 text-center text-xs text-[var(--text-tertiary)]">
            {text}
        </div>
    );
}

export function SvgAreaChart({ data, yKey = 'total_tokens', color = SERIES.tokens, height = 140, formatY = fmt, formatLabel }: SvgAreaChartProps) {
    const { t } = useTranslation();
    const lf = useLocaleFormat();
    const [hover, setHover] = useState<number | null>(null);
    const gradientId = `area-${useId().replace(/:/g, '')}`;
    if (!data || data.length === 0) return <Empty text={t('admin_polish.chart_no_data', 'No data to display')} />;
    if (data.length === 1) return <SinglePoint point={data[0]} yKey={yKey} formatY={formatY} color={color} />;
    const maxY = Math.max(...data.map(d => d[yKey] || 0), 1);
    const points = data.map((d, i) => {
        const x = (i / Math.max(data.length - 1, 1)) * 100;
        const y = 100 - ((d[yKey] || 0) / maxY) * 90; // 90% max to leave top padding
        return { x, y, d };
    });
    const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
    const areaPath = `${linePath} L100,100 L0,100 Z`;
    const hovered = hover != null ? points[hover] : undefined;
    return (
        <div className="relative">
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="block w-full overflow-visible" style={{ height }}>
                <defs>
                    <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={color} stopOpacity="0.25" />
                        <stop offset="100%" stopColor={color} stopOpacity="0.02" />
                    </linearGradient>
                </defs>
                <path d={areaPath} fill={`url(#${gradientId})`} />
                <path d={linePath} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
                {points.map((p, i) => (
                    <rect
                        key={i}
                        x={i === 0 ? 0 : (points[i - 1].x + p.x) / 2}
                        y="0"
                        width={i === 0 ? (points[1]?.x || 100) / 2 : i === points.length - 1 ? 100 - (points[i - 1].x + p.x) / 2 : (points[i + 1].x - points[i - 1].x) / 2}
                        height="100"
                        fill="transparent"
                        onMouseEnter={() => setHover(i)}
                        onMouseLeave={() => setHover(null)}
                        className="cursor-crosshair"
                    />
                ))}
                {hovered && (
                    <circle cx={hovered.x} cy={hovered.y} r="3" fill={color} stroke="var(--bg-card)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
                )}
            </svg>
            {hovered && (
                <div
                    className="pointer-events-none absolute -top-1.5 z-10 -translate-x-1/2 whitespace-nowrap rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] px-2.5 py-1 text-[11px] font-semibold text-[var(--text-primary)] shadow-[var(--shadow-popover)]"
                    style={{ left: `${hovered.x}%` }}
                >
                    <div className="tabular-nums">{formatY(hovered.d[yKey] || 0)}</div>
                    <div className="mt-px text-[10px] font-normal text-[var(--text-tertiary)]">
                        {formatLabel ? formatLabel(hovered.d) : hovered.d.period || ''}
                    </div>
                </div>
            )}
            <div className="mt-1.5 flex justify-between text-[10px] text-[var(--text-tertiary)]">
                <span>{periodLabel(data[0]?.period, lf)}</span>
                <span>{periodLabel(data[data.length - 1]?.period, lf)}</span>
            </div>
        </div>
    );
}
