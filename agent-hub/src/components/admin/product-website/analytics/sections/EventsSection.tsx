/**
 * Events — what visitors actually clicked.
 *
 * The old tab was one bar list of event NAMES ("cta_click 6") plus a permanent
 * "click an event above to see its properties" placeholder occupying half the
 * screen. Knowing that `cta_click` happened six times is close to useless; the
 * question is always WHICH button, in WHICH block, on WHICH page.
 *
 * That is answerable and always has been: the public renderer stamps
 * `label`, `href`, `block` and `blockType` onto every auto-tracked event, and
 * `/query/event-data` returns them. Nothing in the product read them.
 */
import { Zap, MousePointerClick, Layers, ExternalLink } from 'lucide-react';
import React, { useMemo } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import type { TranslateFn } from '@/hooks/useTranslation';
import { blockLabel } from '../heatmap/model';
import { foldEventData, ctaLeaderboard, blockLeaderboard } from '../model';
import { SERIES, Empty, StatGrid, StatTile, fmt } from '../ui';
import { Card, ErrorNote, Skeleton } from '../AsyncCard';
import { ACCENT, ShareBar, maxOf } from '../BarList';
import type { SectionProps } from '../ui.types';
import { useAnalyticsQuery } from '../useAnalyticsQuery';

const EVENT_LABELS: Record<string, { key: string; en: string }> = {
    cta_click: { key: 'cms_site.analytics.events.label_cta_click', en: 'Button & link clicks' },
    form_submit: { key: 'cms_site.analytics.events.label_form_submit', en: 'Form submissions' },
    outbound_click: { key: 'cms_site.analytics.events.label_outbound_click', en: 'Clicks to other sites' },
    file_download: { key: 'cms_site.analytics.events.label_file_download', en: 'File downloads' },
};
const eventLabel = (name: string, t: TranslateFn) => (EVENT_LABELS[name] ? t(EVENT_LABELS[name].key, EVENT_LABELS[name].en) : name);

export default function EventsSection({ scope, onDrill }: SectionProps) {
    const { t } = useTranslation();
    const names = useAnalyticsQuery('query', 'metrics', scope, { params: { type: 'event', limit: 25 } });
    // pageSize is only forwardable because the proxy now allow-lists it —
    // without it we would silently only ever see Umami's first page.
    const detail = useAnalyticsQuery('query', 'event-data', scope, { params: { pageSize: 500 } });

    const nameRows = useMemo(() => (Array.isArray(names.payload) ? names.payload : [])
        .filter(r => r.x), [names.payload]);
    const total = nameRows.reduce((a, r) => a + (r.y || 0), 0);

    const events = useMemo(() => foldEventData(detail.payload), [detail.payload]);
    const ctas = useMemo(() => ctaLeaderboard(events), [events]);
    const blocks = useMemo(() => blockLeaderboard(events), [events]);

    if (names.loading) {
        return <div className="[display:flex] [flex-direction:column] [gap:14px]"><Skeleton height={120} /><Skeleton height={280} /></div>;
    }
    if (names.error) return <ErrorNote message={names.error} onRetry={names.reload} />;

    if (!nameRows.length) {
        return (
            <Card title={t('cms_site.analytics.events.title', 'Events')} icon={Zap}>
                <Empty text={t('cms_site.analytics.events.empty', 'No interactions recorded yet. The published site tracks button clicks, form submissions, outbound links and file downloads automatically — they appear here as soon as a visitor uses the site.')} />
            </Card>
        );
    }

    return (
        <div className="[display:flex] [flex-direction:column] [gap:14px]">
            <StatGrid min={200}>
                {nameRows.slice(0, 4).map((r, i) => (
                    <StatTile
                        key={r.x} icon={i === 0 ? MousePointerClick : Zap}
                        label={eventLabel(r.x, t)}
                        value={fmt(r.y || 0)}
                        color={i === 0 ? ACCENT : SERIES.secondary}
                        subtitle={r.x}
                    />
                ))}
            </StatGrid>

            <Card title={t('cms_site.analytics.events.clicked', 'What visitors clicked')} icon={MousePointerClick} action={
                <span className="[font-size:10px] [color:var(--text-muted,#777)]">
                    {t('cms_site.analytics.events.interactions', '{n} interactions', { n: fmt(total) })}
                </span>
            }>
                {detail.loading ? <Skeleton height={240} />
                    : detail.error ? <ErrorNote message={detail.error} onRetry={detail.reload} compact />
                    : ctas.length === 0 ? (
                        <Empty text={t('cms_site.analytics.events.no_labels', 'These events carry no labels yet — republish the site so the tracker attaches them.')} />
                    ) : <CtaTable rows={ctas} />}
            </Card>

            <div className="[display:grid] [grid-template-columns:repeat(auto-fit,minmax(300px,1fr))] [gap:12px]">
                <Card title={t('cms_site.analytics.events.blocks', 'Which blocks earn the clicks')} icon={Layers} action={
                    <span className="[font-size:10px] [color:var(--text-muted,#777)]">{t('cms_site.analytics.events.blocks_hint', 'across every page')}</span>
                }>
                    {detail.loading ? <Skeleton height={200} />
                        : blocks.length === 0 ? <Empty text={t('cms_site.analytics.events.no_blocks', 'No block attribution available for these events.')} />
                        : <BlockTable rows={blocks} />}
                </Card>

                <Card title={t('cms_site.analytics.events.types', 'Event types')} icon={Zap}>
                    <div className="[display:flex] [flex-direction:column] [gap:9px]">
                        {nameRows.map((r, i) => (
                            <button key={r.x} onClick={() => onDrill('event', r.x)}
                                title={t('cms_site.analytics.events.filter_by', 'Filter the dashboard by {value}', { value: r.x })}
                                className="[display:block] w-[100%] [text-align:left] [padding:0] [background:transparent] [border:none] [cursor:pointer]">
                                <div className="[display:flex] [justify-content:space-between] [gap:10px] [margin-bottom:3px]">
                                    <span className="[font-size:12px] [color:var(--text-primary,#fff)]">
                                        {eventLabel(r.x, t)}
                                    </span>
                                    <span style={{ fontSize: 12, fontWeight: 700, color: ACCENT }}>{fmt(r.y || 0)}</span>
                                </div>
                                <ShareBar value={r.y || 0} of={total} />
                            </button>
                        ))}
                    </div>
                </Card>
            </div>
        </div>
    );
}

/** One CTA label with its click count and the block types it was placed in. */
interface CtaRow {
    key: string;
    label: string;
    href?: string | null;
    count: number;
    placements: { type: string; count: number }[];
}

/** One block type with its click count and the CTA labels clicked in it. */
interface BlockRow {
    type: string;
    count: number;
    labels: string[];
}

/** One row per distinct label, with where it was placed. */
function CtaTable({ rows }: { rows: CtaRow[] }) {
    const { t } = useTranslation();
    const peak = maxOf(rows.map(r => r.count));
    return (
        <div className="[display:flex] [flex-direction:column] [gap:11px]">
            {rows.slice(0, 20).map(r => (
                <div key={r.key}>
                    <div className="[display:flex] [justify-content:space-between] [gap:10px] [margin-bottom:4px] [align-items:baseline]">
                        <span className="[display:flex] [gap:8px] [align-items:baseline] min-w-[0]">
                            <span className="[font-size:13px] [font-weight:600] [color:var(--text-primary,#fff)] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">{r.label}</span>
                            {r.href && (
                                <span className="[display:inline-flex] [align-items:center] [gap:3px] [flex-shrink:0] [font-size:10px] [color:var(--text-muted,#777)]">
                                    <ExternalLink className="w-[9px] h-[9px]" />
                                    {shortHref(r.href)}
                                </span>
                            )}
                        </span>
                        <span style={{ fontSize: 13, fontWeight: 800, color: ACCENT, flexShrink: 0 }}>{fmt(r.count)}</span>
                    </div>
                    <ShareBar value={r.count} of={peak} />
                    {r.placements.length > 0 && (
                        <div className="[display:flex] [gap:6px] [flex-wrap:wrap] [margin-top:5px]">
                            {r.placements.map(p => (
                                <span key={p.type} className="[font-size:10px] [padding:1px_7px] [border-radius:5px] [background:var(--bg-tertiary,rgba(255,255,255,0.05))] [color:var(--text-muted,#999)]">
                                    {blockLabel(p.type, t)} · {fmt(p.count)}
                                </span>
                            ))}
                        </div>
                    )}
                </div>
            ))}
        </div>
    );
}

function BlockTable({ rows }: { rows: BlockRow[] }) {
    const { t } = useTranslation();
    const peak = maxOf(rows.map(r => r.count));
    return (
        <div className="[display:flex] [flex-direction:column] [gap:9px]">
            {rows.map(r => (
                <div key={r.type}>
                    <div className="[display:flex] [justify-content:space-between] [gap:10px] [margin-bottom:3px]">
                        <span className="[font-size:12px] [color:var(--text-primary,#fff)]">{blockLabel(r.type, t)}</span>
                        <span style={{ fontSize: 12, fontWeight: 700, color: ACCENT }}>{fmt(r.count)}</span>
                    </div>
                    <ShareBar value={r.count} of={peak} />
                    {r.labels.length > 0 && (
                        <div className="[font-size:10px] [color:var(--text-muted,#777)] [margin-top:3px]">
                            {r.labels.slice(0, 4).join(' · ')}{r.labels.length > 4 ? ` ${t('cms_site.analytics.events.more', '+{n} more', { n: r.labels.length - 4 })}` : ''}
                        </div>
                    )}
                </div>
            ))}
        </div>
    );
}

/** Trim an href to something readable in a chip. */
function shortHref(href: unknown): string {
    const s = String(href);
    try {
        const u = new URL(s.includes('://') ? s : `https://${s}`);
        return `${u.hostname.replace(/^www\./, '')}${u.pathname === '/' ? '' : u.pathname}`.slice(0, 42);
    } catch {
        return s.slice(0, 42);
    }
}
