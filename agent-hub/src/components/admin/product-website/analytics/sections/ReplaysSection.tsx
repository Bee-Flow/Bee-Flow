/**
 * Sessions — who visited, what they did, and which visit is worth watching.
 *
 * Three things were wrong with the old "Replays" tab. It hid behind the
 * recorder toggle and fetched nothing when recording was off — even though the
 * `sessions` resource needs no recorder at all, so switching recording off hid
 * data that was still being collected. It was a chronological dump, which
 * cannot answer "which of these is worth fourteen minutes of my time". And its
 * one headline number was wrong by three orders of magnitude: Umami reports
 * `duration` in milliseconds and it was formatted as seconds, so an 11.8-second
 * recording printed as "196m 21s".
 *
 * Playback still opens Umami's own player in a new tab. Rendering rrweb here
 * would mean a new dependency and re-implementing a video player; that is
 * deliberately deferred, and the UI says so rather than pretending.
 */
import { Video, ShieldAlert, ExternalLink, Monitor, Globe, Play, Users } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { sessionSignals } from '../model';
import { rich } from '../rich';
import {
    ACCENT, SERIES, Card, Empty, ErrorNote, Skeleton, StatGrid, StatTile,
    fmt, fmtDurationMs, fmtAgo,
} from '../ui';
import { useAnalyticsQuery } from '../useAnalyticsQuery';
import type { AnalyticsScope, AnalyticsSite } from '../../analyticsApi';
import type { DrillHandler } from '../ui.types';

/** A visit as `/query/sessions` returns it. */
type SessionRecord = {
    id: string; firstAt: string; lastAt: string; views: number; visits?: number; events?: number | string;
    browser?: string; os?: string; device?: string; screen?: string; country?: string;
};

/** A recording chunk as `/query/replays` returns it. */
type ReplayRecord = { id: string; sessionId: string; startedAt: string; endedAt: string };

/** A visit joined to its longest recording, with the signals that rank it. */
type SessionListRow = {
    session: SessionRecord;
    replay: ReplayRecord | null;
    reasons: string[];
    duration: number;
    views: number;
    events: number;
};

const FILTERS = [
    { id: 'all', labelKey: 'cms_site.analytics.replays.filter_all', label: 'All' },
    { id: 'engaged', labelKey: 'cms_site.analytics.replays.filter_engaged', label: 'Engaged' },
    { id: 'recorded', labelKey: 'cms_site.analytics.replays.filter_recorded', label: 'Recorded' },
    { id: 'bounced', labelKey: 'cms_site.analytics.replays.filter_bounced', label: 'Bounced' },
];

interface ReplaysSectionProps {
    scope: AnalyticsScope;
    site: AnalyticsSite | null;
    settings?: { url?: string | null } | null;
    onOpenSettings: React.MouseEventHandler<HTMLButtonElement>;
    onDrill: DrillHandler;
}

export default function ReplaysSection({ scope, site, settings, onOpenSettings, onDrill }: ReplaysSectionProps) {
    const { t } = useTranslation();
    const [filter, setFilter] = useState('all');
    const recording = !!site?.recording;

    // Sessions need no recorder — fetch them regardless of the toggle.
    const sessions = useAnalyticsQuery<{ data?: SessionRecord[] }>('query', 'sessions', scope, { params: { pageSize: 200 } });
    const replays = useAnalyticsQuery<{ data?: ReplayRecord[] }>('query', 'replays', scope, {
        params: { pageSize: 200 }, enabled: recording,
    });

    const rows = useMemo(() => {
        const list = Array.isArray(sessions.payload?.data) ? sessions.payload.data : [];
        const replayList = Array.isArray(replays.payload?.data) ? replays.payload.data : [];
        const bySession = new Map<string, ReplayRecord & { _span: number }>();
        for (const r of replayList) {
            // Keep the longest recording per session — a session can produce
            // several chunks and only one is worth linking to.
            const cur = bySession.get(r.sessionId);
            const span = Date.parse(r.endedAt) - Date.parse(r.startedAt);
            if (!cur || span > cur._span) bySession.set(r.sessionId, { ...r, _span: span });
        }
        return list
            .map(s => {
                const replay = bySession.get(s.id) || null;
                return { session: s, replay, ...sessionSignals(s, { events: Number(s.events) || 0, replay, t }) };
            })
            .sort((a: { score: number; session: { lastAt: string; }; }, b: { score: number; session: { lastAt: string; }; }) => b.score - a.score || Date.parse(b.session.lastAt) - Date.parse(a.session.lastAt));
    }, [sessions.payload, replays.payload, t]);

    const shown = useMemo(() => rows.filter(r => {
        if (filter === 'engaged') return r.events > 0 || r.views >= 4;
        if (filter === 'recorded') return r.hasReplay;
        if (filter === 'bounced') return r.views === 1 && r.duration < 10_000;
        return true;
    }), [rows, filter]);

    const totals = useMemo(() => ({
        sessions: rows.length,
        recorded: rows.filter(r => r.hasReplay).length,
        engaged: rows.filter(r => r.events > 0).length,
        avg: rows.length ? rows.reduce((a, r) => a + r.duration, 0) / rows.length : 0,
    }), [rows]);

    if (sessions.loading) {
        return <div className="[display:flex] [flex-direction:column] [gap:14px]"><Skeleton height={100} /><Skeleton height={320} /></div>;
    }
    if (sessions.error) return <ErrorNote message={sessions.error} onRetry={sessions.reload} />;

    const base = (settings?.url || '').replace(/\/+$/, '');
    const websiteId = site?.websiteId;

    return (
        <div className="[display:flex] [flex-direction:column] [gap:14px]">
            <RecordingStrip recording={recording} totals={totals} site={site} onOpenSettings={onOpenSettings} />

            <StatGrid>
                <StatTile icon={Users} label={t('cms_site.analytics.replays.sessions', 'Sessions')} value={fmt(totals.sessions)} color={ACCENT} />
                <StatTile icon={Monitor} label={t('cms_site.analytics.replays.avg_length', 'Avg. length')} value={fmtDurationMs(totals.avg)} color={SERIES.secondary} />
                <StatTile icon={Play} label={t('cms_site.analytics.replays.interacted', 'Interacted')} value={fmt(totals.engaged)} color={SERIES.primary}
                    subtitle={t('cms_site.analytics.replays.interacted_hint', 'clicked or submitted something')} />
                <StatTile icon={Video} label={t('cms_site.analytics.replays.recorded', 'Recorded')} value={fmt(totals.recorded)} color={SERIES.warn}
                    subtitle={totals.sessions ? t('cms_site.analytics.replays.recorded_pct', '{pct}% of sessions', { pct: Math.round((totals.recorded / totals.sessions) * 100) }) : undefined} />
            </StatGrid>

            <Card title={t('cms_site.analytics.replays.visits', 'Visits')} icon={Users} action={
                <div className="[display:flex] [gap:4px]">
                    {FILTERS.map(f => (
                        <button key={f.id} onClick={() => setFilter(f.id)} style={{
                            fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 6, cursor: 'pointer',
                            border: `1px solid ${filter === f.id ? `${ACCENT}66` : 'var(--border-subtle, rgba(255,255,255,0.1))'}`,
                            background: filter === f.id ? `${ACCENT}14` : 'transparent',
                            color: filter === f.id ? ACCENT : 'var(--text-muted, #888)',
                        }}>{t(f.labelKey, f.label)}</button>
                    ))}
                </div>
            }>
                {shown.length === 0 ? (
                    <Empty text={filter === 'all'
                        ? t('cms_site.analytics.replays.no_sessions', 'No sessions in this period.')
                        : t('cms_site.analytics.replays.no_match', 'No sessions match that filter in this period.')} />
                ) : (
                    <div className="[display:flex] [flex-direction:column] [gap:5px] max-h-[560px] [overflow-y:auto]">
                        {shown.slice(0, 100).map(r => (
                            <SessionRow key={r.session.id} row={r} base={base} websiteId={websiteId} onDrill={onDrill} />
                        ))}
                    </div>
                )}
                {shown.length > 100 && (
                    <p className="[font-size:11px] [color:var(--text-muted,#777)] [margin:10px_0_0]">
                        {t('cms_site.analytics.replays.showing', 'Showing the 100 most notable of {n} — narrow the date range to see the rest.', { n: fmt(shown.length) })}
                    </p>
                )}
            </Card>

            {recording && (
                <p className="[font-size:11px] [color:var(--text-muted,#777)] [margin:0]">
                    {t('cms_site.analytics.replays.playback', 'Playback opens in Umami — the player itself is not embedded here.')}
                </p>
            )}
        </div>
    );
}

function SessionRow({ row, base, websiteId, onDrill }: { row: SessionListRow; base: string; websiteId?: string | null; onDrill: DrillHandler }) {
    const { t } = useTranslation();
    const { session: s, replay, reasons, duration, views, events } = row;
    const href = replay && base && websiteId
        ? `${base}/websites/${websiteId}/replays/${replay.id}`
        : null;

    return (
        <div style={{
            display: 'flex', alignItems: 'center', gap: 12, padding: '9px 11px', borderRadius: 9,
            background: 'var(--bg-tertiary, rgba(255,255,255,0.03))',
            borderLeft: `2px solid ${events > 0 ? ACCENT : 'transparent'}`,
        }}>
            <div className="[flex:1] min-w-[0]">
                <div className="[display:flex] [gap:8px] [align-items:baseline] [flex-wrap:wrap]">
                    <span className="[font-size:12px] [color:var(--text-primary,#fff)]">
                        {fmtAgo(s.lastAt, undefined, t)}
                    </span>
                    {reasons.map(rs => (
                        <span key={rs} className="[font-size:10px] [padding:1px_6px] [border-radius:5px] [background:var(--bg-secondary,rgba(255,255,255,0.05))] [color:var(--text-muted,#999)]">{rs}</span>
                    ))}
                </div>
                <div className="[font-size:11px] [color:var(--text-muted,#888)] [display:flex] [gap:10px] [flex-wrap:wrap] [margin-top:2px]">
                    <span className="[display:inline-flex] [align-items:center] [gap:4px]">
                        <Monitor className="w-[11px] h-[11px]" />
                        {[s.browser, s.os, s.device].filter(Boolean).join(' · ') || t('cms_site.analytics.replays.unknown_device', 'unknown device')}
                        {s.screen ? ` · ${s.screen}` : ''}
                    </span>
                    {s.country && (
                        <button onClick={() => onDrill?.('country', s.country)}
                            className="[display:inline-flex] [align-items:center] [gap:4px] [background:transparent] [border:none] [padding:0] [cursor:pointer] [font-size:11px] [color:var(--text-muted,#888)]">
                            <Globe className="w-[11px] h-[11px]" />{s.country}
                        </button>
                    )}
                    <span>
                        {fmtDurationMs(duration)} · {views === 1 ? t('cms_site.analytics.replays.page_one', '{n} page', { n: fmt(views) }) : t('cms_site.analytics.replays.page_many', '{n} pages', { n: fmt(views) })}
                        {events > 0 ? ` · ${events === 1 ? t('cms_site.analytics.replays.interaction_one', '{n} interaction', { n: fmt(events) }) : t('cms_site.analytics.replays.interaction_many', '{n} interactions', { n: fmt(events) })}` : ''}
                    </span>
                </div>
            </div>
            {href ? (
                <a href={href} target="_blank" rel="noreferrer" style={{
                    display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0,
                    fontSize: 11, fontWeight: 700, color: ACCENT, textDecoration: 'none',
                    border: `1px solid ${ACCENT}44`, borderRadius: 7, padding: '4px 9px',
                }}>
                    {t('cms_site.analytics.replays.play', 'Play')} <ExternalLink className="w-[11px] h-[11px]" />
                </a>
            ) : (
                <span className="[font-size:10px] [color:var(--text-muted,#666)] [flex-shrink:0]">{t('cms_site.analytics.replays.not_recorded', 'not recorded')}</span>
            )}
        </div>
    );
}

/**
 * "Why do I have 200 sessions but only 12 recordings?" — the first question
 * this tab has to answer, before anything else on it makes sense.
 */
interface RecordingStripProps {
    recording: boolean;
    totals: { sessions: number; recorded: number; engaged: number; avg: number };
    site: AnalyticsSite | null;
    onOpenSettings: React.MouseEventHandler<HTMLButtonElement>;
}

function RecordingStrip({ recording, totals, site, onOpenSettings }: RecordingStripProps) {
    const { t } = useTranslation();
    if (!recording) {
        return (
            <div className="[display:flex] [gap:10px] [align-items:flex-start] [padding:12px_15px] [border-radius:10px] [background:rgba(245,158,11,0.08)] [border:1px_solid_rgba(245,158,11,0.25)] [font-size:12px] [color:#fcd34d]">
                <ShieldAlert className="w-[14px] h-[14px] [margin-top:1px] [flex-shrink:0]" />
                <span className="[flex:1]">
                    <strong>{site?.name
                        ? t('cms_site.analytics.replays.off_named', 'Session recording is off for “{name}”.', { name: site.name })
                        : t('cms_site.analytics.replays.off_site', 'Session recording is off for this site.')}</strong>{' '}
                    {t('cms_site.analytics.replays.off_body', 'Every visit below is still being counted — recording only adds replay and heatmaps on top. It captures clicks, scrolling and page structure, so it runs only for visitors who accepted your cookie banner, in every consent mode, and form inputs are masked.')}
                </span>
                <button onClick={onOpenSettings} className="[flex-shrink:0] [padding:6px_12px] [border-radius:8px] [background:#f59e0b] [color:#2a1a00] [border:none] [font-size:11px] [font-weight:800] [cursor:pointer]">{t('cms_site.analytics.replays.turn_on', 'Turn it on')}</button>
            </div>
        );
    }

    const pct = totals.sessions ? Math.round((totals.recorded / totals.sessions) * 100) : 0;
    return (
        <div className="[display:flex] [gap:10px] [align-items:center] [padding:9px_14px] [border-radius:10px] [background:var(--bg-secondary,#1a1a2e)] [border:1px_solid_var(--border-subtle,rgba(255,255,255,0.08))] [font-size:12px] [color:var(--text-secondary,#aaa)]">
            <span style={{ width: 7, height: 7, borderRadius: 99, background: ACCENT, flexShrink: 0 }} />
            <span className="[flex:1]">
                {rich(t('cms_site.analytics.replays.on_status', 'Recording on, inputs masked · {count} sessions recorded ({pct}%). The rest declined the cookie banner — that is expected, not a fault.'), {
                    count: <strong className="[color:var(--text-primary,#fff)]">
                        {t('cms_site.analytics.replays.on_count', '{recorded} of {total}', { recorded: fmt(totals.recorded), total: fmt(totals.sessions) })}
                    </strong>,
                    pct,
                })}
            </span>
            <button onClick={onOpenSettings} style={{
                background: 'transparent', border: 'none', color: ACCENT,
                fontSize: 11, fontWeight: 700, cursor: 'pointer', flexShrink: 0,
            }}>{t('cms_site.analytics.replays.settings_link', 'Recording settings →')}</button>
        </div>
    );
}
