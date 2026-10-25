import { useTranslation } from '../../../../../hooks/useTranslation';
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
                <div className="[margin-bottom:10px]">
                    <ErrorNote message={t('cms_site.analytics.heatmap.backdrop_error', '{error} The numbers beside this are still accurate.', { error: backdrop.error })}
                        onRetry={backdrop.reload} compact />
                </div>
            )}

            <div className="[position:relative]">
                <PageStage
                    frameRef={backdrop.frameRef} src={backdrop.src}
                    width={width} height={height}
                    points={noData ? [] : points} blocks={backdrop.blocks}
                    highlightId={highlightId} onHighlight={onHighlight}
                    mode={mode} scroll={noData ? null : scrollReach}
                />

                {(busy || noData) && (
                    <div className="[position:absolute] [inset:0] [display:flex] [align-items:center] [justify-content:center] [border-radius:10px] [background:rgba(10,10,20,0.72)] [backdrop-filter:blur(1px)] [font-size:12px] [color:var(--text-secondary,#ccc)] [text-align:center] [padding:20px]">
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
        <div className="[display:flex] [align-items:center] [gap:8px] [margin-top:10px] [font-size:11px] [color:var(--text-muted,#888)]">
            <span>{t('cms_site.analytics.heatmap.legend_fewer', 'fewer clicks')}</span>
            <span className="[display:inline-block] w-[120px] h-[8px] [border-radius:4px] [background:linear-gradient(90deg,#14b8a6,#10b981,#f59e0b,#f97316,#ef4444)]" />
            <span>{t('cms_site.analytics.heatmap.legend_more', 'more')}</span>
            <span className="[margin-left:10px]">{t('cms_site.analytics.heatmap.legend_hover', 'Hover the page to highlight a block.')}</span>
        </div>
    );
}

function ScrollLegend({ reach }: ScrollLegendProps) {
    const { t } = useTranslation();
    return (
        <div className="[margin-top:10px] [font-size:11px] [color:var(--text-muted,#888)]">
            {reach.totalSessions
                ? t('cms_site.analytics.heatmap.scroll_legend_n', 'Darker means fewer visitors got that far — out of {n} recorded sessions.', { n: fmt(reach.totalSessions) })
                : t('cms_site.analytics.heatmap.scroll_legend', 'Darker means fewer visitors got that far.')}
        </div>
    );
}
