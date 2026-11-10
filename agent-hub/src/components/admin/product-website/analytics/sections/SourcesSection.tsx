/**
 * Sources — how people found the site.
 *
 * This was the worst screen in the product: six cards, all empty, plus a
 * footnote apologising for them. Five of the six were UTM dimensions, and a
 * self-hosted marketing site's links are mostly untagged, so "empty" is the
 * NORMAL state, not the exception.
 *
 * So it is designed for sparse first. The channel mix is computed from the
 * referrers we do have and always says something. The five UTM dimensions come
 * from ONE `/report/utm` call instead of five `/metrics` requests, and collapse
 * into a single card that stays quiet when there is nothing to report. And the
 * empty state offers the thing that would fix it — a tagged link — rather than
 * explaining why the box is grey.
 */
import { Share2, Link2, Copy, Check } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { toChannels, channelLabel, referrerHost, pivot, type BreakdownRow, type PivotOut } from '../model';
import { rich } from '../rich';
import { SERIES, Empty, SplitBar, fmt, fmtDurationSec, rateClass } from '../ui';
import { Card, ErrorNote, Skeleton } from '../AsyncCard';
import { ACCENT, ShareBar, maxOf } from '../BarList';
import { useAnalyticsQuery } from '../useAnalyticsQuery';
import type { AnalyticsScope } from '../../analyticsApi';
import type { DrillHandler, XYRow } from '../ui.types';
import { logger } from '@/utils/logger';
import { PRIMARY_BTN } from '@/components/mcpLibrary/ui';
import { CHART_SERIES } from '@/components/shared/charts/chartChrome';

/** One UTM dimension's rows: the value under `x`, its count under `y` (or `count`). */
type UtmRow = { x?: string | null; y?: number; count?: number; name?: string; value?: string };
type UtmPayload = Record<string, UtmRow[]>;

interface SourcesSectionProps {
    scope: AnalyticsScope;
    onDrill: DrillHandler;
}

export default function SourcesSection({ scope, onDrill }: SourcesSectionProps) {
    const { t } = useTranslation();
    const referrers = useAnalyticsQuery<XYRow[]>('query', 'metrics', scope, { params: { type: 'referrer', limit: 50 } });
    const stats = useAnalyticsQuery<{ visits?: number }>('query', 'stats', scope);
    const utm = useAnalyticsQuery<UtmPayload>('report', 'utm', scope);
    const quality = useAnalyticsQuery<BreakdownRow[]>('report', 'breakdown', scope, { body: { fields: ['referrer'] } });

    const rows = useMemo(() => (Array.isArray(referrers.payload) ? referrers.payload : []), [referrers.payload]);

    // Everything that arrived without a referrer is direct traffic. Deriving it
    // from the totals is the only way to show it — Umami reports it as a blank
    // referrer row, which the old bar list rendered as "(none)".
    const channels = useMemo(() => {
        const referred = rows.filter(r => r.x).reduce((a, r) => a + (r.y || 0), 0);
        const blank = rows.filter(r => !r.x).reduce((a, r) => a + (r.y || 0), 0);
        const totalVisits = Number(stats.payload?.visits) || 0;
        const direct = Math.max(blank, totalVisits - referred);
        return toChannels(rows.filter(r => r.x), { direct });
    }, [rows, stats.payload]);

    const enriched = useMemo(() => {
        const byRef = new Map<string | null | undefined, PivotOut>();
        for (const r of pivot(quality.payload, ['referrer'])) {
            if (r.referrer) byRef.set(r.referrer, r);
        }
        return rows.filter(r => r.x).map(r => ({
            referrer: r.x,
            host: referrerHost(r.x),
            views: r.y || 0,
            ...(byRef.get(r.x) || {}),
        })).sort((a, b) => b.views - a.views);
    }, [rows, quality.payload]);

    if (referrers.loading && stats.loading) {
        return <div className="flex flex-col gap-3.5"><Skeleton height={140} /><Skeleton height={260} /></div>;
    }
    if (referrers.error) return <ErrorNote message={referrers.error} onRetry={referrers.reload} />;

    const peak = maxOf(enriched.map(r => r.views));

    return (
        <div className="flex flex-col gap-3.5">
            <Card title={t('cms_site.analytics.sources.channel_mix', 'Channel mix')} icon={Share2}>
                {channels.length === 0 ? (
                    <Empty text={t('cms_site.analytics.sources.no_visits', 'No visits in this period.')} />
                ) : (
                    <>
                        <SplitBar
                            segments={channels.map((c, i) => ({
                                label: channelLabel(c.label, t), value: c.value, color: CHANNEL_COLORS[c.label] || SERIES.secondary,
                            }))}
                            legend height={12}
                        />
                        <p className="text-xs text-[var(--text-secondary)] mt-3 mx-0 mb-0">
                            {channels[0].share >= 80
                                ? <>{rich(t('cms_site.analytics.sources.almost_all', 'Almost everything is {channel} traffic ({pct}%). Tag the links you share to see more here.'), {
                                    channel: <strong>{channelLabel(channels[0].label, t).toLowerCase()}</strong>,
                                    pct: Math.round(channels[0].share),
                                })}</>
                                : <>{rich(channels[1]
                                    ? t('cms_site.analytics.sources.biggest_then', '{channel} is your biggest channel at {pct}%, followed by {second} at {pct2}%.')
                                    : t('cms_site.analytics.sources.biggest_alone', '{channel} is your biggest channel at {pct}%, followed by nothing else.'), {
                                    channel: <strong>{channelLabel(channels[0].label, t)}</strong>,
                                    pct: Math.round(channels[0].share),
                                    second: channels[1] ? channelLabel(channels[1].label, t).toLowerCase() : '',
                                    pct2: channels[1] ? Math.round(channels[1].share) : '',
                                })}</>}
                        </p>
                    </>
                )}
            </Card>

            <Card title={t('cms_site.analytics.sources.referring', 'Referring sites')} icon={Share2} action={
                enriched.length ? <span className="text-[10px] text-[var(--text-tertiary)]">{t('cms_site.analytics.sources.click_filter', 'click to filter')}</span> : null
            }>
                {enriched.length === 0 ? (
                    <Empty text={t('cms_site.analytics.sources.no_referrers', 'Nobody arrived from another site in this period — all traffic was direct or untracked.')} />
                ) : (
                    <div className="flex flex-col gap-[9px]">
                        {enriched.slice(0, 15).map((r, i) => (
                            <button key={`${i}-${r.referrer}`} onClick={() => onDrill('referrer', r.referrer)}
                                className="block w-[100%] text-left p-0 bg-transparent border-0 cursor-pointer">
                                <div className="flex justify-between gap-2.5 mb-[3px]">
                                    <span className="text-xs text-[var(--text-primary)] overflow-hidden text-ellipsis whitespace-nowrap">{r.host}</span>
                                    <span className="flex gap-3 shrink-0 items-baseline">
                                        {r.bounceRate != null && (
                                            <span className={`text-[11px] ${rateClass(r.bounceRate)}`}>
                                                {t('cms_site.analytics.sources.bounce_pct', '{pct}% bounce', { pct: Math.round(r.bounceRate) })}
                                            </span>
                                        )}
                                        {r.avgTime != null && (
                                            <span className="text-[11px] text-[var(--text-tertiary)]">
                                                {fmtDurationSec(r.avgTime)}
                                            </span>
                                        )}
                                        <span className="text-xs font-semibold tabular-nums text-[var(--text-primary)]">{fmt(r.views)}</span>
                                    </span>
                                </div>
                                <ShareBar value={r.views} of={peak} />
                            </button>
                        ))}
                    </div>
                )}
            </Card>

            <CampaignCard utm={utm} onDrill={onDrill} />
        </div>
    );
}

const CHANNEL_COLORS: Record<string, string> = {
    Direct: 'var(--text-tertiary)',
    Search: SERIES.primary,
    Referral: SERIES.secondary,
    Social: CHART_SERIES[6],
    Email: SERIES.warn,
    'AI assistants': CHART_SERIES[1],
    Campaign: CHART_SERIES[4],
    Paid: SERIES.bad,
};

const UTM_FIELDS = [
    { key: 'utm_source', labelKey: 'cms_site.analytics.sources.utm_source', label: 'Source', dim: 'utmSource' },
    { key: 'utm_medium', labelKey: 'cms_site.analytics.sources.utm_medium', label: 'Medium', dim: 'utmMedium' },
    { key: 'utm_campaign', labelKey: 'cms_site.analytics.sources.utm_campaign', label: 'Campaign', dim: 'utmCampaign' },
    { key: 'utm_content', labelKey: 'cms_site.analytics.sources.utm_content', label: 'Content', dim: 'utmContent' },
    { key: 'utm_term', labelKey: 'cms_site.analytics.sources.utm_term', label: 'Term', dim: 'utmTerm' },
];

/**
 * All five UTM dimensions in one card, from one request.
 *
 * When they are all empty — the normal case — it becomes a link builder rather
 * than five grey boxes, because the only way to make this card useful is to go
 * and tag a link.
 */
function CampaignCard({ utm, onDrill }: { utm: { payload: UtmPayload | null; loading: boolean }; onDrill: DrillHandler }) {
    const { t } = useTranslation();
    const data: UtmPayload = utm.payload || {};
    const present = UTM_FIELDS
        .map(f => ({ ...f, rows: Array.isArray(data[f.key]) ? data[f.key] : [] }))
        .filter(f => f.rows.length > 0);

    if (utm.loading) return <Card title={t('cms_site.analytics.sources.campaigns', 'Campaigns')} icon={Link2}><Skeleton height={140} /></Card>;

    if (!present.length) {
        return (
            <Card title={t('cms_site.analytics.sources.campaigns', 'Campaigns')} icon={Link2}>
                <p className="text-[13px] text-[var(--text-secondary)] mt-0 mx-0 mb-1">
                    {t('cms_site.analytics.sources.no_tagged', 'No tagged links were visited in this period.')}
                </p>
                <p className="text-xs text-[var(--text-tertiary)] mt-0 mx-0 mb-3.5">
                    {rich(t('cms_site.analytics.sources.no_tagged_hint', 'Campaign data only appears when you share a link carrying {code}. Build one here and every visit through it shows up in this card.'), { code: <code>?utm_source=…</code> })}
                </p>
                <UtmBuilder />
            </Card>
        );
    }

    return (
        <Card title={t('cms_site.analytics.sources.campaigns', 'Campaigns')} icon={Link2}>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">
                {present.map(f => {
                    const peak = maxOf(f.rows.map(r => Number(r.y ?? r.count) || 0));
                    return (
                        <div key={f.key}>
                            <div className="text-[11px] font-semibold text-[var(--text-tertiary)] mb-[7px]">
                                {t(f.labelKey, f.label)}
                            </div>
                            <div className="flex flex-col gap-[7px]">
                                {f.rows.slice(0, 6).map((r: UtmRow, i: number) => {
                                    const label = r.x ?? r.name ?? r.value;
                                    const value = Number(r.y ?? r.count) || 0;
                                    return (
                                        <button key={`${i}-${label}`} onClick={() => label && onDrill(f.dim, label)}
                                            className="block w-[100%] text-left p-0 bg-transparent border-0 cursor-pointer">
                                            <div className="flex justify-between gap-2 mb-0.5">
                                                <span className="text-xs text-[var(--text-primary)] overflow-hidden text-ellipsis whitespace-nowrap">{label}</span>
                                                <span className="text-xs font-semibold tabular-nums text-[var(--text-primary)]">{fmt(value)}</span>
                                            </div>
                                            <ShareBar value={value} of={peak} />
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    );
                })}
            </div>
            <div className="mt-4.5 pt-3.5 border-t border-[var(--border-default)]">
                <UtmBuilder />
            </div>
        </Card>
    );
}

/** Builds a tagged URL. Purely client-side; nothing is stored. */
function UtmBuilder() {
    const { t } = useTranslation();
    const [url, setUrl] = useState('');
    const [source, setSource] = useState('');
    const [medium, setMedium] = useState('');
    const [campaign, setCampaign] = useState('');
    const [copied, setCopied] = useState(false);

    const built = useMemo(() => {
        if (!url.trim()) return '';
        try {
            const u = new URL(url.includes('://') ? url : `https://${url}`);
            if (source.trim()) u.searchParams.set('utm_source', source.trim());
            if (medium.trim()) u.searchParams.set('utm_medium', medium.trim());
            if (campaign.trim()) u.searchParams.set('utm_campaign', campaign.trim());
            return u.toString();
        } catch { return ''; }
    }, [url, source, medium, campaign]);

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(built);
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
        } catch (err) { logger.debug('clipboard blocked — the field is selectable anyway', err); }
    };

    return (
        <div>
            <div className="text-[11px] font-semibold text-[var(--text-tertiary)] mb-2">
                {t('cms_site.analytics.sources.build_link', 'Build a tagged link')}
            </div>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2">
                <Field value={url} onChange={setUrl} placeholder="https://your.site/pricing" label={t('cms_site.analytics.sources.destination', 'Destination')} />
                <Field value={source} onChange={setSource} placeholder={t('cms_site.analytics.sources.ph_source', 'newsletter')} label={t('cms_site.analytics.sources.utm_source', 'Source')} />
                <Field value={medium} onChange={setMedium} placeholder={t('cms_site.analytics.sources.ph_medium', 'email')} label={t('cms_site.analytics.sources.utm_medium', 'Medium')} />
                <Field value={campaign} onChange={setCampaign} placeholder={t('cms_site.analytics.sources.ph_campaign', 'launch-july')} label={t('cms_site.analytics.sources.utm_campaign', 'Campaign')} />
            </div>
            {built && (
                <div className="flex gap-2 mt-2.5 items-center">
                    <input readOnly value={built} onFocus={(e) => e.target.select()} className="flex-1 font-mono text-[11px] bg-[var(--bg-primary)] text-[var(--text-primary)] border border-[var(--border-default)] rounded-lg py-[7px] px-2.5" />
                    <button type="button" onClick={copy} className={PRIMARY_BTN}>
                        {copied ? <Check className="w-[12px] h-[12px]" /> : <Copy className="w-[12px] h-[12px]" />}
                        {copied ? t('cms_site.analytics.sources.copied', 'Copied') : t('cms_site.analytics.sources.copy', 'Copy')}
                    </button>
                </div>
            )}
        </div>
    );
}

interface FieldProps {
    value: string;
    onChange: React.Dispatch<React.SetStateAction<string>>;
    placeholder: string;
    label: string;
}

function Field({ value, onChange, placeholder, label }: FieldProps) {
    return (
        <label className="flex flex-col gap-[3px]">
            <span className="text-[10px] text-[var(--text-tertiary)]">{label}</span>
            <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="bg-[var(--bg-primary)] text-[var(--text-primary)] border border-[var(--border-default)] rounded-lg py-1.5 px-[9px] text-xs w-[100%]" />
        </label>
    );
}
