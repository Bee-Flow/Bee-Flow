import { useTranslation } from '../../../../hooks/useTranslation';
import { Empty, fmt } from '../../monitoring/shared/SvgAreaChart';
import type { BarListProps, ShareBarProps } from './ui.types';

export const ACCENT = '#14b8a6';                                  // teal

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
 * cell renderer, not a table — `SortableTable` stays the only table.
 */
export function ShareBar({ value, of, color = ACCENT, height = 5, width, label }: ShareBarProps) {
    const pct = of > 0 ? Math.max(0, Math.min(100, (Number(value) / of) * 100)) : 0;
    return (
        <span
            title={label || `${pct.toFixed(1)}%`}
            style={{
                display: 'inline-block', width: width || '100%', height,
                borderRadius: 99, background: 'var(--bg-tertiary, rgba(255,255,255,0.08))',
                overflow: 'hidden', verticalAlign: 'middle', flexShrink: 0,
            }}
        >
            <span style={{ display: 'block', width: `${pct}%`, height: '100%', borderRadius: 99, background: color }} />
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
        <div className="[display:flex] [flex-direction:column] [gap:7px]">
            {items.map((r, i) => {
                const isBlank = !r.x;
                const label = isBlank ? (blankLabel ?? t('cms_site.analytics.common.unknown', 'Unknown')) : r.x;
                const clickable = !!onDrill && !isBlank;
                return (
                    <button
                        key={`${i}-${label}`}
                        onClick={clickable ? () => onDrill(label) : undefined}
                        title={clickable ? t('cms_site.analytics.common.filter_by', 'Filter by {value}', { value: label }) : label}
                        style={{
                            display: 'block', width: '100%', textAlign: 'left', background: 'transparent',
                            border: 'none', padding: 0, cursor: clickable ? 'pointer' : 'default',
                        }}
                    >
                        <div className="[display:flex] [justify-content:space-between] [gap:10px] [margin-bottom:3px]">
                            <span style={{
                                fontSize: 12, overflow: 'hidden',
                                color: isBlank ? 'var(--text-muted, #888)' : 'var(--text-primary, #fff)',
                                fontStyle: isBlank ? 'italic' : 'normal',
                                textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            }}>{label}</span>
                            <span style={{ fontSize: 12, fontWeight: 700, color: ACCENT, flexShrink: 0 }}>{formatValue(r.y || 0)}</span>
                        </div>
                        <ShareBar value={r.y || 0} of={peak} color={color} />
                    </button>
                );
            })}
        </div>
    );
}
