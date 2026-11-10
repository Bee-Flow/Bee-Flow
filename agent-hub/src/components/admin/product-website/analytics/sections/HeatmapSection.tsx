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
import { Flame, ShieldAlert, MoveVertical, AlertTriangle } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import {
    toPoints, groupByWidth, attributeToBlocks, blockLabel, toScrollReach, reachAt,
    type ScrollReach,
} from '../heatmap/model';
import { usePreviewBackdrop } from '../heatmap/usePreviewBackdrop';
import { rich } from '../rich';
import { Empty, fmt } from '../ui';
import { Card, Skeleton } from '../AsyncCard';
import { ACCENT, ShareBar } from '../BarList';
import { useAnalyticsQuery } from '../useAnalyticsQuery';
import type { AnalyticsScope, AnalyticsSite } from '../../analyticsApi';
import type { XYRow } from '../ui.types';
import type { SiteSettings, PageIndexRow, PreviewBlock, HeatmapPayload, HeatmapSectionProps, StaleNoticeProps, BlockRankingProps, ReachMilestonesProps, RecordingOffProps } from './HeatmapSection.types';
import { PageRail } from './PageRail';
import { StageBody } from './StageBody';
import { ALERT_WARNING, PRIMARY_BTN } from '@/components/mcpLibrary/ui';

export default function HeatmapSection({ scope, site, settings, onOpenSettings }: HeatmapSectionProps) {
    const { t } = useTranslation();
    const [selectedPath, setSelectedPath] = useState(scope?.filters?.path ? String(scope.filters.path) : '');
    const [mode, setMode] = useState('click');
    const [widthChoice, setWidthChoice] = useState<{ path: string; width: number } | null>(null);
    const [highlightId, setHighlightId] = useState<string | null>(null);

    const recording = !!site?.recording;

    // The page index: every path that has recorded clicks, straight from the
    // report. Asking for it without a urlPath is what fills the picker.
    const index = useAnalyticsQuery<{ pages?: PageIndexRow[] }>('report', 'heatmap', scope, {
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
    const [prevPath, setPrevPath] = useState(scope?.filters?.path);
    if (prevPath !== scope?.filters?.path) {
        setPrevPath(scope?.filters?.path);
        if (scope?.filters?.path) setSelectedPath(String(scope.filters.path));
    }
    // Derived, not synced: falling back to the busiest page in render keeps one
    // source of truth and avoids a render pass showing an empty stage first.
    const urlPath = selectedPath || pages[0]?.urlPath || '';
    const detail = useAnalyticsQuery<HeatmapPayload>('report', 'heatmap', scope, {
        body: { urlPath: urlPath || undefined, mode },
        enabled: recording && !!urlPath,
    });

    const pageViews = useAnalyticsQuery<XYRow[]>('query', 'metrics', scope, {
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

    const scrollReach = useMemo<ScrollReach & { pageW?: number }>(() => toScrollReach(detail.payload?.scroll), [detail.payload]);

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
        <div className="flex flex-col gap-3.5">
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
                <div className="grid grid-cols-[minmax(0,1fr)_320px] gap-3.5 [align-items:start]">
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

function StaleNotice({ liveH, recordedH }: StaleNoticeProps) {
    const { t } = useTranslation();
    return (
        <div className={ALERT_WARNING}>
            <AlertTriangle className="w-[14px] h-[14px] shrink-0 mt-[1px]" />
            <span>
                {rich(t('cms_site.analytics.heatmap.stale', 'This page is {live} tall today, but these clicks were recorded on a {recorded} page. It has been edited since — positions below the first screen may not line up with what visitors actually saw.'), {
                    live: <strong>{fmt(Math.round(liveH))}px</strong>,
                    recorded: <strong>{fmt(Math.round(recordedH))}px</strong>,
                })}
            </span>
        </div>
    );
}

function BlockRanking({ attribution, views, highlightId, onHighlight, ready }: BlockRankingProps) {
    const { t } = useTranslation();
    const { rows, total } = attribution;
    return (
        <Card title={t('cms_site.analytics.heatmap.ranking', 'Where the clicks go')} icon={Flame} action={
            total ? <span className="text-[11px] text-[var(--text-tertiary)]">{t('cms_site.analytics.heatmap.clicks_count', '{n} clicks', { n: fmt(total) })}</span> : null
        }>
            {!ready ? <Skeleton height={200} />
                : rows.length === 0 ? <Empty text={t('cms_site.analytics.heatmap.no_attribution', 'No clicks to attribute yet.')} />
                : (
                    <div className="flex flex-col gap-0.5">
                        {rows.map(r => {
                            const isChrome = r.id === '__chrome__';
                            const on = highlightId === r.id;
                            return (
                                <button
                                    key={r.id}
                                    onMouseEnter={() => onHighlight?.(isChrome ? null : r.id)}
                                    onMouseLeave={() => onHighlight?.(null)}
                                    type="button"
                                    className={`block w-full cursor-default rounded-lg border px-2.5 py-2 text-left ${on ? 'border-[var(--border-default)] bg-[var(--bg-tertiary)]' : 'border-transparent'}`}
                                >
                                    <div className="flex justify-between gap-2 mb-1">
                                        <span className={`text-xs font-semibold overflow-hidden text-ellipsis whitespace-nowrap ${isChrome ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-primary)]'}`}>{blockLabel(r.type, t)}</span>
                                        <span className="text-xs font-semibold tabular-nums text-[var(--text-primary)] shrink-0">
                                            {Math.round(r.share)}%
                                        </span>
                                    </div>
                                    <ShareBar value={r.share} of={100} />
                                    <div className="text-[11px] text-[var(--text-tertiary)] mt-1">
                                        {r.per100 != null && views > 0
                                            ? t('cms_site.analytics.heatmap.clicks_per100', '{n} clicks · {per} per 100 views', { n: fmt(r.clicks), per: r.per100.toFixed(1) })
                                            : t('cms_site.analytics.heatmap.clicks_count', '{n} clicks', { n: fmt(r.clicks) })}
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                )}
        </Card>
    );
}

function ReachMilestones({ reach, blocks, pageHeight }: ReachMilestonesProps) {
    const { t } = useTranslation();
    if (!reach.steps.length) {
        return <Card title={t('cms_site.analytics.heatmap.reach_title', 'How far visitors get')} icon={MoveVertical}><Empty text={t('cms_site.analytics.heatmap.no_scroll', 'No scroll data yet.')} /></Card>;
    }
    const marks = [25, 50, 75, 100].map(d => ({
        depth: d,
        reach: reachAt(reach.steps, d),
        block: pageHeight
            ? blocks?.find(b => (d / 100) * pageHeight >= b.top && (d / 100) * pageHeight < b.top + b.height)
            : null,
    }));
    return (
        <Card title={t('cms_site.analytics.heatmap.reach_title', 'How far visitors get')} icon={MoveVertical} action={
            <span className="text-[11px] text-[var(--text-tertiary)]">{t('cms_site.analytics.heatmap.sessions_count', '{n} sessions', { n: fmt(reach.totalSessions) })}</span>
        }>
            <div className="flex flex-col gap-3">
                {marks.map(m => (
                    <div key={m.depth}>
                        <div className="flex justify-between gap-2 mb-1">
                            <span className="text-xs text-[var(--text-primary)]">
                                {m.block
                                    ? t('cms_site.analytics.heatmap.depth_block', '{depth}% down · {block}', { depth: m.depth, block: blockLabel(m.block.type, t) })
                                    : t('cms_site.analytics.heatmap.depth', '{depth}% down', { depth: m.depth })}
                            </span>
                            <span className="text-xs font-semibold tabular-nums text-[var(--text-primary)]">
                                {m.reach == null ? '—' : `${Math.round(m.reach)}%`}
                            </span>
                        </div>
                        <ShareBar value={m.reach || 0} of={100} />
                    </div>
                ))}
            </div>
            <p className="text-[11px] text-[var(--text-tertiary)] mt-3 mx-0 mb-0">
                {t('cms_site.analytics.heatmap.reach_note', 'Share of recorded sessions that scrolled at least this far.')}
            </p>
        </Card>
    );
}

function RecordingOff({ site, settings, onOpenSettings }: RecordingOffProps) {
    const { t } = useTranslation();
    return (
        <Card title={t('cms_site.analytics.heatmap.off_title', 'Heatmaps')} icon={Flame}>
            <div className="flex flex-col gap-3 items-start">
                <p className="text-[13px] text-[var(--text-secondary)] m-0">
                    {site?.name
                        ? t('cms_site.analytics.heatmap.off_named', 'Heatmaps need session recording, which is off for “{name}”.', { name: site.name })
                        : t('cms_site.analytics.heatmap.off_site', 'Heatmaps need session recording, which is off for this site.')}
                </p>
                <div className="flex gap-2 items-start text-xs text-[var(--text-tertiary)]">
                    <ShieldAlert className="w-[14px] h-[14px] mt-[1px] shrink-0 text-[var(--warning-ink)]" />
                    <span>
                        {t('cms_site.analytics.heatmap.off_body', 'Recording captures clicks, scrolling and page structure from real visitors, so it only ever runs for people who accepted your cookie banner — in every consent mode. Form inputs are masked.')}
                    </span>
                </div>
                <button type="button" onClick={onOpenSettings} className={PRIMARY_BTN}>
                    {t('cms_site.analytics.heatmap.turn_on', 'Turn on session recording')}
                </button>
                {settings?.consentMode && (
                    <p className="text-[11px] text-[var(--text-tertiary)] m-0">
                        {t('cms_site.analytics.heatmap.banner_needed', 'Your cookie banner must be enabled on the site for recording to ever start.')}
                    </p>
                )}
            </div>
        </Card>
    );
}

