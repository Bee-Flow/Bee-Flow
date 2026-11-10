import { useTranslation } from '@/hooks/useTranslation';
import PageStage from '../heatmap/PageStage';
import { fmt } from '../ui';
import { ErrorNote } from '../AsyncCard';
import type { StageBodyProps, ScrollLegendProps } from './HeatmapSection.types';

export function StageBody({
    detail, backdrop, loading, mode, points, scrollReach,
    width, height, highlightId, onHighlight,
}: StageBodyProps) {
    const { t } = useTranslation();
    // Only a failed DATA request replaces the stage; a failed backdrop leaves
    // the numbers beside it perfectly usable.
    if (detail.error) return <ErrorNote message={detail.error} onRetry={detail.reload} compact />;

    const noData = !loading && (
        mode === 'click' ? !points.length : !scrollReach.steps.length
    );
    const busy = loading || backdrop.status === 'loading';

    return (
        <>
            {backdrop.status === 'error' && (
                <div className="mb-2.5">
                    <ErrorNote message={t('cms_site.analytics.heatmap.backdrop_error', '{error} The numbers beside this are still accurate.', { error: backdrop.error })}
                        onRetry={backdrop.reload} compact />
                </div>
            )}

            <div className="relative">
                <PageStage
                    frameRef={backdrop.frameRef} src={backdrop.src}
                    width={width} height={height}
                    points={noData ? [] : points} blocks={backdrop.blocks}
                    highlightId={highlightId} onHighlight={onHighlight}
                    mode={mode} scroll={noData ? null : scrollReach}
                />

                {(busy || noData) && (
                    <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-[color-mix(in_srgb,var(--bg-primary)_80%,transparent)] backdrop-blur-[1px] text-xs text-[var(--text-secondary)] text-center p-5">
                        {busy ? t('cms_site.analytics.heatmap.loading', 'Loading the page…') : (
                            mode === 'click'
                                ? t('cms_site.analytics.heatmap.no_clicks_page', 'No clicks recorded on this page yet.')
                                : t('cms_site.analytics.heatmap.no_scroll_page', 'No scroll data for this page yet — visitors have to scroll for it to be recorded.')
                        )}
                    </div>
                )}
            </div>

            {!noData && (mode === 'click' ? <ClickLegend /> : <ScrollLegend reach={scrollReach} />)}
        </>
    );
}

function ClickLegend() {
    const { t } = useTranslation();
    return (
        <div className="flex items-center gap-2 mt-2.5 text-[11px] text-[var(--text-tertiary)]">
            <span>{t('cms_site.analytics.heatmap.legend_fewer', 'fewer clicks')}</span>
            <span className="inline-block w-[120px] h-[8px] rounded [background:linear-gradient(90deg,#14b8a6,#10b981,#f59e0b,#f97316,#ef4444)]" />
            <span>{t('cms_site.analytics.heatmap.legend_more', 'more')}</span>
            <span className="ml-2.5">{t('cms_site.analytics.heatmap.legend_hover', 'Hover the page to highlight a block.')}</span>
        </div>
    );
}

function ScrollLegend({ reach }: ScrollLegendProps) {
    const { t } = useTranslation();
    return (
        <div className="mt-2.5 text-[11px] text-[var(--text-tertiary)]">
            {reach.totalSessions
                ? t('cms_site.analytics.heatmap.scroll_legend_n', 'Darker means fewer visitors got that far — out of {n} recorded sessions.', { n: fmt(reach.totalSessions) })
                : t('cms_site.analytics.heatmap.scroll_legend', 'Darker means fewer visitors got that far.')}
        </div>
    );
}
