/**
 * The realtime pulse — one bar per minute, newest on the right.
 *
 * Deliberately not a TrendChart: at this resolution the data is spiky and
 * mostly empty, and discrete bars read as "these are the minutes something
 * happened" where a smoothed area chart would imply a continuous rate that
 * isn't there.
 */
import React from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { fmt } from '../ui';
import { ACCENT } from '../BarList';
import { CHART_SERIES } from '@/components/shared/charts/chartChrome';

/** One minute of the strip: `t` is the bucket start (ms); `overlay` is the second measure (0 when there is none).
 * Required: `toMinuteStrip` always fills it; the `!= null` at the tooltip predates the type. */
export interface MinuteBucket {
    t: number;
    value: number;
    overlay: number;
}

interface MinuteBarsProps {
    buckets?: MinuteBucket[];
    height?: number;
    color?: string;
    overlayColor?: string;
    caption?: ReactNode;
    formatLabel?: (t: number) => string;
}

export default function MinuteBars({
    buckets = [], height = 72, color = ACCENT, overlayColor = CHART_SERIES[2],
    caption, formatLabel = (t: number) => new Date(t).toISOString().slice(11, 16),
}: MinuteBarsProps) {
    const { t: tr } = useTranslation();
    let peak = 1;
    for (const b of buckets) {
        if (b.value > peak) peak = b.value;
        if (b.overlay > peak) peak = b.overlay;
    }

    if (!buckets.length) {
        return (
            <div className="flex items-center justify-center rounded-lg border border-dashed border-[var(--border-default)] text-xs text-[var(--text-tertiary)]" style={{ height }}>
                {tr('cms_site.analytics.minute_bars.empty', 'Nothing in the last few minutes.')}
            </div>
        );
    }

    return (
        <div>
            <div className="flex items-end gap-0.5" style={{ height }}>
                {buckets.map((b, i) => {
                    const h = Math.max(b.value > 0 ? 2 : 0, (b.value / peak) * height);
                    const oh = b.overlay ? Math.max(2, (b.overlay / peak) * height) : 0;
                    return (
                        <div
                            key={b.t ?? i}
                            title={`${formatLabel(b.t)} — ${fmt(b.value)}${b.overlay != null ? ` views, ${fmt(b.overlay)} visitors` : ''}`}
                            className="relative flex h-full min-w-[2px] flex-1 items-end"
                        >
                            <div className={`w-full rounded-sm ${b.value ? '' : 'opacity-0'}`} style={{ height: h, background: color }} />
                            {oh > 0 && (
                                <div className="absolute bottom-0 left-0 w-full rounded-sm opacity-75" style={{ height: oh, background: overlayColor }} />
                            )}
                        </div>
                    );
                })}
            </div>
            <div className="flex justify-between mt-[5px] text-[10px] text-[var(--text-tertiary)]">
                <span>{formatLabel(buckets[0].t)}</span>
                {caption && <span>{caption}</span>}
                <span>{tr('cms_site.analytics.minute_bars.now', 'now')}</span>
            </div>
        </div>
    );
}
