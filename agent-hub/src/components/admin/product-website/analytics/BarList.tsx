import { useTranslation } from '@/hooks/useTranslation';
import { CHART_SERIES } from '@/components/shared/charts/chartChrome';
import { Empty, fmt } from '../../monitoring/shared/SvgAreaChart';
import type { BarListProps, ShareBarProps } from './ui.types';

/**
 * The dashboard's primary series: the theme's first chart slot
 * (`--chart-1`, components/shared/charts/chartChrome). Bars, lines and the
 * active marks read it; text and chrome stay on the text/border tokens.
 */
export const ACCENT = CHART_SERIES[0];

/** A series colour at `pct`% over the surface behind it (a tinted band, a soft fill). */
export function tint(color: string, pct: number): string {
    return `color-mix(in srgb, ${color} ${pct}%, transparent)`;
}

/** Max of a numeric list without spreading it — `Math.max(...arr)` blows the
 *  argument limit (and throws RangeError) somewhere around 100k entries, which
 *  a busy heatmap page reaches easily. */
export function maxOf(values: Iterable<number>, initial = 1): number {
    let m = initial;
    for (const v of values) if (Number.isFinite(v) && v > m) m = v;
    return m;
}

/**
 * The "bar in a table cell" every section wanted its own table for. It is a
 * cell renderer, not a table — `SortableTable` stays the only table. The
 * width and fill are the data; everything else is a class.
 */
export function ShareBar({ value, of, color = ACCENT, height = 5, width, label }: ShareBarProps) {
    const pct = of > 0 ? Math.max(0, Math.min(100, (Number(value) / of) * 100)) : 0;
    return (
        <span
            title={label || `${pct.toFixed(1)}%`}
            className="inline-block shrink-0 overflow-hidden rounded-full bg-[var(--bg-tertiary)] align-middle"
            style={{ width: width || '100%', height }}
        >
            <span className="block h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
        </span>
    );
}

/**
 * Horizontal bar list — better than a table when the shape is a ranking.
 *
 * Single-hue by default: in a ranking, bar length already carries magnitude and
 * the label carries identity, so per-rank colours add nothing and actively
 * mislead — the same item changes colour when the list is filtered. Pass
 * `color` to override, or `peak` to keep the scale stable across two lists.
 */
export function BarList({
    rows, onDrill, max = 8, formatValue = fmt, emptyText,
    color = ACCENT, peak: peakProp, blankLabel,
}: BarListProps) {
    const { t } = useTranslation();
    const items = (Array.isArray(rows) ? rows : []).slice(0, max);
    if (!items.length) return <Empty text={emptyText ?? t('cms_site.analytics.common.no_data', 'No data')} />;
    const peak = peakProp || maxOf(items.map(r => r.y || 0));
    return (
        <div className="flex flex-col gap-2">
            {items.map((r, i) => {
                const isBlank = !r.x;
                const label = isBlank ? (blankLabel ?? t('cms_site.analytics.common.unknown', 'Unknown')) : r.x;
                const clickable = !!onDrill && !isBlank;
                return (
                    <button
                        type="button"
                        key={`${i}-${label}`}
                        onClick={clickable ? () => onDrill(label) : undefined}
                        title={clickable ? t('cms_site.analytics.common.filter_by', 'Filter by {value}', { value: label }) : label}
                        className={`block w-full rounded-md bg-transparent p-0 text-left ${clickable ? 'cursor-pointer hover:bg-[var(--bg-secondary)]' : 'cursor-default'}`}
                    >
                        <div className="mb-1 flex justify-between gap-2.5">
                            <span className={`truncate text-xs ${isBlank ? 'italic text-[var(--text-tertiary)]' : 'text-[var(--text-primary)]'}`}>{label}</span>
                            <span className="shrink-0 text-xs font-semibold tabular-nums text-[var(--text-primary)]">{formatValue(r.y || 0)}</span>
                        </div>
                        <ShareBar value={r.y || 0} of={peak} color={color} />
                    </button>
                );
            })}
        </div>
    );
}
