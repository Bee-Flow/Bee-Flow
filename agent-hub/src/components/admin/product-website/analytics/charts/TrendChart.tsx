/**
 * The dashboard's one time-series chart.
 *
 * Hand-rolled SVG rather than recharts, which is already a dependency: its
 * ResponsiveContainer measures to 0x0 under jsdom and renders nothing, which
 * would make every colocated test that touches a chart assert on an empty box.
 * The shape needed here is small enough that owning it is cheaper than working
 * around that.
 *
 * What it does that MonitoringPanel's SvgAreaChart cannot:
 *   - multiple series on one shared y-scale (this period vs last period)
 *   - null gaps that BREAK the line instead of being drawn as zero
 *   - a dashed final segment for a bucket that is still filling up
 *   - reference lines, for the Core Web Vitals thresholds
 */
import React, { useMemo, useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { fmt } from '../ui';
import { ACCENT } from '../BarList';
import { SeriesDot } from '@/components/admin/monitoring/shared';
import { CHART_SERIES } from '@/components/shared/charts/chartChrome';

/** A series' own colour, else the first slot for the first series and the third (green) for the next. */
const seriesColor = (s: { color?: string }, si: number) => s.color || (si === 0 ? ACCENT : CHART_SERIES[2]);

const PAD = { top: 10, right: 8, bottom: 20, left: 8 };

/** One line of the chart; a null in `data` is a gap, not a zero. */
export interface TrendSeries {
    key?: string;
    label: string;
    data: Array<number | null | undefined>;
    color?: string;
    /** 'line' and 'dashed' draw no area fill; 'dashed' also dashes the stroke. */
    style?: 'line' | 'dashed' | 'area';
}

/** A horizontal reference line (e.g. a Core Web Vitals threshold) at value `y`. */
interface TrendRefLine {
    y: number;
    label?: string;
    color?: string;
}

interface TrendChartProps {
    series?: TrendSeries[];
    labels?: string[];
    height?: number;
    formatY?: (v: number) => string;
    formatLabel?: (i: number) => string;
    refLines?: TrendRefLine[];
    partialLast?: boolean;
    yMin?: number;
    emptyText?: string;
}

function pathFor(values: Array<number | null | undefined>, x: (i: number) => number, y: (v: number) => number) {
    // A null is a gap, not a zero: `M` restarts the line after one.
    let d = '';
    let pen = false;
    values.forEach((v, i) => {
        if (v == null || !Number.isFinite(v)) { pen = false; return; }
        d += `${pen ? 'L' : 'M'}${x(i).toFixed(2)},${y(v).toFixed(2)}`;
        pen = true;
    });
    return d;
}

export default function TrendChart({
    series = [], labels = [], height = 200, formatY = fmt, formatLabel,
    refLines = [], partialLast = false, yMin = 0, emptyText,
}: TrendChartProps) {
    const { t: tr } = useTranslation();
    const [hover, setHover] = useState<number | null>(null);
    const n = labels.length;

    const { scaleX, scaleY, top } = useMemo(() => {
        const all = series.flatMap(s => s.data).filter((v): v is number => v != null && Number.isFinite(v));
        const refs = refLines.map(r => r.y).filter(Number.isFinite);
        const peak = Math.max(...all, ...refs, 1);
        // Round the top of the axis up so the line never touches the frame.
        const nice = peak <= 1 ? 1 : Math.pow(10, Math.floor(Math.log10(peak)));
        const topV = Math.ceil(peak / nice + 0.15) * nice;
        return {
            top: topV,
            scaleX: (i: number) => (n <= 1 ? 50 : (i / (n - 1)) * 100),
            scaleY: (v: number) => {
                const t = (v - yMin) / (topV - yMin || 1);
                return 100 - Math.max(0, Math.min(1, t)) * 100;
            },
        };
    }, [series, refLines, n, yMin]);

    if (!n || !series.some(s => s.data.some(v => v != null))) {
        return (
            <div className="flex items-center justify-center rounded-lg border border-dashed border-[var(--border-default)] text-xs text-[var(--text-tertiary)]" style={{ height }}>
                {emptyText || tr('cms_site.analytics.common.no_data', 'No data')}
            </div>
        );
    }

    const label = (i: number) => (formatLabel ? formatLabel(i) : labels[i]);

    return (
        <div className="relative">
            <svg
                viewBox="0 0 100 100" preserveAspectRatio="none"
                className="block w-full overflow-visible"
                height={height}
                role="img"
                aria-label={`${series.map(s => s.label).join(' and ')} over ${n} points`}
            >
                {refLines.map((r, i) => (
                    <g key={i}>
                        <line x1="0" x2="100" y1={scaleY(r.y)} y2={scaleY(r.y)}
                            stroke={r.color || 'var(--border-default)'}
                            strokeWidth="0.4" strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />
                    </g>
                ))}

                {series.map((s, si) => {
                    const color = seriesColor(s, si);
                    const solid = partialLast ? s.data.slice(0, -1) : s.data;
                    const d = pathFor(solid, scaleX, scaleY);
                    // The final segment is dashed when today's bucket is still
                    // filling — otherwise it reads as a crash that hasn't happened.
                    const tailFrom = s.data.length - 2;
                    const tail = partialLast && tailFrom >= 0
                        ? pathFor(s.data.slice(tailFrom), (i: number) => scaleX(tailFrom + i), scaleY)
                        : '';
                    return (
                        <g key={s.key || si}>
                            {s.style !== 'line' && s.style !== 'dashed' && (
                                <path
                                    d={`${d}L${scaleX(solid.length - 1)},100L${scaleX(0)},100Z`}
                                    fill={color} opacity={0.12}
                                />
                            )}
                            <path d={d} fill="none" stroke={color}
                                strokeWidth={s.style === 'dashed' ? 1.2 : 1.6}
                                strokeDasharray={s.style === 'dashed' ? '3 2' : undefined}
                                strokeLinejoin="round" strokeLinecap="round"
                                vectorEffect="non-scaling-stroke" />
                            {tail && (
                                <path d={tail} fill="none" stroke={color} strokeWidth="1.6"
                                    strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />
                            )}
                        </g>
                    );
                })}

                {hover != null && (
                    <line x1={scaleX(hover)} x2={scaleX(hover)} y1="0" y2="100"
                        stroke="var(--text-tertiary)" strokeWidth="0.4"
                        vectorEffect="non-scaling-stroke" />
                )}

                {/* Invisible hit targets — one per bucket. */}
                {labels.map((_, i) => (
                    <rect key={i} x={scaleX(i) - (n <= 1 ? 50 : 50 / (n - 1))} y="0"
                        width={n <= 1 ? 100 : 100 / (n - 1)} height="100"
                        fill="transparent"
                        onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
                ))}
            </svg>

            <div className="flex justify-between mt-1 text-[10px] text-[var(--text-tertiary)]">
                <span>{label(0)}</span>
                <span>{label(n - 1)}</span>
            </div>

            {hover != null && (
                <div
                    className="pointer-events-none absolute top-0 z-[2] -translate-x-1/2 whitespace-nowrap rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] px-2.5 py-1.5 text-[11px] shadow-[var(--shadow-popover)]"
                    style={{ left: `${scaleX(hover)}%` }}
                >
                    <div className="text-[var(--text-tertiary)] mb-[3px]">{label(hover)}</div>
                    {series.map((s, si) => (
                        <div key={s.key || si} className="flex gap-2 items-center">
                            <SeriesDot square color={seriesColor(s, si)} />
                            <span className="text-[var(--text-tertiary)]">{s.label}</span>
                            <span className="text-[var(--text-primary)] font-semibold ml-auto">
                                {s.data[hover] == null ? 'no data' : formatY(s.data[hover])}
                            </span>
                        </div>
                    ))}
                </div>
            )}

            {series.length > 1 && (
                <div className="flex gap-3.5 mt-1.5 flex-wrap">
                    {series.map((s, si) => (
                        <span key={s.key || si} className="inline-flex items-center gap-1.5 text-[11px]">
                            <span aria-hidden="true" className={`inline-block h-[3px] w-2.5 rounded-sm ${s.style === 'dashed' ? 'opacity-60' : ''}`} style={{ background: seriesColor(s, si) }} />
                            <span className="text-[var(--text-tertiary)]">{s.label}</span>
                        </span>
                    ))}
                    {partialLast && (
                        <span className="text-[11px] text-[var(--text-tertiary)]">
                            {tr('cms_site.analytics.trend_chart.partial_legend', 'dashed = period still in progress')}
                        </span>
                    )}
                </div>
            )}
        </div>
    );
}
;
