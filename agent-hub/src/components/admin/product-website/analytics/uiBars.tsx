import { useTranslation } from '../../../../hooks/useTranslation';
import { Empty, SortableTable, fmt } from '../../monitoring/shared';
import { ACCENT, paletteAt, SERIES, maxOf, toRows } from './uiFormat';
import type { SeriesPoint, BreakdownRow, SplitSegment } from './uiFormat';

/**
 * A [{x,y}] dimension rendered as a sortable table. Clicking a row adds a
 * dashboard-wide filter when `onDrill` is given.
 */
export function BreakdownTable({
    rows, labelHeader, valueHeader, onDrill, maxRows = 10, emptyText,
    blankLabel,
}: {
    rows: SeriesPoint[] | null | undefined;
    labelHeader: string;
    valueHeader?: string;
    onDrill?: (label: string) => void;
    maxRows?: number;
    emptyText?: string;
    blankLabel?: string;
}) {
    const { t } = useTranslation();
    const blank = blankLabel ?? t('cms_site.analytics.common.unknown', 'Unknown');
    const data = toRows(rows);
    const total = data.reduce((a, r) => a + r.count, 0);
    const columns = [
        {
            key: 'label', label: labelHeader, width: '1fr',
            render: (r: BreakdownRow) => {
                const text = (r.isBlank ? blank : r.label) as string;
                const clickable = !!onDrill && !r.isBlank;
                return (
                    <span
                        title={clickable ? t('cms_site.analytics.common.filter_by', 'Filter by {value}', { value: text }) : text}
                        style={{
                            fontSize: 12, overflow: 'hidden',
                            color: r.isBlank ? 'var(--text-muted, #888)' : 'var(--text-primary, #fff)',
                            fontStyle: r.isBlank ? 'italic' : 'normal',
                            textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            textDecoration: clickable ? 'underline dotted' : 'none',
                            textUnderlineOffset: 3,
                        }}
                    >{text}</span>
                );
            },
        },
        {
            key: 'count', label: valueHeader ?? t('cms_site.analytics.common.views', 'Views'), width: '120px', align: 'right',
            render: (r: BreakdownRow) => (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end', width: '100%' }}>
                    <ShareBar value={r.count} of={total} width={44} />
                    <span style={{ fontSize: 12, fontWeight: 700, color: ACCENT, minWidth: 34, textAlign: 'right' }}>{fmt(r.count)}</span>
                </span>
            ),
        },
    ];
    return (
        <SortableTable
            columns={columns}
            data={data}
            maxRows={maxRows}
            emptyText={emptyText || t('cms_site.analytics.common.no_data', 'No data')}
            onRowClick={onDrill ? (r: BreakdownRow) => !r.isBlank && onDrill(r.label as string) : undefined}
        />
    );
}

/**
 * The "bar in a table cell" every section wanted its own table for. It is a
 * cell renderer, not a table — `SortableTable` stays the only table.
 */
export function ShareBar({ value, of, color = ACCENT, height = 5, width, label }: {
    value: number;
    of: number;
    color?: string;
    height?: number;
    width?: number | string;
    label?: string;
}) {
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
 * A composition bar — one row showing how a whole divides into parts.
 * `mode: 'diverging'` splits positive/negative around a centre line, for
 * period-over-period change.
 */
export function SplitBar({ segments, mode = 'stacked', height = 10, legend = false, formatValue = fmt }: {
    segments: SplitSegment[] | null | undefined;
    mode?: 'stacked' | 'diverging';
    height?: number;
    legend?: boolean;
    formatValue?: (n: number) => string;
}) {
    const items = (Array.isArray(segments) ? segments : []).filter(s => (Number(s.value) || 0) !== 0);
    if (!items.length) return null;
    const total = items.reduce((a, s) => a + Math.abs(Number(s.value) || 0), 0) || 1;

    return (
        <div>
            <div style={{ display: 'flex', height, borderRadius: 99, overflow: 'hidden', gap: 1 }}>
                {items.map((s, i) => {
                    const share = (Math.abs(Number(s.value) || 0) / total) * 100;
                    const color = s.color || (mode === 'diverging'
                        ? (Number(s.value) >= 0 ? SERIES.primary : SERIES.bad)
                        : paletteAt(i));
                    return (
                        <div
                            key={`${s.label}-${i}`}
                            title={`${s.label}: ${formatValue(s.value)} (${share.toFixed(1)}%)`}
                            style={{ width: `${share}%`, background: color }}
                        />
                    );
                })}
            </div>
            {legend && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 8 }}>
                    {items.map((s, i) => (
                        <span key={`${s.label}-${i}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                            <span style={{
                                width: 8, height: 8, borderRadius: 2, flexShrink: 0,
                                background: s.color || (mode === 'diverging'
                                    ? (Number(s.value) >= 0 ? SERIES.primary : SERIES.bad)
                                    : paletteAt(i)),
                            }} />
                            <span style={{ color: 'var(--text-muted, #888)' }}>{s.label}</span>
                            <span style={{ color: 'var(--text-primary, #fff)', fontWeight: 700 }}>{formatValue(s.value)}</span>
                        </span>
                    ))}
                </div>
            )}
        </div>
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
}: {
    rows: SeriesPoint[] | null | undefined;
    onDrill?: (label: string) => void;
    max?: number;
    formatValue?: (n: number) => string;
    emptyText?: string;
    color?: string;
    peak?: number;
    blankLabel?: string;
}) {
    const { t } = useTranslation();
    const items = (Array.isArray(rows) ? rows : []).slice(0, max);
    if (!items.length) return <Empty text={emptyText ?? t('cms_site.analytics.common.no_data', 'No data')} />;
    const peak = peakProp || maxOf(items.map(r => r.y || 0));
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {items.map((r, i) => {
                const isBlank = !r.x;
                const label = (isBlank ? (blankLabel ?? t('cms_site.analytics.common.unknown', 'Unknown')) : r.x) as string;
                const clickable = !!onDrill && !isBlank;
                return (
                    <button
                        key={`${i}-${label}`}
                        onClick={clickable ? () => (onDrill as (label: string) => void)(label) : undefined}
                        title={clickable ? t('cms_site.analytics.common.filter_by', 'Filter by {value}', { value: label }) : label}
                        style={{
                            display: 'block', width: '100%', textAlign: 'left', background: 'transparent',
                            border: 'none', padding: 0, cursor: clickable ? 'pointer' : 'default',
                        }}
                    >
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 3 }}>
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
