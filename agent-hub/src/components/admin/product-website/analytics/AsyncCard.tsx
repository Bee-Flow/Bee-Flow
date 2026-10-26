import { AlertTriangle, RefreshCw } from 'lucide-react';
import React, { type CSSProperties } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { Card as BaseCard } from '../../monitoring/shared';
import { Empty } from '../../monitoring/shared/SvgAreaChart';
import type { AsyncCardProps, CardProps, ErrorNoteProps, SkeletonProps } from './ui.types';
import { ACCENT } from './BarList';

/**
 * Card, shadowing MonitoringPanel's.
 *
 * Identical prop surface, but the icon defaults to ACCENT instead of
 * COLORS.primary — which is #6366f1, the indigo this project bans. Wrapping
 * here fixes every card on the dashboard without touching the monitoring
 * dashboard that legitimately uses the shared one.
 */
export function Card({ title, icon: Icon, children, style, action, iconColor = ACCENT }: CardProps) {
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

/**
 * A card whose data failed to load.
 *
 * This exists because the previous dashboard rendered upstream failures as an
 * ordinary empty table — which is how a hard 400 on every "Top pages" request
 * went unnoticed. An empty state must mean "no data", never "we broke".
 */
export function ErrorNote({ message, onRetry, compact = false }: ErrorNoteProps) {
    const { t } = useTranslation();
    return (
        <div style={{
            display: 'flex', alignItems: 'flex-start', gap: 8,
            padding: compact ? '8px 10px' : '10px 14px', borderRadius: 10,
            background: 'rgba(244,63,94,0.08)', border: '1px solid rgba(244,63,94,0.25)',
            color: '#fda4af', fontSize: 12,
        }}>
            <AlertTriangle className="w-[14px] h-[14px] [flex-shrink:0] [margin-top:1px]" />
            <span className="[flex:1] [word-break:break-word]">{message}</span>
            {onRetry && (
                <button onClick={onRetry} title={t('cms_site.analytics.common.retry', 'Retry')} className="[display:inline-flex] [align-items:center] [gap:4px] [background:transparent] [border:1px_solid_rgba(244,63,94,0.35)] [border-radius:7px] [color:#fda4af] [font-size:11px] [font-weight:700] [padding:3px_8px] [cursor:pointer] [flex-shrink:0]">
                    <RefreshCw className="w-[11px] h-[11px]" /> {t('cms_site.analytics.common.retry', 'Retry')}
                </button>
            )}
        </div>
    );
}

export function Skeleton({ height = 80, style }: SkeletonProps) {
    return (
        <div style={{
            height, borderRadius: 10, background: 'var(--bg-secondary, rgba(255,255,255,0.04))',
            border: '1px solid var(--border-subtle, rgba(255,255,255,0.06))',
            animation: 'bf-analytics-pulse 1.4s ease-in-out infinite', ...style,
        }} />
    );
}

/**
 * Wraps a section body in the three states every panel needs. Keeps each
 * section from re-implementing loading/error/empty inconsistently.
 */
export function AsyncCard({ title, icon, loading, error, onRetry, isEmpty, emptyText, children, right, height = 120 }: AsyncCardProps) {
    const { t } = useTranslation();
    let body;
    if (loading) body = <Skeleton height={height} />;
    else if (error) body = <ErrorNote message={error} onRetry={onRetry} compact />;
    else if (isEmpty) body = <Empty text={emptyText || t('cms_site.analytics.common.no_data', 'No data')} />;
    else body = children;
    return <Card title={title} icon={icon} action={right}>{body}</Card>;
}
