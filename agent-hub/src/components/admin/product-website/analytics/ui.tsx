/**
 * Presentation kit for the Website Analytics dashboard.
 *
 * Composes the two existing admin kits rather than adding a fourth:
 *   - MonitoringPanel/shared : Card, SvgAreaChart, DonutChart, SortableTable, fmt
 *   - settings/usage/kit     : TrendChip, Sparkline, MetricCard, TOKENS
 * Only genuinely new primitives (drill-down breakdowns, partial-error notes,
 * heatmap/funnel/retention visuals) are written from scratch.
 *
 * Colour rule: series colours come from the theme's chart slots
 * (`--chart-1..8`, components/shared/charts/chartChrome), a validated palette
 * with no purple/violet/indigo; text, surfaces and borders from the tokens.
 */
import { type CSSProperties, type ReactNode } from 'react';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import { TrendChip } from '@/pages/settings/usage/kit';
import { CHART_SERIES } from '@/components/shared/charts/chartChrome';
import { CHIP_INFO, FILTER_CHIP_OFF, FILTER_CHIP_ON } from '@/components/mcpLibrary/ui';
import { SeriesDot, SortableTable } from '../../monitoring/shared';
import { Empty, fmt } from '../../monitoring/shared/SvgAreaChart';
import type { BreakdownRow, BreakdownTableProps, CompareKind, CompareResult, RenderStatTileArgs, SplitBarProps, StatField, StatTileProps, XYRow } from './ui.types';
import { ACCENT, ShareBar } from './BarList';
import { Skeleton } from './AsyncCard';
export { Card, ErrorNote, Skeleton, AsyncCard } from './AsyncCard';
export { ACCENT, maxOf, ShareBar, BarList } from './BarList';

export const PALETTE = CHART_SERIES;
export const paletteAt = (i: number) => PALETTE[i % PALETTE.length];

/**
 * Categorical series colours, as a fixed set rather than by rank.
 *
 * Assigning by index means bars repaint when a list is filtered. Ranked lists
 * should be single-hue (length carries magnitude); only genuinely categorical
 * series need distinct colours, and then these four chart slots (blue, green,
 * amber, red).
 */
export const SERIES = Object.freeze({
    primary: CHART_SERIES[0], secondary: CHART_SERIES[2], warn: CHART_SERIES[3], bad: CHART_SERIES[7],
});

export { Empty, SortableTable, fmt };

// ── Value helpers ────────────────────────────────────────────────────

// Umami stat fields are either { value, prev } or a bare number depending on
// version — normalise both.
export const statVal = (s: StatField): number => (s && typeof s === 'object' ? (s.value ?? 0) : (typeof s === 'number' ? s : 0));

export function fmtDurationSec(sec?: number | null): string {
    const s = Math.max(0, Math.round(sec || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m > 0 ? `${m}m ${r}s` : `${r}s`;
}

/** Umami reports replay/session durations in MILLISECONDS. Formatting them as
 *  seconds turned an 11.8-second recording into "196m 21s". */
export function fmtDurationMs(ms: unknown): string {
    const n = Number(ms);
    if (!Number.isFinite(n) || n < 0) return '—';
    return n < 1000 ? '<1s' : fmtDurationSec(n / 1000);
}

// Pure helpers take an optional translator (`t` from useTranslation) so they
// stay callable from tests and non-React code; without one they print English.
const plainT: TranslateFn = (_key, fallback, params) => String(fallback).replace(/\{(\w+)\}/g, (_, k) => String(params?.[k] ?? ''));

export function fmtAgo(ts: number | string, now = Date.now(), tr: TranslateFn = plainT): string {
    const at = typeof ts === 'number' ? ts : Date.parse(ts);
    if (!Number.isFinite(at)) return '';
    const s = Math.max(0, Math.round((now - at) / 1000));
    if (s < 45) return tr('cms_site.analytics.common.ago_now', 'just now');
    const m = Math.round(s / 60);
    if (m < 60) return tr('cms_site.analytics.common.ago_minutes', '{n}m ago', { n: m });
    const h = Math.round(m / 60);
    if (h < 24) return tr('cms_site.analytics.common.ago_hours', '{n}h ago', { n: h });
    return tr('cms_site.analytics.common.ago_days', '{n}d ago', { n: Math.round(h / 24) });
}

/** `{ "/faq": 5, "/": 2 }` → `[{ x, y }]` sorted desc. Umami's realtime
 *  endpoint returns maps where every other endpoint returns rows. */
export function mapToRows(map: unknown): { x: string; y: number }[] {
    if (!map || typeof map !== 'object' || Array.isArray(map)) return [];
    return Object.entries(map)
        .map(([x, y]) => ({ x, y: Number(y) || 0 }))
        .sort((a, b) => b.y - a.y);
}

/** Umami /pageviews → rows for SvgAreaChart (`period` x-label, `value` yKey). */
export function toTimeseries(series: unknown): { period: string; value: number }[] {
    const arr: XYRow[] = Array.isArray(series) ? series : [];
    return arr.map((p: XYRow) => ({ period: String(p.x || '').slice(0, 16).replace('T', ' '), value: p.y || 0 }));
}

/**
 * Umami /metrics → [{ x, y }] → table rows.
 *
 * A missing value is flagged with `isBlank` rather than substituted with the
 * string "(none)": renderers then choose the right words for their dimension
 * ("Direct" for a referrer, "Unknown" for a country), and — the actual bug —
 * a dimension whose real value happens to BE "(none)" stays drillable.
 */
export function toRows(arr: unknown) {
    // `label` is null exactly when `isBlank`: the narrowing BreakdownRow states.
    return (Array.isArray(arr) ? arr : []).map((d: XYRow, i: number) => ({
        label: d.x || null,
        isBlank: !d.x,
        count: d.y || 0,
        _key: `${i}-${d.x ?? ''}`,
    })) as BreakdownRow[];
}

export function toDonut(arr: unknown) {
    return (Array.isArray(arr) ? arr : [])
        .filter((d: XYRow) => (d.y || 0) > 0)
        .map((d: XYRow, i: number) => ({ label: d.x || '(none)', value: d.y || 0, color: paletteAt(i) }));
}

/**
 * Percentage delta vs the previous period. Umami's `stats` returns a
 * `comparison` block that the old dashboard threw away.
 */
export function deltaPct(current: unknown, previous: unknown): number | null {
    const c = Number(current) || 0;
    const p = Number(previous) || 0;
    if (!p) return null;
    return Math.round(((c - p) / p) * 100);
}

/**
 * Period-over-period comparison, aware of what kind of number it is given.
 *
 * `deltaPct` alone is wrong twice over. On a RATE it reports the relative
 * change of a percentage — a bounce rate moving 25% → 20% renders as "↓20%"
 * when the honest statement is "5 points better". And when the previous period
 * is 0 it returns null, so going from nothing to something — usually the most
 * interesting thing on the page — renders as blank space.
 *
 * @param kind 'count' | 'rate' (0-100 points) | 'duration' (seconds) | 'ratio' (0-1)
 */
export function compare(current: unknown, previous: unknown, kind: CompareKind = 'count', tr: TranslateFn = plainT): CompareResult {
    const c = Number(current);
    const p = Number(previous);
    if (!Number.isFinite(c)) return { delta: null, display: null, state: 'none' };
    if (kind === 'rate' || kind === 'ratio') {
        if (!Number.isFinite(p)) return { delta: null, display: null, state: 'none' };
        const scale = kind === 'ratio' ? 100 : 1;
        const points = (c - p) * scale;
        if (Math.abs(points) < 0.05) return { delta: 0, display: tr('cms_site.analytics.common.no_change', 'no change'), state: 'flat' };
        return {
            delta: points,
            display: tr('cms_site.analytics.common.points', '{n} pts', { n: Math.abs(points).toFixed(1) }),
            state: points > 0 ? 'up' : 'down',
        };
    }

    if (!Number.isFinite(p) || p === 0) {
        // A previous period of zero has no meaningful percentage, but "new" is
        // still information — far better than rendering nothing at all.
        if (c === 0) return { delta: null, display: null, state: 'none' };
        return { delta: 100, display: tr('cms_site.analytics.common.new', 'new'), state: 'new' };
    }

    const pct = ((c - p) / p) * 100;
    if (Math.abs(pct) < 0.5) return { delta: 0, display: tr('cms_site.analytics.common.no_change', 'no change'), state: 'flat' };
    return {
        delta: Math.round(pct),
        display: `${Math.abs(Math.round(pct))}%`,
        state: pct > 0 ? 'up' : 'down',
    };
}

/** Traffic-light for a rate where lower is better (bounce, exit). The value is
 *  always printed alongside — colour is never the only carrier. */
export function rateColor(pct: unknown): string {
    const n = Number(pct);
    if (!Number.isFinite(n)) return 'var(--text-tertiary)';
    if (n <= 40) return 'var(--success-ink)';
    if (n <= 60) return 'var(--warning-ink)';
    return 'var(--error-ink)';
}

/** A toggle pill in a card's header (sort by, level, tab): the Studio filter chip, on or off. */
export function pillClass(active: boolean): string {
    return `${active ? FILTER_CHIP_ON : FILTER_CHIP_OFF} cursor-pointer`;
}

/** rateColor as a text class (literal, for Tailwind). */
export function rateClass(pct: unknown): string {
    const n = Number(pct);
    if (!Number.isFinite(n)) return 'text-[var(--text-tertiary)]';
    if (n <= 40) return 'text-[var(--success-ink)]';
    if (n <= 60) return 'text-[var(--warning-ink)]';
    return 'text-[var(--error-ink)]';
}

// ── Stat tile with comparison ────────────────────────────────────────

export function StatTile({
    icon: Icon, label, value, color = ACCENT, delta, deltaLabel,
    goodWhenDown = false, subtitle, deltaDisplay, state,
}: StatTileProps) {
    const { t } = useTranslation();
    // `state: 'new'` has no percentage worth showing — TrendChip would render
    // "100%", implying a measured doubling rather than "there was nothing here
    // before".
    const chipDisplay = deltaDisplay ?? (delta != null ? `${Math.abs(delta)}%` : null);
    return renderStatTile({ Icon, label, value, color, delta, chipDisplay, deltaLabel, goodWhenDown, subtitle, state, t });
}

/**
 * The KPI tile: the shared dashboard StatTile's card, number and label, with
 * the period comparison beside the number (TrendChip, "new" or "no change").
 */
function renderStatTile({ Icon, label, value, delta, chipDisplay, deltaLabel, goodWhenDown, subtitle, state, t }: RenderStatTileArgs) {
    return (
        <div className="min-w-0 rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-4 shadow-[var(--shadow-sm)]">
            <div className="flex flex-wrap items-baseline gap-2">
                <span className="truncate text-2xl font-semibold tabular-nums text-[var(--text-primary)]">{value}</span>
                {state === 'new' ? (
                    <span title={deltaLabel || t('cms_site.analytics.common.new_title', 'nothing in the previous period')} className={CHIP_INFO}>
                        {t('cms_site.analytics.common.new', 'new')}
                    </span>
                ) : state === 'flat' ? (
                    <span title={deltaLabel || t('cms_site.analytics.common.vs_previous', 'vs previous period')}
                        className="text-[11px] text-[var(--text-tertiary)]">{t('cms_site.analytics.common.no_change', 'no change')}</span>
                ) : delta != null && chipDisplay ? (
                    <TrendChip delta={delta} display={chipDisplay} goodWhenDown={goodWhenDown}
                        title={deltaLabel || t('cms_site.analytics.common.vs_previous', 'vs previous period')} />
                ) : null}
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
                {Icon && <span className="text-[var(--text-tertiary)] [&>svg]:h-3.5 [&>svg]:w-3.5"><Icon /></span>}
                <span>{label}</span>
            </div>
            {subtitle && <div className="mt-0.5 text-[11px] text-[var(--text-tertiary)]">{subtitle}</div>}
        </div>
    );
}

/** A row of tiles: two up on a phone, then as many as fit at `min` px (the minimum is the data, hence the custom property). */
export function StatGrid({ children, min = 170 }: { children?: ReactNode; min?: number }) {
    return (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(var(--tile-min),1fr))]" style={{ '--tile-min': `${min}px` } as CSSProperties}>
            {children}
        </div>
    );
}

// ── Failure + loading states ─────────────────────────────────────────

export function SkeletonGrid({ count = 4, height = 80, min = 170 }: { count?: number; height?: number; min?: number }) {
    return (
        <StatGrid min={min}>
            {Array.from({ length: count }, (_, i: number) => <Skeleton key={i} height={height} />)}
        </StatGrid>
    );
}

// ── Breakdown table with drill-down ──────────────────────────────────

/**
 * A [{x,y}] dimension rendered as a sortable table. Clicking a row adds a
 * dashboard-wide filter when `onDrill` is given.
 */
export function BreakdownTable({
    rows, labelHeader, valueHeader, onDrill, maxRows = 10, emptyText,
    blankLabel,
}: BreakdownTableProps) {
    const { t } = useTranslation();
    const blank = blankLabel ?? t('cms_site.analytics.common.unknown', 'Unknown');
    const data = toRows(rows);
    const total = data.reduce((a, r) => a + r.count, 0);
    const columns = [
        {
            key: 'label', label: labelHeader, width: '1fr',
            render: (r: BreakdownRow) => {
                const text = r.isBlank ? blank : r.label;
                const clickable = !!onDrill && !r.isBlank;
                return (
                    <span
                        title={clickable ? t('cms_site.analytics.common.filter_by', 'Filter by {value}', { value: text }) : text}
                        className={`text-xs overflow-hidden text-ellipsis whitespace-nowrap underline-offset-[3px] ${r.isBlank ? 'text-[var(--text-tertiary)] italic' : 'text-[var(--text-primary)] not-italic'} ${clickable ? 'underline decoration-dotted' : 'no-underline'}`}
                    >{text}</span>
                );
            },
        },
        {
            key: 'count', label: valueHeader ?? t('cms_site.analytics.common.views', 'Views'), width: '120px', align: 'right',
            render: (r: BreakdownRow) => (
                <span className="inline-flex w-full items-center justify-end gap-2">
                    <ShareBar value={r.count} of={total} width={44} />
                    <span className="min-w-[34px] text-right text-xs font-semibold tabular-nums text-[var(--text-primary)]">{fmt(r.count)}</span>
                </span>
            ),
        },
    ];
    return (
        <SortableTable
            flush
            ariaLabel={typeof labelHeader === 'string' ? labelHeader : undefined}
            columns={columns}
            data={data}
            maxRows={maxRows}
            emptyText={emptyText || t('cms_site.analytics.common.no_data', 'No data')}
            onRowClick={onDrill ? (r: BreakdownRow) => !r.isBlank && onDrill(r.label) : undefined}
        />
    );
}

/**
 * A composition bar — one row showing how a whole divides into parts.
 * `mode: 'diverging'` splits positive/negative around a centre line, for
 * period-over-period change.
 */
export function SplitBar({ segments, mode = 'stacked', height = 10, legend = false, formatValue = fmt }: SplitBarProps) {
    const items = (Array.isArray(segments) ? segments : []).filter(s => (Number(s.value) || 0) !== 0);
    if (!items.length) return null;
    const total = items.reduce((a, s) => a + Math.abs(Number(s.value) || 0), 0) || 1;

    return (
        <div>
            <div className="flex gap-px overflow-hidden rounded-full" style={{ height }}>
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
                <div className="flex flex-wrap gap-3 mt-2">
                    {items.map((s, i) => (
                        <span key={`${s.label}-${i}`} className="inline-flex items-center gap-1.5 text-[11px]">
                            <SeriesDot square color={s.color || (mode === 'diverging'
                                ? (Number(s.value) >= 0 ? SERIES.primary : SERIES.bad)
                                : paletteAt(i))} />
                            <span className="text-[var(--text-tertiary)]">{s.label}</span>
                            <span className="text-[var(--text-primary)] font-semibold">{formatValue(s.value)}</span>
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
}

