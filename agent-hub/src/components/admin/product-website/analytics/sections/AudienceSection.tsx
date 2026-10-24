/**
 * Audience — who visited, and what they were using.
 *
 * Was seven flat label/count tables, three of which (country/region/city) are
 * structurally empty on any Umami without a GeoLite2 database — presented as a
 * bare "No countries data", which reads as a bug rather than a missing optional
 * dependency.
 *
 * Now: geography is one drill-down table with an honest capability banner when
 * the database is absent; browser and OS are a single pivot, because "Chrome"
 * and "Windows" in two separate lists never answer "Chrome on what?"; and
 * screen widths — sitting unused in `sessions[].screen` all along — answer the
 * one question a CMS product genuinely needs: what widths must this design
 * survive?
 */
import { Globe, Monitor, Languages, MapPin } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { pivot, screenBuckets, screenLabel, type BreakdownRow, type PivotOut } from '../model';
import {
    ACCENT, Card, Empty, ErrorNote, Skeleton, ShareBar, BreakdownTable,
    fmt, maxOf,
} from '../ui';
import { useAnalyticsQuery } from '../useAnalyticsQuery';
import type { AnalyticsScope } from '../../analyticsApi';
import type { DrillHandler, XYRow } from '../ui.types';

const GEO_LEVELS = [
    { dim: 'country', labelKey: 'cms_site.analytics.audience.countries', label: 'Countries', next: 'region' },
    { dim: 'region', labelKey: 'cms_site.analytics.audience.regions', label: 'Regions', next: 'city' },
    { dim: 'city', labelKey: 'cms_site.analytics.audience.cities', label: 'Cities', next: null },
];

interface AudienceSectionProps {
    scope: AnalyticsScope;
    onDrill: DrillHandler;
}

export default function AudienceSection({ scope, onDrill }: AudienceSectionProps) {
    const { t } = useTranslation();
    const [level, setLevel] = useState('country');

    const geo = useAnalyticsQuery<XYRow[]>('query', 'metrics', scope, { params: { type: level, limit: 25 } });
    const stack = useAnalyticsQuery<BreakdownRow[]>('report', 'breakdown', scope, { body: { fields: ['browser', 'os'] } });
    const languages = useAnalyticsQuery('query', 'metrics', scope, { params: { type: 'language', limit: 12 } });
    const devices = useAnalyticsQuery('query', 'metrics', scope, { params: { type: 'device', limit: 10 } });
    const sessions = useAnalyticsQuery<{ data?: { screen?: string }[] }>('query', 'sessions', scope, { params: { pageSize: 500 } });

    const sessionRows = useMemo(
        () => (Array.isArray(sessions.payload?.data) ? sessions.payload.data : []),
        [sessions.payload],
    );
    // Did anyone visit at all in this window? Answered by the sessions query, not
    // the geo one — that distinction is the whole point below.
    const hasTraffic = !sessions.loading && !sessions.error && sessionRows.length > 0;

    const geoRows = Array.isArray(geo.payload) ? geo.payload : [];
    // "Umami could not place these visitors" and "nobody visited" are different
    // answers and must not share a message.
    //
    // Umami reports the first case two different ways depending on version and
    // query: sometimes rows with a null label, sometimes — as on 3.2.0 — by
    // dropping the null-geo rows entirely and returning []. The original check
    // only caught the first, so the second fell through to "No visits in this
    // period." and reported an empty dashboard while a session sat in the table.
    // Cross-checking against the session count catches both.
    const geoUnavailable = !geo.loading && !geo.error
        && ((geoRows.length > 0 && geoRows.every(r => !r.x))
            || (geoRows.length === 0 && hasTraffic));
    const geoEmpty = !geo.loading && !geo.error && geoRows.length === 0 && !geoUnavailable;

    const stackRows = useMemo(() => {
        const rows = pivot(stack.payload, ['browser', 'os'])
            .filter(r => r.browser || r.os)
            .sort((a, b) => b.visitors - a.visitors || b.views - a.views);
        return rows;
    }, [stack.payload]);

    const screens = useMemo(() => screenBuckets(sessionRows), [sessionRows]);

    return (
        <div className="[display:flex] [flex-direction:column] [gap:14px]">
            <div className="[display:grid] [grid-template-columns:repeat(auto-fit,minmax(320px,1fr))] [gap:12px]">
                <Card title={t('cms_site.analytics.audience.where', 'Where they are')} icon={Globe} action={
                    <div className="[display:flex] [gap:4px]">
                        {GEO_LEVELS.map(l => (
                            <button key={l.dim} onClick={() => setLevel(l.dim)} style={{
                                fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 6, cursor: 'pointer',
                                border: `1px solid ${level === l.dim ? `${ACCENT}66` : 'var(--border-subtle, rgba(255,255,255,0.1))'}`,
                                background: level === l.dim ? `${ACCENT}14` : 'transparent',
                                color: level === l.dim ? ACCENT : 'var(--text-muted, #888)',
                            }}>{t(l?.labelKey, l?.label)}</button>
                        ))}
                    </div>
                }>
                    {geo.loading ? <Skeleton height={200} />
                        : geo.error ? <ErrorNote message={geo.error} onRetry={geo.reload} compact />
                        : geoUnavailable ? <GeoUnavailable />
                        : geoEmpty ? <Empty text={t('cms_site.analytics.audience.no_visits', 'No visits in this period.')} />
                        : <BreakdownTable rows={geoRows} labelHeader={(() => { const l = GEO_LEVELS.find(g => g.dim === level); return t(l?.labelKey, l?.label); })()}
                            valueHeader={t('cms_site.analytics.common.views', 'Views')} maxRows={12} blankLabel={t('cms_site.analytics.audience.unknown_location', 'Unknown location')}
                            onDrill={(v) => onDrill(level, v)} />}
                </Card>

                <Card title={t('cms_site.analytics.audience.screens', 'Screen widths to design for')} icon={Monitor} action={
                    screens.total ? <span className="[font-size:10px] [color:var(--text-muted,#777)]">
                        {t('cms_site.analytics.audience.sessions_count', '{n} sessions', { n: fmt(screens.total) })}
                    </span> : null
                }>
                    {sessions.loading ? <Skeleton height={200} />
                        : sessions.error ? <ErrorNote message={sessions.error} onRetry={sessions.reload} compact />
                        : screens.rows.length === 0 ? <Empty text={t('cms_site.analytics.audience.no_sessions', 'No session data in this period.')} />
                        : (
                            <div className="[display:flex] [flex-direction:column] [gap:9px]">
                                {screens.rows.map(r => (
                                    <div key={r.label}>
                                        <div className="[display:flex] [justify-content:space-between] [gap:10px] [margin-bottom:3px]">
                                            <span className="[font-size:12px] [color:var(--text-primary,#fff)]">{screenLabel(r.label, t)}</span>
                                            <span style={{ fontSize: 12, fontWeight: 700, color: ACCENT }}>
                                                {Math.round(r.share)}%
                                                <span className="[color:var(--text-muted,#777)] [font-weight:500]"> · {fmt(r.count)}</span>
                                            </span>
                                        </div>
                                        <ShareBar value={r.share} of={100} />
                                    </div>
                                ))}
                            </div>
                        )}
                </Card>
            </div>

            <Card title={t('cms_site.analytics.audience.stack', 'Browser and operating system')} icon={Monitor} action={
                <span className="[font-size:10px] [color:var(--text-muted,#777)]">{t('cms_site.analytics.audience.stack_hint', 'the combination, not two lists')}</span>
            }>
                {stack.loading ? <Skeleton height={200} />
                    : stack.error ? <ErrorNote message={stack.error} onRetry={stack.reload} compact />
                    : stackRows.length === 0 ? <Empty text={t('cms_site.analytics.audience.no_visits', 'No visits in this period.')} />
                    : <StackTable rows={stackRows} onDrill={onDrill} />}
            </Card>

            <div className="[display:grid] [grid-template-columns:repeat(auto-fit,minmax(280px,1fr))] [gap:12px]">
                <Card title={t('cms_site.analytics.audience.devices', 'Devices')} icon={Monitor}>
                    {devices.loading ? <Skeleton height={150} />
                        : devices.error ? <ErrorNote message={devices.error} onRetry={devices.reload} compact />
                        : <BreakdownTable rows={devices.payload} labelHeader={t('cms_site.analytics.audience.device', 'Device')} maxRows={8}
                            emptyText={t('cms_site.analytics.audience.no_devices', 'No device data.')} onDrill={(v) => onDrill('device', v)} />}
                </Card>
                <Card title={t('cms_site.analytics.audience.languages', 'Languages')} icon={Languages} action={
                    <span className="[font-size:10px] [color:var(--text-muted,#777)]">{t('cms_site.analytics.audience.languages_hint', 'browser preference')}</span>
                }>
                    {languages.loading ? <Skeleton height={150} />
                        : languages.error ? <ErrorNote message={languages.error} onRetry={languages.reload} compact />
                        : <BreakdownTable rows={languages.payload} labelHeader={t('cms_site.analytics.audience.language', 'Language')} maxRows={8}
                            emptyText={t('cms_site.analytics.audience.no_languages', 'No language data.')} onDrill={(v) => onDrill('language', v)} />}
                </Card>
            </div>
        </div>
    );
}

interface StackTableProps {
    rows: StackRow[];
    onDrill: DrillHandler;
}

type StackRow = PivotOut;

function StackTable({ rows, onDrill }: StackTableProps) {
    const { t } = useTranslation();
    const peak = maxOf(rows.map(r => r.visitors || r.views));
    return (
        <div className="[display:flex] [flex-direction:column] [gap:8px]">
            {rows.slice(0, 12).map((r, i) => (
                <div key={`${i}-${r.browser}-${r.os}`}>
                    <div className="[display:flex] [justify-content:space-between] [gap:10px] [margin-bottom:3px]">
                        <span className="[font-size:12px] [display:flex] [gap:6px] [align-items:baseline]">
                            <button onClick={() => r.browser && onDrill('browser', r.browser)}
                                title={r.browser ? t('cms_site.analytics.common.filter_by', 'Filter by {value}', { value: r.browser }) : undefined}
                                style={chipButton(!!r.browser)}>{r.browser || t('cms_site.analytics.audience.unknown_browser', 'Unknown browser')}</button>
                            <span className="[color:var(--text-muted,#666)]">{t('cms_site.analytics.audience.on', 'on')}</span>
                            <button onClick={() => r.os && onDrill('os', r.os)}
                                title={r.os ? t('cms_site.analytics.common.filter_by', 'Filter by {value}', { value: r.os }) : undefined}
                                style={chipButton(!!r.os)}>{r.os || t('cms_site.analytics.audience.unknown_os', 'Unknown OS')}</button>
                        </span>
                        <span className="[display:flex] [gap:12px] [flex-shrink:0] [align-items:baseline]">
                            <span className="[font-size:11px] [color:var(--text-muted,#888)]">{t('cms_site.analytics.audience.views_count', '{n} views', { n: fmt(r.views) })}</span>
                            <span style={{ fontSize: 12, fontWeight: 700, color: ACCENT }}>{fmt(r.visitors)}</span>
                        </span>
                    </div>
                    <ShareBar value={r.visitors || r.views} of={peak} />
                </div>
            ))}
        </div>
    );
}

const chipButton = (clickable: boolean) => ({
    background: 'transparent', border: 'none', padding: 0, fontSize: 12,
    color: 'var(--text-primary, #fff)', cursor: clickable ? 'pointer' : 'default',
    textDecoration: clickable ? 'underline dotted' : 'none', textUnderlineOffset: 3,
});

/**
 * Capability-missing, not error and not empty.
 *
 * Reached when visits exist but none of them carry a location. Two causes, and
 * the message names the likelier one first:
 *
 *  1. The visitor's IP never reached Umami. Behind an L4 load balancer that
 *     re-originates the connection (Scaleway's, in the hosted deployment), the
 *     proxy's own private address is what arrives, so the lookup resolves
 *     nothing and the country is stored as NULL. Fixed at the ingress by
 *     carrying the source through — see deploy/scaleway-kapsule/bootstrap.sh.
 *  2. No GeoLite2 database (self-hosted installs that strip it from the image;
 *     the official Umami image ships one at /app/geo/GeoLite2-City.mmdb).
 *
 * Either way this is a deployment gap, not a broken dashboard — say so rather
 * than claiming nobody visited.
 */
function GeoUnavailable() {
    const { t } = useTranslation();
    return (
        <div className="[display:flex] [gap:9px] [align-items:flex-start] [padding:12px_14px] [border-radius:10px] [background:rgba(245,158,11,0.08)] [border:1px_solid_rgba(245,158,11,0.25)] [font-size:12px] [color:#fcd34d]">
            <MapPin className="w-[14px] h-[14px] [margin-top:1px] [flex-shrink:0]" />
            <span>
                <strong>{t('cms_site.analytics.audience.geo_title', 'Visits recorded, but no location data.')}</strong>{' '}
                {t('cms_site.analytics.audience.geo_body', "Usually the visitor's IP address is not reaching the analytics service — behind a load balancer it is the balancer's own address that arrives, which resolves to nowhere. Everything else on this page is unaffected.")}
            </span>
        </div>
    );
}
