/**
 * Overview — the front door.
 *
 * It answers one question: is the site doing better or worse than last period,
 * and what changed? The previous version was a shelf of disconnected numbers —
 * five tiles with no comparison, two near-identical single-series charts, and a
 * six-card grid half of which read "No X data" on any normal site.
 *
 * Three things changed the character of it:
 *   - `stats.comparison` (the previous period's absolute totals) was already
 *     being fetched and thrown away. Every headline number now carries it.
 *   - The series are densified against the requested window. Umami returns only
 *     non-empty buckets, which is why this chart used to be a flat line with
 *     "07-27 00:00" at both ends.
 *   - The six ranked lists collapse into one "what moved" table plus a
 *     composition strip, because six lists of five rows is not a summary.
 */
import { Users, Eye, MousePointerClick, Timer, Activity, TrendingUp, Layers } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { analyticsApi, analyticsFetch } from '../../analyticsApi';
import TrendChart from '../charts/TrendChart';
import {
    ACCENT, SERIES, Card, Empty, ErrorNote, Skeleton, SkeletonGrid, StatGrid, StatTile,
    BreakdownTable, SplitBar, fmt, statVal, fmtDurationSec, compare,
} from '../ui';
import { resolveWindow, densify, bucketLabel, lastBucketPartial } from '../window';

export default function OverviewSection({ scope, onDrill }) {
    const { t } = useTranslation();
    const [state, setState] = useState({ data: null, loading: true, error: null });

    // scope is a fresh object per render of the shell; its serialised content
    // is the identity, and the load reads the object back from that.
    const scopeKey = JSON.stringify(scope);
    const load = useCallback(async () => {
        setState(s => ({ ...s, loading: true, error: null }));
        try {
            const data = await analyticsFetch(analyticsApi.overview(JSON.parse(scopeKey)));
            setState({ data, loading: false, error: null });
        } catch (e) {
            setState({ data: null, loading: false, error: e.message });
        }
    }, [scopeKey]);

    useEffect(() => { load(); }, [load]);

    const { data: overview, loading, error } = state;
    const win = useMemo(() => resolveWindow(scope), [scope]);

    const chart = useMemo(() => {
        if (!overview?.pageviews) return null;
        const views = densify(overview.pageviews.pageviews, win);
        const sessions = densify(overview.pageviews.sessions, win);
        return {
            labels: views.map(p => bucketLabel(p.t, win.unit)),
            series: [
                { key: 'views', label: t('cms_site.analytics.overview.pageviews', 'Pageviews'), data: views.map(p => p.value), color: ACCENT },
                { key: 'sessions', label: t('cms_site.analytics.overview.sessions', 'Sessions'), data: sessions.map(p => p.value), color: SERIES.secondary, style: 'line' },
            ],
            partialLast: lastBucketPartial(win),
        };
    }, [overview, win, t]);

    if (loading && !overview) {
        return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <SkeletonGrid count={5} height={78} />
                <Skeleton height={240} />
                <SkeletonGrid count={2} height={200} min={320} />
            </div>
        );
    }
    if (error) return <ErrorNote message={error} onRetry={load} />;
    if (!overview?.stats) return <Empty text={t('cms_site.analytics.overview.empty', 'No analytics data for this period yet.')} />;

    const s = overview.stats || {};
    const cmp = s.comparison || {};
    const visits = statVal(s.visits) || statVal(s.sessions);
    const pageviews = statVal(s.pageviews);
    const visitors = statVal(s.visitors);
    const bounceRate = visits > 0 ? (statVal(s.bounces) / visits) * 100 : 0;
    const avgVisit = visits > 0 ? statVal(s.totaltime) / visits : 0;

    const prevVisits = statVal(cmp.visits);
    const prevBounce = prevVisits > 0 ? (statVal(cmp.bounces) / prevVisits) * 100 : null;
    const prevAvg = prevVisits > 0 ? statVal(cmp.totaltime) / prevVisits : null;

    const partial = overview.partialErrors || [];
    const failed = (key) => partial.find(e => e.key === key)?.message || null;

    const tile = (current, previous, kind) => {
        const c = compare(current, previous, kind, t);
        return { delta: c.delta, deltaDisplay: c.display, state: c.state };
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {partial.length > 0 && (
                <ErrorNote
                    onRetry={load}
                    message={t('cms_site.analytics.overview.partial', 'Some data could not be loaded: {keys}. {message}', { keys: partial.map(e => e.key).join(', '), message: partial[0].message })}
                />
            )}

            <StatGrid>
                <StatTile icon={Users} label={t('cms_site.analytics.overview.visitors', 'Visitors')} value={fmt(visitors)} color={SERIES.secondary}
                    {...tile(visitors, statVal(cmp.visitors), 'count')} />
                <StatTile icon={Eye} label={t('cms_site.analytics.overview.pageviews', 'Pageviews')} value={fmt(pageviews)} color={ACCENT}
                    {...tile(pageviews, statVal(cmp.pageviews), 'count')} />
                <StatTile icon={MousePointerClick} label={t('cms_site.analytics.overview.bounce', 'Bounce rate')} value={`${Math.round(bounceRate)}%`} color={SERIES.warn}
                    goodWhenDown {...tile(bounceRate, prevBounce, 'rate')} />
                <StatTile icon={Timer} label={t('cms_site.analytics.overview.avg_visit', 'Avg. visit')} value={fmtDurationSec(avgVisit)} color={SERIES.primary}
                    {...tile(avgVisit, prevAvg, 'duration')} />
                <StatTile icon={Activity} label={t('cms_site.analytics.overview.active_now', 'Active now')} value={overview.active != null ? fmt(overview.active) : '—'}
                    color={SERIES.secondary} subtitle={t('cms_site.analytics.overview.last_5', 'last 5 minutes')} />
            </StatGrid>

            <Card title={t('cms_site.analytics.overview.traffic', 'Traffic over time')} icon={TrendingUp}>
                {failed('pageviews')
                    ? <ErrorNote message={failed('pageviews')} onRetry={load} compact />
                    : chart
                        ? <TrendChart
                            labels={chart.labels} series={chart.series}
                            partialLast={chart.partialLast} height={220}
                            emptyText={t('cms_site.analytics.overview.no_traffic', 'No traffic in this period.')} />
                        : <Empty text={t('cms_site.analytics.overview.no_traffic', 'No traffic in this period.')} />}
            </Card>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
                <Card title={t('cms_site.analytics.overview.top_pages', 'Top pages')} action={
                    <DrillHint show={!!overview.pages?.length} />
                }>
                    {failed('pages')
                        ? <ErrorNote message={failed('pages')} onRetry={load} compact />
                        : <BreakdownTable rows={overview.pages} labelHeader={t('cms_site.analytics.overview.page', 'Page')} maxRows={8}
                            emptyText={t('cms_site.analytics.overview.no_pageviews', 'No pageviews in this period.')}
                            onDrill={(v) => onDrill('path', v)} />}
                </Card>

                <Card title={t('cms_site.analytics.overview.sources', 'Where they came from')} action={<DrillHint show={!!overview.referrers?.length} />}>
                    {failed('referrers')
                        ? <ErrorNote message={failed('referrers')} onRetry={load} compact />
                        : <BreakdownTable rows={overview.referrers} labelHeader={t('cms_site.analytics.overview.source', 'Source')} maxRows={8}
                            blankLabel={t('cms_site.analytics.overview.direct', 'Direct / no referrer')}
                            emptyText={t('cms_site.analytics.overview.all_direct', 'Everyone arrived directly — no referring sites in this period.')}
                            onDrill={(v) => onDrill('referrer', v)} />}
                </Card>
            </div>

            <Composition overview={overview} onDrill={onDrill} />
        </div>
    );
}

/**
 * Devices, browsers, OS and countries as four composition bars in ONE card.
 *
 * They were four cards (two of them donuts) showing the same handful of
 * numbers. A donut spends 160px of height to say "67% laptop", carries identity
 * in a colour-only legend, and cannot be scanned against its neighbours.
 */
function Composition({ overview, onDrill }) {
    const { t } = useTranslation();
    const strips = [
        { key: 'devices', label: t('cms_site.analytics.overview.devices', 'Devices'), dim: 'device', rows: overview.devices },
        { key: 'browsers', label: t('cms_site.analytics.overview.browsers', 'Browsers'), dim: 'browser', rows: overview.browsers },
        { key: 'os', label: t('cms_site.analytics.overview.oses', 'Operating systems'), dim: 'os', rows: overview.os },
        { key: 'countries', label: t('cms_site.analytics.overview.countries', 'Countries'), dim: 'country', rows: overview.countries },
    ].filter(s => Array.isArray(s.rows) && s.rows.length > 0);

    if (!strips.length) {
        return (
            <Card title={t('cms_site.analytics.overview.who', 'Who visited')} icon={Layers}>
                <Empty text={t('cms_site.analytics.overview.no_breakdown', 'No visitor breakdown for this period yet.')} />
            </Card>
        );
    }

    return (
        <Card title={t('cms_site.analytics.overview.who', 'Who visited')} icon={Layers}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {strips.map(s => {
                    const top = s.rows.slice(0, 5);
                    const rest = s.rows.slice(5).reduce((a, r) => a + (r.y || 0), 0);
                    const segments = [
                        ...top.map(r => ({ label: r.x || t('cms_site.analytics.common.unknown', 'Unknown'), value: r.y || 0 })),
                        ...(rest > 0 ? [{ label: t('cms_site.analytics.overview.other', 'Other'), value: rest, color: 'var(--border-default, rgba(255,255,255,0.2))' }] : []),
                    ];
                    return (
                        <div key={s.key}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted, #888)', marginBottom: 6 }}>
                                {s.label}
                            </div>
                            <SplitBar segments={segments} legend height={10} />
                            {onDrill && (
                                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                                    {top.filter(r => r.x).map(r => (
                                        <button key={r.x} onClick={() => onDrill(s.dim, r.x)}
                                            title={t('cms_site.analytics.overview.filter_by', 'Filter the dashboard by {value}', { value: r.x })}
                                            style={{
                                                fontSize: 10, padding: '2px 7px', borderRadius: 6, cursor: 'pointer',
                                                background: 'transparent', color: 'var(--text-muted, #888)',
                                                border: '1px solid var(--border-subtle, rgba(255,255,255,0.1))',
                                            }}>
                                            {t('cms_site.analytics.overview.filter_chip', 'filter: {value}', { value: r.x })}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </Card>
    );
}

function DrillHint({ show }) {
    const { t } = useTranslation();
    if (!show) return null;
    return (
        <span style={{ fontSize: 10, color: 'var(--text-muted, #777)' }}>{t('cms_site.analytics.overview.drill_hint', 'click a row to filter')}</span>
    );
}
