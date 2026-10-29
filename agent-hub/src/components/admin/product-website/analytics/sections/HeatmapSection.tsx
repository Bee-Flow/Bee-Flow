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
        <div className="[display:flex] [flex-direction:column] [gap:14px]">
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
                <div className="[display:grid] [grid-template-columns:minmax(0,1fr)_320px] [gap:14px] [align-items:start]">
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
        <div style={warnStyle}>
            <AlertTriangle className="w-[14px] h-[14px] [flex-shrink:0] [margin-top:1px]" />
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
            total ? <span className="[font-size:11px] [color:var(--text-muted,#888)]">{t('cms_site.analytics.heatmap.clicks_count', '{n} clicks', { n: fmt(total) })}</span> : null
        }>
            {!ready ? <Skeleton height={200} />
                : rows.length === 0 ? <Empty text={t('cms_site.analytics.heatmap.no_attribution', 'No clicks to attribute yet.')} />
                : (
                    <div className="[display:flex] [flex-direction:column] [gap:2px]">
                        {rows.map(r => {
                            const isChrome = r.id === '__chrome__';
                            const on = highlightId === r.id;
                            return (
                                <button
                                    key={r.id}
                                    onMouseEnter={() => onHighlight?.(isChrome ? null : r.id)}
                                    onMouseLeave={() => onHighlight?.(null)}
                                    style={{
                                        display: 'block', width: '100%', textAlign: 'left', padding: '8px 9px',
                                        borderRadius: 8, border: '1px solid transparent', cursor: 'default',
                                        background: on ? `${ACCENT}14` : 'transparent',
                                        borderColor: on ? `${ACCENT}44` : 'transparent',
                                    }}
                                >
                                    <div className="[display:flex] [justify-content:space-between] [gap:8px] [margin-bottom:4px]">
                                        <span className={`[font-size:12px] [font-weight:600] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap] ${isChrome ? '[color:var(--text-muted,_#888)]' : '[color:var(--text-primary,_#fff)]'}`}>{blockLabel(r.type, t)}</span>
                                        <span style={{ fontSize: 12, fontWeight: 800, color: ACCENT, flexShrink: 0 }}>
                                            {Math.round(r.share)}%
                                        </span>
                                    </div>
                                    <ShareBar value={r.share} of={100} />
                                    <div className="[font-size:11px] [color:var(--text-muted,#888)] [margin-top:4px]">
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
            <span className="[font-size:11px] [color:var(--text-muted,#888)]">{t('cms_site.analytics.heatmap.sessions_count', '{n} sessions', { n: fmt(reach.totalSessions) })}</span>
        }>
            <div className="[display:flex] [flex-direction:column] [gap:12px]">
                {marks.map(m => (
                    <div key={m.depth}>
                        <div className="[display:flex] [justify-content:space-between] [gap:8px] [margin-bottom:4px]">
                            <span className="[font-size:12px] [color:var(--text-primary,#fff)]">
                                {m.block
                                    ? t('cms_site.analytics.heatmap.depth_block', '{depth}% down · {block}', { depth: m.depth, block: blockLabel(m.block.type, t) })
                                    : t('cms_site.analytics.heatmap.depth', '{depth}% down', { depth: m.depth })}
                            </span>
                            <span style={{ fontSize: 12, fontWeight: 800, color: ACCENT }}>
                                {m.reach == null ? '—' : `${Math.round(m.reach)}%`}
                            </span>
                        </div>
                        <ShareBar value={m.reach || 0} of={100} />
                    </div>
                ))}
            </div>
            <p className="[font-size:11px] [color:var(--text-muted,#777)] [margin:12px_0_0]">
                {t('cms_site.analytics.heatmap.reach_note', 'Share of recorded sessions that scrolled at least this far.')}
            </p>
        </Card>
    );
}

function RecordingOff({ site, settings, onOpenSettings }: RecordingOffProps) {
    const { t } = useTranslation();
    return (
        <Card title={t('cms_site.analytics.heatmap.off_title', 'Heatmaps')} icon={Flame}>
            <div className="[display:flex] [flex-direction:column] [gap:12px] [align-items:flex-start]">
                <p className="[font-size:13px] [color:var(--text-secondary,#ccc)] [margin:0]">
                    {site?.name
                        ? t('cms_site.analytics.heatmap.off_named', 'Heatmaps need session recording, which is off for “{name}”.', { name: site.name })
                        : t('cms_site.analytics.heatmap.off_site', 'Heatmaps need session recording, which is off for this site.')}
                </p>
                <div className="[display:flex] [gap:8px] [align-items:flex-start] [font-size:12px] [color:var(--text-muted,#888)]">
                    <ShieldAlert className="w-[14px] h-[14px] [margin-top:1px] [flex-shrink:0] [color:#f59e0b]" />
                    <span>
                        {t('cms_site.analytics.heatmap.off_body', 'Recording captures clicks, scrolling and page structure from real visitors, so it only ever runs for people who accepted your cookie banner — in every consent mode. Form inputs are masked.')}
                    </span>
                </div>
                <button onClick={onOpenSettings} style={{
                    padding: '8px 16px', borderRadius: 9, background: ACCENT, color: '#06241f',
                    border: 'none', fontSize: 13, fontWeight: 700, cursor: 'pointer',
                }}>
                    {t('cms_site.analytics.heatmap.turn_on', 'Turn on session recording')}
                </button>
                {settings?.consentMode && (
                    <p className="[font-size:11px] [color:var(--text-muted,#777)] [margin:0]">
                        {t('cms_site.analytics.heatmap.banner_needed', 'Your cookie banner must be enabled on the site for recording to ever start.')}
                    </p>
                )}
            </div>
        </Card>
    );
}

const warnStyle = {
    display: 'flex', gap: 9, alignItems: 'flex-start', padding: '11px 14px',
    borderRadius: 10, background: 'rgba(245,158,11,0.08)',
    border: '1px solid rgba(245,158,11,0.25)', fontSize: 12, color: '#fcd34d',
};
