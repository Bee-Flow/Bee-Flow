/**
 * Heatmap — where visitors click, and how far down they get.
 *
 * The page itself is the backdrop: Umami's report answers
 * `snapshot: { kind:'iframe', url, pageW, pageH }` and stores absolute page
 * coordinates, so the honest way to show a click is to put the page back under
 * it. The previous version normalised every click into a 24x32 grid of coloured
 * squares on a grey rectangle — you could see that something was clicked but
 * never what, and desktop and mobile captures were squashed into one space.
 *
 * The number that makes this actionable is not the picture, though: it is the
 * block ranking. Because the embedded page is same-origin we can read the
 * `data-cms-block-id` boxes the renderer already stamps and say "the pricing
 * block takes 24% of the clicks on this page, 14 per 100 views".
 *
 * Requires session recording, which is opt-in per site and consent-gated on the
 * public site (see SessionRecorder.jsx). When recording is off we say so and
 * link to the toggle rather than rendering a convincing empty canvas.
 */
import { Flame, ShieldAlert, MousePointerClick, MoveVertical, ExternalLink, AlertTriangle } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import {
    toPoints, groupByWidth, attributeToBlocks, blockLabel, toScrollReach, reachAt,
} from '../heatmap/model';
import PageStage from '../heatmap/PageStage';
import { usePreviewBackdrop } from '../heatmap/usePreviewBackdrop';
import { rich } from '../rich';
import { ACCENT, Card, Empty, ErrorNote, Skeleton, ShareBar, fmt } from '../ui';
import { useAnalyticsQuery } from '../useAnalyticsQuery';
import type { AnalyticsScope } from '../../analyticsApi';
import type { IconType } from '../ui';

import type { Mode, WidthGroup, ScrollReach, Backdrop, Attribution, IndexPage, IndexPayload, HeatmapDetail, PageViewRow, QueryState, SiteInfo, SettingsInfo } from './HeatmapSection.types';

import { StageBody, PageRail, StaleNotice, BlockRanking, ReachMilestones, RecordingOff } from './HeatmapParts';
export default function HeatmapSection({ scope, site, settings, onOpenSettings }: {
    scope: AnalyticsScope;
    site?: SiteInfo | null;
    settings?: SettingsInfo | null;
    onOpenSettings: () => void;
}) {
    const { t } = useTranslation();
    const [selectedPath, setSelectedPath] = useState('');
    const [mode, setMode] = useState<Mode>('click');
    const [widthChoice, setWidthChoice] = useState<{ path: string; width: number } | null>(null);
    const [highlightId, setHighlightId] = useState<string | null>(null);

    const recording = !!site?.recording;

    // The page index: every path that has recorded clicks, straight from the
    // report. Asking for it without a urlPath is what fills the picker.
    const index = useAnalyticsQuery<IndexPayload>('report', 'heatmap', scope, {
        body: { mode: 'click' },
        enabled: recording,
    });
    const pages = useMemo(() => {
        const rows = Array.isArray(index.payload?.pages) ? index.payload.pages : [];
        return [...rows].sort((a, b) => (b.count || 0) - (a.count || 0));
    }, [index.payload]);

    // Adopt a dashboard-wide path filter ONCE, then let the picker own its
    // state — a page selector that snaps back on every render is worse than
    // none at all.
    useEffect(() => {
        if (scope?.filters?.path) setSelectedPath(scope.filters.path as string);
    }, [scope?.filters?.path]);
    // Derived, not synced: falling back to the busiest page in render keeps one
    // source of truth and avoids a render pass showing an empty stage first.
    const urlPath = selectedPath || pages[0]?.urlPath || '';
    const detail = useAnalyticsQuery<HeatmapDetail>('report', 'heatmap', scope, {
        body: { urlPath: urlPath || undefined, mode },
        enabled: recording && !!urlPath,
    });

    const pageViews = useAnalyticsQuery<PageViewRow[]>('query', 'metrics', scope, {
        params: { type: 'path', limit: 100 },
        enabled: recording && !!urlPath,
    });
    const views = useMemo(() => {
        const rows = Array.isArray(pageViews.payload) ? pageViews.payload : [];
        return rows.find(r => r.x === urlPath)?.y || 0;
    }, [pageViews.payload, urlPath]);

    // Points, grouped by the width they were captured at. Mixing widths in one
    // normalisation is what put a 390px mobile click in column 2 of a 1280px
    // grid in the old version.
    const widthGroups = useMemo(() => groupByWidth(toPoints(detail.payload)), [detail.payload]);
    // The choice is scoped to the page it was made on, so switching pages falls
    // back to that page's busiest width without an effect to reset it.
    const active = useMemo(
        () => (widthChoice?.path === urlPath && widthGroups.find(g => g.width === widthChoice.width))
            || widthGroups[0] || null,
        [widthGroups, widthChoice, urlPath],
    );

    const scrollReach: ScrollReach = useMemo(() => toScrollReach(detail.payload?.scroll), [detail.payload]);

    // Scroll mode returns no points, so fall back to the width the scroll
    // buckets were captured at rather than silently assuming desktop.
    const stageWidth = active?.width || scrollReach.pageW || 1280;
    const backdrop = usePreviewBackdrop({
        urlPath,
        locale: settings?.defaultLocale || 'en',
        width: stageWidth,
        enabled: recording && !!urlPath,
    });

    const attribution = useMemo(
        () => attributeToBlocks(active?.points || [], backdrop.blocks, { views }),
        [active, backdrop.blocks, views],
    );

    // Honesty check: the page we are drawing on is TODAY's page. If it is a
    // different height from the one the clicks were recorded against, the
    // positions below the first screen cannot be trusted.
    const recordedH = active?.pageH || scrollReach.pageH || 0;
    const liveH = backdrop.pageHeight || 0;
    // Boolean, not the truthiness chain: `recordedH && …` yields the NUMBER 0
    // when nothing was recorded, and React renders a bare 0 on the page.
    const stale = !!(recordedH && liveH) && Math.abs(recordedH - liveH) / recordedH > 0.05;

    if (!recording) return <RecordingOff site={site} settings={settings} onOpenSettings={onOpenSettings} />;

    const loading = index.loading || detail.loading;
    const stageHeight = liveH || recordedH || 0;
    // The click count belongs to the PAGE, not to the current mode's payload:
    // scroll mode returns no points, and reading them made the headline say
    // "0 clicks" next to a picker that said "2 clicks".
    const indexRow = pages.find(p => p.urlPath === urlPath);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <PageRail
                index={index} pages={pages} urlPath={urlPath} onSelectPath={setSelectedPath}
                mode={mode} onSelectMode={setMode}
                widthGroups={widthGroups} activeWidth={active?.width}
                onSelectWidth={(width) => setWidthChoice({ path: urlPath, width })}
                clicks={indexRow?.count || 0}
                sessions={indexRow?.sessions || 0}
                views={views}
            />

            {stale && <StaleNotice liveH={liveH} recordedH={recordedH} />}

            {urlPath && (
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 14, alignItems: 'start' }}>
                    <Card title={mode === 'scroll'
                        ? t('cms_site.analytics.heatmap.title_scroll', 'How far down — {path}', { path: urlPath })
                        : t('cms_site.analytics.heatmap.title_click', 'Where visitors click — {path}', { path: urlPath })}>
                        <StageBody
                            detail={detail} backdrop={backdrop} loading={loading} mode={mode}
                            points={active?.points || []} scrollReach={scrollReach}
                            width={stageWidth} height={stageHeight}
                            highlightId={highlightId} onHighlight={setHighlightId}
                        />
                    </Card>

                    {mode === 'click'
                        ? <BlockRanking attribution={attribution} views={views}
                            highlightId={highlightId} onHighlight={setHighlightId}
                            ready={backdrop.status === 'ready'} />
                        : <ReachMilestones reach={scrollReach} blocks={backdrop.blocks} pageHeight={stageHeight} />}
                </div>
            )}
        </div>
    );
}

