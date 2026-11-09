import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { ALERT_ERROR } from '@/components/mcpLibrary/ui';
import { Card as BaseCard } from '../../monitoring/shared';
import { Empty } from '../../monitoring/shared/SvgAreaChart';
import type { AsyncCardProps, CardProps, ErrorNoteProps, SkeletonProps } from './ui.types';

/**
 * Card: the monitor's card (the shared DashCard). The icon prop is accepted
 * for the callers' sake and not drawn: the Studio card carries a title, not
 * a tinted glyph.
 */
export function Card({ title, children, action }: CardProps) {
    return <BaseCard title={title} action={action}>{children}</BaseCard>;
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
        <div role="alert" className={`${ALERT_ERROR} ${compact ? '' : 'px-3.5 py-2.5'}`}>
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="flex-1 break-words">{message}</span>
            {onRetry && (
                <button
                    type="button"
                    onClick={onRetry}
                    title={t('cms_site.analytics.common.retry', 'Retry')}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[color-mix(in_srgb,var(--error)_40%,transparent)] px-2 py-0.5 text-[11px] font-semibold hover:bg-[color-mix(in_srgb,var(--error)_10%,transparent)]"
                >
                    <RefreshCw className="h-3 w-3" aria-hidden="true" /> {t('cms_site.analytics.common.retry', 'Retry')}
                </button>
            )}
        </div>
    );
}

/** A pulsing placeholder of the given height (the height is the layout's, hence inline). */
export function Skeleton({ height = 80 }: SkeletonProps) {
    return <div aria-hidden="true" className="animate-pulse rounded-xl bg-[var(--bg-secondary)]" style={{ height }} />;
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
