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

const MODES = [
    { id: 'click', labelKey: 'cms_site.analytics.heatmap.mode_click', label: 'Clicks', icon: MousePointerClick },
    { id: 'scroll', labelKey: 'cms_site.analytics.heatmap.mode_scroll', label: 'Scroll depth', icon: MoveVertical },
];

export default function HeatmapSection({ scope, site, settings, onOpenSettings }) {
    const { t } = useTranslation();
    const [selectedPath, setSelectedPath] = useState('');
    const [mode, setMode] = useState('click');
    const [widthChoice, setWidthChoice] = useState(null);
    const [highlightId, setHighlightId] = useState(null);

    const recording = !!site?.recording;

    // The page index: every path that has recorded clicks, straight from the
    // report. Asking for it without a urlPath is what fills the picker.
    const index = useAnalyticsQuery('report', 'heatmap', scope, {
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
        if (scope?.filters?.path) setSelectedPath(scope.filters.path);
    }, [scope?.filters?.path]);
    // Derived, not synced: falling back to the busiest page in render keeps one
    // source of truth and avoids a render pass showing an empty stage first.
    const urlPath = selectedPath || pages[0]?.urlPath || '';
    const detail = useAnalyticsQuery('report', 'heatmap', scope, {
        body: { urlPath: urlPath || undefined, mode },
        enabled: recording && !!urlPath,
    });

    const pageViews = useAnalyticsQuery('query', 'metrics', scope, {
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

    const scrollReach = useMemo(() => toScrollReach(detail.payload?.scroll), [detail.payload]);

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

/**
 * The stage.
 *
 * The iframe is mounted as soon as there is a page to show and stays mounted —
 * it CANNOT be hidden behind a loading state. The backdrop hook completes its
 * handshake by posting into `frameRef.current.contentWindow`, so gating the
 * frame on "loading" meant the frame never existed, the handshake never
 * arrived, and the hook timed out with "the page preview did not load". The
 * loading and empty states are drawn as overlays on top of it instead.
 */
function StageBody({
    detail, backdrop, loading, mode, points, scrollReach,
    width, height, highlightId, onHighlight,
}) {
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
                <div style={{ marginBottom: 10 }}>
                    <ErrorNote message={t('cms_site.analytics.heatmap.backdrop_error', '{error} The numbers beside this are still accurate.', { error: backdrop.error })}
                        onRetry={backdrop.reload} compact />
                </div>
            )}

            <div style={{ position: 'relative' }}>
                <PageStage
                    frameRef={backdrop.frameRef} src={backdrop.src}
                    width={width} height={height}
                    points={noData ? [] : points} blocks={backdrop.blocks}
                    highlightId={highlightId} onHighlight={onHighlight}
                    mode={mode} scroll={noData ? null : scrollReach}
                />

                {(busy || noData) && (
                    <div style={{
                        position: 'absolute', inset: 0, display: 'flex',
                        alignItems: 'center', justifyContent: 'center', borderRadius: 10,
                        background: 'rgba(10,10,20,0.72)', backdropFilter: 'blur(1px)',
                        fontSize: 12, color: 'var(--text-secondary, #ccc)', textAlign: 'center', padding: 20,
                    }}>
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

/** Page picker, mode switch, capture-width tabs and the headline figures. */
function PageRail({
    index, pages, urlPath, onSelectPath, mode, onSelectMode,
    widthGroups, activeWidth, onSelectWidth, clicks, sessions, views,
}) {
    const { t } = useTranslation();
    return (
        <Card title={t('cms_site.analytics.heatmap.title', 'Heatmap')} icon={Flame} action={
            <div style={{ display: 'flex', gap: 6 }}>
                {MODES.map(m => (
                    <button key={m.id} onClick={() => onSelectMode(m.id)} style={chipStyle(mode === m.id)}>
                        <m.icon style={{ width: 12, height: 12 }} /> {t(m.labelKey, m.label)}
                    </button>
                ))}
            </div>
        }>
            {index.error ? <ErrorNote message={index.error} onRetry={index.reload} compact />
                : index.loading ? <Skeleton height={54} />
                : pages.length === 0 ? (
                    <Empty text={t('cms_site.analytics.heatmap.no_clicks', 'No clicks recorded yet. Recording starts once a visitor accepts your cookie banner.')} />
                ) : (
                    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <span style={labelStyle}>{t('cms_site.analytics.heatmap.page', 'Page')}</span>
                            <select value={urlPath} onChange={(e) => onSelectPath(e.target.value)} style={selectStyle}>
                                {pages.map(p => (
                                    <option key={p.urlPath} value={p.urlPath}>
                                        {t('cms_site.analytics.heatmap.page_option', '{path} — {n} clicks', { path: p.urlPath, n: fmt(p.count) })}
                                    </option>
                                ))}
                            </select>
                        </label>

                        {widthGroups.length > 1 && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                <span style={labelStyle}>{t('cms_site.analytics.heatmap.captured_at', 'Captured at')}</span>
                                <div style={{ display: 'flex', gap: 6 }}>
                                    {widthGroups.map(g => (
                                        <button key={g.width} onClick={() => onSelectWidth(g.width)}
                                            title={t('cms_site.analytics.heatmap.width_title', '{clicks} clicks at {width}px wide', { clicks: fmt(g.clicks), width: g.width })}
                                            style={chipStyle(activeWidth === g.width)}>
                                            {g.width}px · {Math.round(g.share)}%
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}

                        <div style={{ display: 'flex', gap: 18, marginLeft: 'auto' }}>
                            <Figure label={t('cms_site.analytics.heatmap.fig_clicks', 'Clicks')} value={fmt(clicks)} />
                            <Figure label={t('cms_site.analytics.heatmap.fig_sessions', 'Sessions')} value={fmt(sessions)} />
                            {views > 0 && <Figure label={t('cms_site.analytics.heatmap.fig_views', 'Views')} value={fmt(views)} />}
                        </div>

                        <a href={urlPath} target="_blank" rel="noreferrer" style={linkStyle}>
                            {t('cms_site.analytics.heatmap.open_live', 'Open live page')} <ExternalLink style={{ width: 11, height: 11 }} />
                        </a>
                    </div>
                )}
        </Card>
    );
}

/**
 * The page we draw on is TODAY's page. If it is a different height from the one
 * the clicks were recorded against it has been edited since, and positions
 * below the first screen cannot be trusted. Saying so is cheap; letting someone
 * redesign a block based on misplaced dots is not.
 */
function StaleNotice({ liveH, recordedH }) {
    const { t } = useTranslation();
    return (
        <div style={warnStyle}>
            <AlertTriangle style={{ width: 14, height: 14, flexShrink: 0, marginTop: 1 }} />
            <span>
                {rich(t('cms_site.analytics.heatmap.stale', 'This page is {live} tall today, but these clicks were recorded on a {recorded} page. It has been edited since — positions below the first screen may not line up with what visitors actually saw.'), {
                    live: <strong>{fmt(Math.round(liveH))}px</strong>,
                    recorded: <strong>{fmt(Math.round(recordedH))}px</strong>,
                })}
            </span>
        </div>
    );
}

/**
 * The part that turns pixels into a decision. Ranked by share of clicks, with
 * clicks-per-100-views alongside — a block near the bottom of the page gets
 * fewer clicks simply because fewer people reach it, so raw counts would always
 * flatter whatever sits at the top.
 */
function BlockRanking({ attribution, views, highlightId, onHighlight, ready }) {
    const { t } = useTranslation();
    const { rows, total } = attribution;
    return (
        <Card title={t('cms_site.analytics.heatmap.ranking', 'Where the clicks go')} icon={Flame} action={
            total ? <span style={{ fontSize: 11, color: 'var(--text-muted, #888)' }}>{t('cms_site.analytics.heatmap.clicks_count', '{n} clicks', { n: fmt(total) })}</span> : null
        }>
            {!ready ? <Skeleton height={200} />
                : rows.length === 0 ? <Empty text={t('cms_site.analytics.heatmap.no_attribution', 'No clicks to attribute yet.')} />
                : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
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
                                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
                                        <span style={{
                                            fontSize: 12, fontWeight: 600, overflow: 'hidden',
                                            textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                            color: isChrome ? 'var(--text-muted, #888)' : 'var(--text-primary, #fff)',
                                        }}>{blockLabel(r.type, t)}</span>
                                        <span style={{ fontSize: 12, fontWeight: 800, color: ACCENT, flexShrink: 0 }}>
                                            {Math.round(r.share)}%
                                        </span>
                                    </div>
                                    <ShareBar value={r.share} of={100} />
                                    <div style={{ fontSize: 11, color: 'var(--text-muted, #888)', marginTop: 4 }}>
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

/** Scroll reach at the depths people actually talk about. */
function ReachMilestones({ reach, blocks, pageHeight }) {
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
            <span style={{ fontSize: 11, color: 'var(--text-muted, #888)' }}>{t('cms_site.analytics.heatmap.sessions_count', '{n} sessions', { n: fmt(reach.totalSessions) })}</span>
        }>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {marks.map(m => (
                    <div key={m.depth}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
                            <span style={{ fontSize: 12, color: 'var(--text-primary, #fff)' }}>
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
            <p style={{ fontSize: 11, color: 'var(--text-muted, #777)', margin: '12px 0 0' }}>
                {t('cms_site.analytics.heatmap.reach_note', 'Share of recorded sessions that scrolled at least this far.')}
            </p>
        </Card>
    );
}

function ClickLegend() {
    const { t } = useTranslation();
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 11, color: 'var(--text-muted, #888)' }}>
            <span>{t('cms_site.analytics.heatmap.legend_fewer', 'fewer clicks')}</span>
            <span style={{
                display: 'inline-block', width: 120, height: 8, borderRadius: 4,
                background: 'linear-gradient(90deg, #14b8a6, #10b981, #f59e0b, #f97316, #ef4444)',
            }} />
            <span>{t('cms_site.analytics.heatmap.legend_more', 'more')}</span>
            <span style={{ marginLeft: 10 }}>{t('cms_site.analytics.heatmap.legend_hover', 'Hover the page to highlight a block.')}</span>
        </div>
    );
}

function ScrollLegend({ reach }) {
    const { t } = useTranslation();
    return (
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-muted, #888)' }}>
            {reach.totalSessions
                ? t('cms_site.analytics.heatmap.scroll_legend_n', 'Darker means fewer visitors got that far — out of {n} recorded sessions.', { n: fmt(reach.totalSessions) })
                : t('cms_site.analytics.heatmap.scroll_legend', 'Darker means fewer visitors got that far.')}
        </div>
    );
}

function RecordingOff({ site, settings, onOpenSettings }) {
    const { t } = useTranslation();
    return (
        <Card title={t('cms_site.analytics.heatmap.off_title', 'Heatmaps')} icon={Flame}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start' }}>
                <p style={{ fontSize: 13, color: 'var(--text-secondary, #ccc)', margin: 0 }}>
                    {site?.name
                        ? t('cms_site.analytics.heatmap.off_named', 'Heatmaps need session recording, which is off for “{name}”.', { name: site.name })
                        : t('cms_site.analytics.heatmap.off_site', 'Heatmaps need session recording, which is off for this site.')}
                </p>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, color: 'var(--text-muted, #888)' }}>
                    <ShieldAlert style={{ width: 14, height: 14, marginTop: 1, flexShrink: 0, color: '#f59e0b' }} />
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
                    <p style={{ fontSize: 11, color: 'var(--text-muted, #777)', margin: 0 }}>
                        {t('cms_site.analytics.heatmap.banner_needed', 'Your cookie banner must be enabled on the site for recording to ever start.')}
                    </p>
                )}
            </div>
        </Card>
    );
}

function Figure({ label, value }) {
    return (
        <div>
            <div style={labelStyle}>{label}</div>
            <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text-primary, #fff)' }}>{value}</div>
        </div>
    );
}

const labelStyle = {
    fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
    letterSpacing: '0.06em', color: 'var(--text-muted, #888)',
};
const selectStyle = {
    background: 'var(--bg-primary, #0f0f1a)', color: 'var(--text-primary, #fff)',
    border: '1px solid var(--border-default, rgba(255,255,255,0.12))',
    borderRadius: 8, padding: '7px 10px', fontSize: 12, minWidth: 240,
};
const linkStyle = {
    display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 700,
    color: ACCENT, textDecoration: 'none', border: `1px solid ${ACCENT}44`,
    borderRadius: 7, padding: '5px 10px',
};
const warnStyle = {
    display: 'flex', gap: 9, alignItems: 'flex-start', padding: '11px 14px',
    borderRadius: 10, background: 'rgba(245,158,11,0.08)',
    border: '1px solid rgba(245,158,11,0.25)', fontSize: 12, color: '#fcd34d',
};
const chipStyle = (active) => ({
    display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px',
    borderRadius: 7, cursor: 'pointer', fontSize: 11, fontWeight: 700,
    border: `1px solid ${active ? `${ACCENT}66` : 'var(--border-subtle, rgba(255,255,255,0.1))'}`,
    background: active ? `${ACCENT}14` : 'transparent',
    color: active ? ACCENT : 'var(--text-muted, #888)',
});
