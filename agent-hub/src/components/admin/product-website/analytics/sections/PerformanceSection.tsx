/**
 * Performance — Core Web Vitals.
 *
 * The old version was a lie with a nice haircut: `summary.count` was 0 because
 * the tracker never asked for vitals, yet `band(0, …)` graded that as GOOD, so
 * five cards reported a flawless 0 ms for something never measured once.
 *
 * Two rules follow from that and are load-bearing here:
 *   1. Nothing is graded unless it was measured. `count === 0` is a distinct
 *      state — amber "not measured", never a green zero.
 *   2. Percentile gaps stay null. A day with no samples is a hole in the line,
 *      not a day the site was infinitely fast.
 *
 * Thresholds are Google's official Core Web Vitals bands, evaluated at p75 the
 * way CrUX does.
 */
import { Gauge, Wrench } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import TrendChart from '../charts/TrendChart';
import { rich } from '../rich';
import { fmt, pillClass } from '../ui';
import { Card, ErrorNote, Skeleton } from '../AsyncCard';
import { ACCENT, ShareBar, tint } from '../BarList';
import { useAnalyticsQuery } from '../useAnalyticsQuery';
import { resolveWindow, densify, bucketLabel } from '../window';
import type { AnalyticsScope } from '../../analyticsApi';
import type { DrillHandler } from '../ui.types';

/** Umami's `/report/performance` answer, as far as this section reads it. */
type VitalPercentiles = Record<string, number | null | undefined>;
type PerformancePayload = {
    chart?: { x?: unknown; t?: unknown; date?: unknown; y?: unknown; value?: unknown }[];
    summary?: { count?: number | string | null } & Record<string, number | string | VitalPercentiles | null | undefined>;
    pages?: { name?: string; count?: number; p75?: number | string | null }[];
};

type Band = { color: string; labelKey: string; label: string; rank: number };

type Metric = {
    id: string; label: string; name: string; unit: string; bands: [number, number]; fixKey: string; fix: string;
};

/** A metric with its measured value (null when unmeasured) and the band that value falls in. */
type GradedMetric = Metric & { value: number | null; band: Band };

// The bands are the status tones: the meter's fill tints them, the text reads their ink.
const GOOD = 'var(--success)';
const MEH = 'var(--warning)';
const POOR = 'var(--error)';

/** A status tone's readable ink (`var(--success)` → `var(--success-ink)`); other colours pass through. */
const inkOf = (c: string) => (/^var\(--(success|warning|error)\)$/.test(c) ? c.replace(')', '-ink)') : c);

// [good <=, needs-improvement <=] in the metric's own unit.
const METRICS: Metric[] = [
    { id: 'lcp', label: 'LCP', name: 'Largest Contentful Paint', unit: 'ms', bands: [2500, 4000], fixKey: 'cms_site.analytics.performance.fix_lcp', fix: 'a large image or font above the fold' },
    { id: 'inp', label: 'INP', name: 'Interaction to Next Paint', unit: 'ms', bands: [200, 500], fixKey: 'cms_site.analytics.performance.fix_inp', fix: 'heavy JavaScript blocking clicks' },
    { id: 'cls', label: 'CLS', name: 'Cumulative Layout Shift', unit: '', bands: [0.1, 0.25], fixKey: 'cms_site.analytics.performance.fix_cls', fix: 'images or embeds without reserved space' },
    { id: 'fcp', label: 'FCP', name: 'First Contentful Paint', unit: 'ms', bands: [1800, 3000], fixKey: 'cms_site.analytics.performance.fix_fcp', fix: 'render-blocking CSS or slow hosting' },
    { id: 'ttfb', label: 'TTFB', name: 'Time to First Byte', unit: 'ms', bands: [800, 1800], fixKey: 'cms_site.analytics.performance.fix_ttfb', fix: 'server or network latency' },
];

function band(value: number | null, [good, meh]: [number, number]): Band {
    if (value == null) return { color: 'var(--text-tertiary)', labelKey: 'cms_site.analytics.performance.band_unmeasured', label: 'Not measured', rank: -1 };
    if (value <= good) return { color: GOOD, labelKey: 'cms_site.analytics.performance.band_good', label: 'Good', rank: 0 };
    if (value <= meh) return { color: MEH, labelKey: 'cms_site.analytics.performance.band_meh', label: 'Needs work', rank: 1 };
    return { color: POOR, labelKey: 'cms_site.analytics.performance.band_poor', label: 'Poor', rank: 2 };
}

function formatValue(value: number | null, unit: string) {
    if (value == null) return '—';
    if (unit === 'ms') return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`;
    return Number(value).toFixed(3);
}

/**
 * Umami 3.x returns every vital in one response:
 *   { chart, summary: { lcp: {p50,p75,p95}, …, count }, pages, devices, browsers }
 * `count === 0` means nothing was sampled — a full summary of zeros comes back
 * regardless, and trusting it is the bug this file exists to not repeat.
 */
function readVital(payload: PerformancePayload | null | undefined, id: string, percentile: string = 'p75'): number | null {
    if (!payload || Number(payload.summary?.count) === 0) return null;
    const v = payload.summary?.[id];
    if (typeof v === 'number') return v;
    if (v && typeof v === 'object') return v[percentile] ?? v.p75 ?? v.p50 ?? null;
    return null;
}

interface PerformanceSectionProps {
    scope: AnalyticsScope;
    onDrill: DrillHandler;
}

export default function PerformanceSection({ scope, onDrill }: PerformanceSectionProps) {
    const { t } = useTranslation();
    const [percentile, setPercentile] = useState('p75');
    // One request covers all five vitals plus the per-page and per-device
    // splits — the report returns them together, so fetching per card would be
    // five identical round-trips.
    const vitals = useAnalyticsQuery<PerformancePayload>('report', 'performance', scope);
    const win = useMemo(() => resolveWindow(scope), [scope]);

    const payload = vitals.payload;
    const sampleCount = Number(payload?.summary?.count) || 0;
    const measured = sampleCount > 0;

    const graded = useMemo(() => METRICS.map(m => {
        const value = readVital(payload, m.id, percentile);
        return { ...m, value, band: band(value, m.bands) };
    }), [payload, percentile]);

    // "Fix first": worst band, then furthest past its threshold. A flat list of
    // five equal cards makes you do this ranking in your head every time.
    const worst = useMemo(() => graded
        .filter(g => g.band.rank > 0)
        .sort((a, b) => (b.band.rank - a.band.rank)
            || (((b.value ?? 0) / b.bands[0]) - ((a.value ?? 0) / a.bands[0]))), [graded]);

    const trend = useMemo(() => {
        const rows = Array.isArray(payload?.chart) ? payload.chart : [];
        if (!rows.length) return null;
        // Percentiles get null gaps, never zero-fill.
        const pts = densify(rows.map(r => ({ x: r.x ?? r.t ?? r.date, y: r.y ?? r.value })), win, { fill: null });
        if (pts.every(p => p.value == null)) return null;
        return { labels: pts.map(p => bucketLabel(p.t, win.unit)), data: pts.map(p => p.value) };
    }, [payload, win]);

    if (vitals.loading) {
        return <div className="flex flex-col gap-3.5"><Skeleton height={180} /><Skeleton height={220} /></div>;
    }
    if (vitals.error) return <ErrorNote message={vitals.error} onRetry={vitals.reload} />;

    return (
        <div className="flex flex-col gap-3.5">
            {!measured && <NotMeasured />}

            {measured && (
                <Verdict graded={graded} worst={worst} sampleCount={sampleCount}
                    percentile={percentile} onPercentile={setPercentile} />
            )}

            <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
                {graded.map(g => <VitalMeter key={g.id} metric={g} />)}
            </div>

            {measured && trend && (
                <Card title={t('cms_site.analytics.performance.lcp_trend', 'Largest Contentful Paint over time')} icon={Gauge}>
                    <TrendChart
                        labels={trend.labels}
                        series={[{ key: 'lcp', label: `LCP ${percentile}`, data: trend.data, color: ACCENT }]}
                        refLines={[
                            { y: 2500, label: t('cms_site.analytics.performance.ref_good', 'good'), color: GOOD },
                            { y: 4000, label: t('cms_site.analytics.performance.ref_poor', 'poor'), color: POOR },
                        ]}
                        formatY={(v) => formatValue(v, 'ms')}
                        height={180}
                        emptyText={t('cms_site.analytics.performance.trend_empty', 'Not enough samples to draw a trend yet.')}
                    />
                    <p className="text-[11px] text-[var(--text-tertiary)] mt-2.5 mx-0 mb-0">
                        {t('cms_site.analytics.performance.gaps', 'Gaps are periods with no samples — not periods where the site was instant.')}
                    </p>
                </Card>
            )}

            {measured && <PerPage payload={payload} onDrill={onDrill} />}

            <div className="text-[11px] text-[var(--text-tertiary)] flex gap-[7px] items-start">
                <Gauge className="mt-px h-3.5 w-3.5 shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
                <span>
                    {t('cms_site.analytics.performance.footnote', 'Web vitals ride along with the standard tracker — no extra script, and nothing about the visitor beyond browser timings. They are reported when someone leaves the page or after ten seconds on it, so they lag the pageview slightly.')}{' '}
                    {percentile === 'p75'
                        ? t('cms_site.analytics.performance.values_p75', 'Values are 75th-percentile, matching how Google grades Core Web Vitals.')
                        : t('cms_site.analytics.performance.values_other', 'Values are {percentile} across real visits.', { percentile })}
                </span>
            </div>
        </div>
    );
}

/** One sentence at the top saying what to do, before five numbers saying what is. */
interface VerdictProps {
    graded: GradedMetric[];
    worst: GradedMetric[];
    sampleCount: number;
    percentile: string;
    onPercentile: React.Dispatch<React.SetStateAction<string>>;
}

function Verdict({ graded, worst, sampleCount, percentile, onPercentile }: VerdictProps) {
    const { t } = useTranslation();
    const allGood = worst.length === 0;
    return (
        <Card title={t('cms_site.analytics.performance.verdict', 'Verdict')} icon={Wrench} action={
            <div className="flex gap-[5px] items-center">
                <span className="text-[10px] text-[var(--text-tertiary)]">{t('cms_site.analytics.performance.samples', '{n} samples', { n: fmt(sampleCount) })}</span>
                {['p50', 'p75', 'p95'].map(p => (
                    <button key={p} onClick={() => onPercentile(p)} aria-pressed={percentile === p} className={pillClass(percentile === p)}>{p}</button>
                ))}
            </div>
        }>
            {allGood ? (
                <p className="text-[13px] text-[var(--text-secondary)] m-0">
                    {rich(t('cms_site.analytics.performance.all_good', "All five Core Web Vitals are in Google's {good} band for this period. Nothing to fix."), {
                        good: <strong className="text-[var(--success-ink)]">{t('cms_site.analytics.performance.all_good_word', 'good')}</strong>,
                    })}
                </p>
            ) : (
                <div className="flex flex-col gap-2.5">
                    <p className="text-[13px] text-[var(--text-secondary)] m-0">
                        {t('cms_site.analytics.performance.fix_order', 'Fix in this order — worst band first, then furthest past its threshold.')}
                    </p>
                    {worst.map((g, i) => (
                        <div key={g.id} className="flex gap-2.5 items-baseline">
                            <span className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-md text-[10px] font-semibold" style={{ background: tint(g.band.color, 14), color: inkOf(g.band.color) }}>{i + 1}</span>
                            <span className="text-xs">
                                <strong className="text-[var(--text-primary)]">{g.name}</strong>{' '}
                                <span className="font-semibold" style={{ color: inkOf(g.band.color) }}>
                                    {formatValue(g.value, g.unit)}
                                </span>
                                <span className="text-[var(--text-tertiary)]">
                                    {' '}{t('cms_site.analytics.performance.target', '— target {target}. Usually {fix}.', { target: formatValue(g.bands[0], g.unit), fix: t(g.fixKey, g.fix) })}
                                </span>
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </Card>
    );
}

function VitalMeter({ metric }: { metric: GradedMetric }) {
    const { t } = useTranslation();
    const { value, band: b, unit, bands } = metric;
    const measured = value != null;
    // Where the value sits across the three bands, capped so a catastrophic
    // outlier still renders a full bar rather than overflowing.
    const pos = measured ? Math.min(1, value / (bands[1] * 1.5)) * 100 : 0;

    return (
        <div className="bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-xl py-3.5 px-4">
            <div className="flex items-baseline justify-between gap-2">
                <span className="text-[13px] font-semibold text-[var(--text-primary)]">{metric.label}</span>
                <span
                    className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] ${measured ? '' : 'border border-[var(--border-default)] text-[var(--text-tertiary)]'}`}
                    style={measured ? { background: tint(b.color, 12), color: inkOf(b.color) } : undefined}
                >{t(b.labelKey, b.label)}</span>
            </div>
            <div className="text-[11px] text-[var(--text-tertiary)] mb-2">{metric.name}</div>

            <div className={measured ? 'text-2xl font-semibold leading-snug tabular-nums' : 'text-[13px] font-semibold leading-snug text-[var(--text-tertiary)]'} style={measured ? { color: inkOf(b.color) } : undefined}>
                {measured ? formatValue(value, unit) : t('cms_site.analytics.performance.no_samples', 'No samples yet')}
            </div>

            {/* Threshold track: good | needs work | poor, with a marker where we sit. */}
            <div className="relative mt-2.5">
                <div className="flex h-[5px] rounded-full overflow-hidden gap-[1px]">
                    <div style={{ flex: bands[0], background: tint(GOOD, measured ? 33 : 13) }} />
                    <div style={{ flex: bands[1] - bands[0], background: tint(MEH, measured ? 33 : 13) }} />
                    <div style={{ flex: bands[1] * 0.5, background: tint(POOR, measured ? 33 : 13) }} />
                </div>
                {measured && (
                    <div className="absolute -top-[3px] h-[11px] w-[3px] -translate-x-1/2 rounded-sm" style={{ left: `${pos}%`, background: inkOf(b.color) }} />
                )}
            </div>
            <div className="text-[10px] text-[var(--text-tertiary)] mt-1.5">
                {t('cms_site.analytics.performance.thresholds', 'good ≤ {good} · poor > {poor}', { good: formatValue(bands[0], unit), poor: formatValue(bands[1], unit) })}
            </div>
        </div>
    );
}

/** Which pages are slow — the report already splits by page and device. */
function PerPage({ payload, onDrill }: { payload: PerformancePayload | null; onDrill: DrillHandler }) {
    const { t } = useTranslation();
    const pages = Array.isArray(payload?.pages) ? payload.pages : [];
    if (!pages.length) return null;
    const peak = pages.reduce((a, p) => Math.max(a, Number(p.p75) || 0), 1);

    return (
        <Card title={t('cms_site.analytics.performance.slowest', 'Slowest pages')} icon={Gauge} action={
            <span className="text-[10px] text-[var(--text-tertiary)]">{t('cms_site.analytics.performance.slowest_hint', 'LCP p75 · click to filter')}</span>
        }>
            <div className="flex flex-col gap-2">
                {[...pages]
                    .sort((a, b) => (Number(b.p75) || 0) - (Number(a.p75) || 0))
                    .slice(0, 10)
                    .map((p, i) => {
                        const v = Number(p.p75) || 0;
                        const b = band(v, [2500, 4000]);
                        return (
                            <button key={p.name || i} onClick={() => p.name && onDrill?.('path', p.name)}
                                className={`block w-full text-left p-0 bg-transparent border-0 ${p.name ? 'cursor-pointer' : 'cursor-default'}`}>
                                <div className="flex justify-between gap-2.5 mb-[3px]">
                                    <span className="text-xs text-[var(--text-primary)] overflow-hidden text-ellipsis whitespace-nowrap">{p.name || t('cms_site.analytics.common.unknown', 'Unknown')}</span>
                                    <span className="shrink-0 text-xs font-semibold tabular-nums" style={{ color: inkOf(b.color) }}>
                                        {formatValue(v, 'ms')}
                                        <span className="text-[var(--text-tertiary)] font-medium">
                                            {' '}· {fmt(p.count || 0)}
                                        </span>
                                    </span>
                                </div>
                                <ShareBar value={v} of={peak} color={b.color} />
                            </button>
                        );
                    })}
            </div>
        </Card>
    );
}

/**
 * The capability-missing state: amber, not red. Nothing is broken — the
 * measurement simply has not happened. Distinguishing this from "zero" is the
 * entire point of this rewrite.
 */
function NotMeasured() {
    const { t } = useTranslation();
    return (
        <div className="flex gap-[9px] items-start py-3 px-[15px] rounded-lg border border-[color-mix(in_srgb,var(--warning)_40%,transparent)] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] text-xs text-[var(--warning-ink)]">
            <Gauge className="w-[14px] h-[14px] mt-[1px] shrink-0" />
            <span>
                <strong>{t('cms_site.analytics.performance.unmeasured_title', 'No web-vitals samples in this period.')}</strong>{' '}
                {t('cms_site.analytics.performance.unmeasured_body', 'The tracker reports them when a visitor leaves the page or after ten seconds on it, so they arrive a little after the pageviews do — a quiet period can legitimately have none. If this stays empty on a site with steady traffic, the published site is probably still serving an older tracker: republish it.')}
            </span>
        </div>
    );
}

;
