/**
 * Presentation kit for the Website Analytics dashboard.
 *
 * Composes the two existing admin kits rather than adding a fourth:
 *   - MonitoringPanel/shared : Card, SvgAreaChart, DonutChart, SortableTable, fmt
 *   - settings/usage/kit     : TrendChip, Sparkline, MetricCard, TOKENS
 * Only genuinely new primitives (drill-down breakdowns, partial-error notes,
 * heatmap/funnel/retention visuals) are written from scratch.
 *
 * Colour rule: the project bans purple/violet/indigo, and MonitoringPanel's
 * COLORS.primary is #6366f1 — so every chart/card here is passed an explicit
 * colour and nothing is allowed to fall back to the shared default.
 */
import { AlertTriangle, RefreshCw } from 'lucide-react';
import React from 'react';
import type { ComponentType, CSSProperties, ReactNode } from 'react';
import type { TranslateFn, TranslateParams } from '../../../../hooks/useTranslation';
import { useTranslation } from '../../../../hooks/useTranslation';
import { TrendChip } from '../../../../pages/settings/usage/kit';
import { Card as BaseCard, Empty, SortableTable, fmt } from '../../monitoring/shared';

/** An icon component as the lucide set and the local helpers pass it around. */
import { ACCENT, PALETTE, paletteAt, SERIES, maxOf, statVal, fmtDurationSec, fmtDurationMs, fmtAgo, mapToRows, toTimeseries, toRows, toDonut, deltaPct, compare, rateColor } from './uiFormat';
import type { SeriesPoint, BreakdownRow, DonutSlice, CompareState, CompareResult, SplitSegment } from './uiFormat';
import { BreakdownTable, ShareBar, SplitBar, BarList } from './uiBars';
export { BreakdownTable, ShareBar, SplitBar, BarList };
export { ACCENT, PALETTE, paletteAt, SERIES, maxOf, statVal, fmtDurationSec, fmtDurationMs, fmtAgo, mapToRows, toTimeseries, toRows, toDonut, deltaPct, compare, rateColor };
export type { SeriesPoint, BreakdownRow, DonutSlice, CompareState, CompareResult, SplitSegment };
export type IconType = ComponentType<{ style?: CSSProperties }>;

export { Empty, SortableTable, fmt };

/**
 * Card, shadowing MonitoringPanel's.
 *
 * Identical prop surface, but the icon defaults to ACCENT instead of
 * COLORS.primary — which is #6366f1, the indigo this project bans. Wrapping
 * here fixes every card on the dashboard without touching the monitoring
 * dashboard that legitimately uses the shared one.
 */
export function Card({ title, icon: Icon, children, style, action, iconColor = ACCENT }: {
    title?: ReactNode;
    icon?: IconType;
    children?: ReactNode;
    style?: CSSProperties;
    action?: ReactNode;
    iconColor?: string;
}) {
    // Memoised: a component type created inline during render is a new type on
    // every render, which would remount the icon each time.
    const Tinted = React.useMemo(
        () => (Icon ? (props: { style?: CSSProperties }) => <Icon {...props} style={{ ...props?.style, color: iconColor }} /> : undefined),
        [Icon, iconColor],
    );
    return (
        <BaseCard title={title} icon={Tinted} action={action} style={style}>
            {children}
        </BaseCard>
    );
}

// ── Value helpers ────────────────────────────────────────────────────

// ── Stat tile with comparison ────────────────────────────────────────

export interface StatTileProps {
    icon?: IconType;
    label: ReactNode;
    value: ReactNode;
    color?: string;
    delta?: number | null;
    deltaLabel?: string;
    goodWhenDown?: boolean;
    subtitle?: ReactNode;
    deltaDisplay?: string | null;
    state?: CompareState;
}

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

interface RenderStatTileArgs {
    Icon?: IconType;
    label: ReactNode;
    value: ReactNode;
    color: string;
    delta?: number | null;
    chipDisplay: string | null | undefined;
    deltaLabel?: string;
    goodWhenDown: boolean;
    subtitle?: ReactNode;
    state?: CompareState;
    t: TranslateFn;
}

function renderStatTile({ Icon, label, value, color, delta, chipDisplay, deltaLabel, goodWhenDown, subtitle, state, t }: RenderStatTileArgs) {
    return (
        <div style={{
            background: 'var(--bg-secondary, #1a1a2e)',
            border: '1px solid var(--border-subtle, rgba(255,255,255,0.08))',
            borderRadius: 12, padding: '12px 14px',
        }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
                {Icon && <Icon style={{ width: 14, height: 14, color }} />}
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted, #888)' }}>{label}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 22, fontWeight: 800, color: 'var(--text-primary, #fff)', lineHeight: 1.1 }}>{value}</span>
                {state === 'new' ? (
                    <span title={deltaLabel || t('cms_site.analytics.common.new_title', 'nothing in the previous period')} style={{
                        fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em',
                        padding: '2px 6px', borderRadius: 5, background: `${ACCENT}1f`, color: ACCENT,
                    }}>{t('cms_site.analytics.common.new', 'new')}</span>
                ) : state === 'flat' ? (
                    <span title={deltaLabel || t('cms_site.analytics.common.vs_previous', 'vs previous period')}
                        style={{ fontSize: 11, color: 'var(--text-muted, #888)' }}>{t('cms_site.analytics.common.no_change', 'no change')}</span>
                ) : delta != null && chipDisplay ? (
                    <TrendChip delta={delta} display={chipDisplay} goodWhenDown={goodWhenDown}
                        title={deltaLabel || t('cms_site.analytics.common.vs_previous', 'vs previous period')} />
                ) : null}
            </div>
            {subtitle && <div style={{ fontSize: 11, color: 'var(--text-muted, #777)', marginTop: 3 }}>{subtitle}</div>}
        </div>
    );
}

export function StatGrid({ children, min = 170 }: { children?: ReactNode; min?: number }) {
    return (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`, gap: 12 }}>
            {children}
        </div>
    );
}

// ── Failure + loading states ─────────────────────────────────────────

/**
 * A card whose data failed to load.
 *
 * This exists because the previous dashboard rendered upstream failures as an
 * ordinary empty table — which is how a hard 400 on every "Top pages" request
 * went unnoticed. An empty state must mean "no data", never "we broke".
 */
export function ErrorNote({ message, onRetry, compact = false }: { message: ReactNode; onRetry?: () => void; compact?: boolean }) {
    const { t } = useTranslation();
    return (
        <div style={{
            display: 'flex', alignItems: 'flex-start', gap: 8,
            padding: compact ? '8px 10px' : '10px 14px', borderRadius: 10,
            background: 'rgba(244,63,94,0.08)', border: '1px solid rgba(244,63,94,0.25)',
            color: '#fda4af', fontSize: 12,
        }}>
            <AlertTriangle style={{ width: 14, height: 14, flexShrink: 0, marginTop: 1 }} />
            <span style={{ flex: 1, wordBreak: 'break-word' }}>{message}</span>
            {onRetry && (
                <button onClick={onRetry} title={t('cms_site.analytics.common.retry', 'Retry')} style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4, background: 'transparent',
                    border: '1px solid rgba(244,63,94,0.35)', borderRadius: 7, color: '#fda4af',
                    fontSize: 11, fontWeight: 700, padding: '3px 8px', cursor: 'pointer', flexShrink: 0,
                }}>
                    <RefreshCw style={{ width: 11, height: 11 }} /> {t('cms_site.analytics.common.retry', 'Retry')}
                </button>
            )}
        </div>
    );
}

export function Skeleton({ height = 80, style }: { height?: number; style?: CSSProperties }) {
    return (
        <div style={{
            height, borderRadius: 10, background: 'var(--bg-secondary, rgba(255,255,255,0.04))',
            border: '1px solid var(--border-subtle, rgba(255,255,255,0.06))',
            animation: 'bf-analytics-pulse 1.4s ease-in-out infinite', ...style,
        }} />
    );
}

export function SkeletonGrid({ count = 4, height = 80, min = 170 }: { count?: number; height?: number; min?: number }) {
    return (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`, gap: 12 }}>
            {Array.from({ length: count }, (_, i) => <Skeleton key={i} height={height} />)}
        </div>
    );
}

/** Keyframes for the skeleton pulse — mounted once by the panel shell. */
export function AnalyticsStyles() {
    return (
        <style>{`
            @keyframes bf-analytics-pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.45 } }
        `}</style>
    );
}

/**
 * Wraps a section body in the three states every panel needs. Keeps each
 * section from re-implementing loading/error/empty inconsistently.
 */
export function AsyncCard({ title, icon, loading, error, onRetry, isEmpty, emptyText, children, right, height = 120 }: {
    title: string;
    icon?: IconType;
    loading: boolean;
    error?: string | null;
    onRetry?: () => void;
    isEmpty?: boolean;
    emptyText?: string;
    children?: ReactNode;
    right?: ReactNode;
    height?: number;
}) {
    const { t } = useTranslation();
    let body;
    if (loading) body = <Skeleton height={height} />;
    else if (error) body = <ErrorNote message={error} onRetry={onRetry} compact />;
    else if (isEmpty) body = <Empty text={emptyText || t('cms_site.analytics.common.no_data', 'No data')} />;
    else body = children;
    return <Card title={title} icon={icon} action={right}>{body}</Card>;
}

// ── Breakdown table with drill-down ──────────────────────────────────

