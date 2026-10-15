import { Filter, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { ACCENT, Card, Empty, ErrorNote, Skeleton, fmt, paletteAt } from '../ui';
import type { AnalyticsScope } from '../../analyticsApi';
import { useAnalyticsQuery } from '../useAnalyticsQuery';
import type { MetricRow, StepSpec, FunnelPayload } from './BehaviorSection.types';

export function readFunnel(payload: FunnelPayload) {
    const rows = Array.isArray(payload) ? payload : (Array.isArray(payload?.data) ? payload.data : []);
    return rows.map(r => ({
        label: r.value ?? r.x ?? r.type ?? '',
        visitors: Number(r.visitors ?? r.y ?? r.count ?? 0),
        dropoff: r.dropoff != null ? Number(r.dropoff) : null,
    }));
}

/**
 * A funnel worth showing before the user has built one.
 *
 * The tab used to open on an empty box with a single "Add a step…" dropdown,
 * so it read as broken on arrival and demanded data modelling before it showed
 * anything. The busiest landing page → the next busiest page → a conversion
 * event is the funnel almost everyone would have drawn anyway.
 */
export function defaultSteps(pageRows: MetricRow[], eventRows: MetricRow[]): StepSpec[] {
    const pages = pageRows.filter(p => p.x).slice(0, 3);
    if (pages.length < 2) return [];
    const home = pages.find(p => p.x === '/') || pages[0];
    const next = pages.find(p => p.x !== home.x);
    if (!next) return [];

    const steps = [{ type: 'path', value: home.x }, { type: 'path', value: next.x }];
    const conversion = eventRows.find(e => e.x === 'form_submit') || eventRows.find(e => e.x === 'cta_click');
    if (conversion) steps.push({ type: 'event', value: conversion.x });
    return steps;
}

export function FunnelPanel({ scope }: { scope: AnalyticsScope }) {
    const { t } = useTranslation();
    const pages = useAnalyticsQuery<MetricRow[]>('query', 'metrics', scope, { params: { type: 'path', limit: 30 } });
    const events = useAnalyticsQuery<MetricRow[]>('query', 'metrics', scope, { params: { type: 'event', limit: 30 } });
    // null = "the user has not touched this yet", which is distinct from an
    // explicitly cleared funnel — clearing must not immediately re-seed.
    const [steps, setSteps] = useState<StepSpec[] | null>(null);

    const pageRows = Array.isArray(pages.payload) ? pages.payload : [];
    const eventRows = Array.isArray(events.payload) ? events.payload : [];
    const pageOptions = pageRows.map(p => ({ type: 'path', value: p.x }));
    const eventOptions = eventRows.map(p => ({ type: 'event', value: p.x }));

    const effectiveSteps = steps ?? defaultSteps(pageRows, eventRows);
    const isDefault = steps === null && effectiveSteps.length > 0;
    const setStepsFrom = (fn: (list: StepSpec[]) => StepSpec[]) => setSteps(fn(effectiveSteps));

    const ready = effectiveSteps.length >= 2;
    const funnel = useAnalyticsQuery<FunnelPayload>('report', 'funnel', scope, {
        body: { steps: effectiveSteps, window: 60 },
        enabled: ready,
    });

    const rows = readFunnel(funnel.payload);
    const top = rows[0]?.visitors || 0;
    const bottom = rows.length ? rows[rows.length - 1].visitors : 0;
    const conversion = top > 0 ? (bottom / top) * 100 : null;

    const addStep = (raw: string) => {
        if (!raw) return;
        const [type, ...rest] = raw.split(':');
        setStepsFrom(s => [...s, { type, value: rest.join(':') }]);
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Card title={t('cms_site.analytics.behavior.funnel_build', 'Build a funnel')} icon={Filter} action={
                isDefault ? (
                    <span style={{ fontSize: 10, color: 'var(--text-muted, #777)' }}>
                        {t('cms_site.analytics.behavior.funnel_suggested', 'suggested — edit the steps to make it yours')}
                    </span>
                ) : null
            }>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {effectiveSteps.map((s, i) => (
                        <div key={i} style={{
                            display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 8,
                            background: 'var(--bg-tertiary, rgba(255,255,255,0.03))',
                        }}>
                            <span style={{
                                width: 20, height: 20, borderRadius: 99, flexShrink: 0, fontSize: 11, fontWeight: 800,
                                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                background: `${paletteAt(i)}22`, color: paletteAt(i),
                            }}>{i + 1}</span>
                            <span style={{ fontSize: 12, color: 'var(--text-muted, #888)' }}>{s.type}</span>
                            <span style={{ fontSize: 12, color: 'var(--text-primary, #fff)', flex: 1 }}>{s.value}</span>
                            <button onClick={() => setStepsFrom(list => list.filter((_, j) => j !== i))}
                                aria-label={t('cms_site.analytics.behavior.remove_step', 'Remove step {n}', { n: i + 1 })}
                                style={{ background: 'transparent', border: 'none', color: 'var(--text-muted, #888)', cursor: 'pointer' }}>
                                <X style={{ width: 13, height: 13 }} />
                            </button>
                        </div>
                    ))}

                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Plus style={{ width: 13, height: 13, color: ACCENT }} />
                        <select
                            value=""
                            onChange={(e) => { addStep(e.target.value); e.target.value = ''; }}
                            style={{
                                background: 'var(--bg-primary, #0f0f1a)', color: 'var(--text-primary, #fff)',
                                border: '1px solid var(--border-default, rgba(255,255,255,0.12))',
                                borderRadius: 8, padding: '7px 10px', fontSize: 12, minWidth: 260,
                            }}
                        >
                            <option value="">{t('cms_site.analytics.behavior.add_step', 'Add a step…')}</option>
                            {pageOptions.length > 0 && (
                                <optgroup label={t('cms_site.analytics.behavior.group_pages', 'Pages')}>
                                    {pageOptions.map((o, i) => <option key={`p${i}`} value={`path:${o.value}`}>{o.value}</option>)}
                                </optgroup>
                            )}
                            {eventOptions.length > 0 && (
                                <optgroup label={t('cms_site.analytics.behavior.group_events', 'Events')}>
                                    {eventOptions.map((o, i) => <option key={`e${i}`} value={`event:${o.value}`}>{o.value}</option>)}
                                </optgroup>
                            )}
                        </select>
                        {effectiveSteps.length > 0 && (
                            <button onClick={() => setSteps([])} style={{
                                background: 'transparent', border: '1px solid var(--border-default, rgba(255,255,255,0.12))',
                                borderRadius: 8, padding: '6px 10px', fontSize: 12, color: 'var(--text-muted, #888)', cursor: 'pointer',
                            }}>{t('cms_site.analytics.behavior.clear', 'Clear')}</button>
                        )}
                    </div>
                    {!ready && (
                        <p style={{ fontSize: 11, color: 'var(--text-muted, #777)', margin: 0 }}>
                            {pageOptions.length < 2
                                ? t('cms_site.analytics.behavior.funnel_need_pages', 'Once visitors have seen at least two different pages, a funnel can be built here.')
                                : t('cms_site.analytics.behavior.funnel_need_steps', 'Pick at least two steps to see conversion and drop-off.')}
                        </p>
                    )}
                </div>
            </Card>

            {ready && (
                <Card title={t('cms_site.analytics.behavior.conversion', 'Conversion')} action={
                    conversion != null ? (
                        <span style={{ fontSize: 12, color: 'var(--text-muted, #888)' }}>
                            <strong style={{ color: ACCENT, fontSize: 15 }}>{conversion.toFixed(1)}%</strong>
                            {' '}{t('cms_site.analytics.behavior.made_it', 'made it all the way through')}
                        </span>
                    ) : null
                }>
                    {funnel.loading ? <Skeleton height={200} />
                        : funnel.error ? <ErrorNote message={funnel.error} onRetry={funnel.reload} compact />
                        : rows.length === 0 ? <Empty text={t('cms_site.analytics.behavior.funnel_empty', 'No visitors completed this path in the selected period.')} />
                        : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                                {rows.map((r, i) => {
                                    const pct = top > 0 ? Math.round((r.visitors / top) * 100) : 0;
                                    const prev = i > 0 ? rows[i - 1].visitors : null;
                                    const drop = prev ? prev - r.visitors : 0;
                                    return (
                                        <div key={i}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 4 }}>
                                                <span style={{ fontSize: 12, color: 'var(--text-primary, #fff)' }}>
                                                    {i + 1}. {r.label || effectiveSteps[i]?.value}
                                                </span>
                                                <span style={{ fontSize: 12, fontWeight: 700, color: ACCENT }}>
                                                    {fmt(r.visitors)} <span style={{ color: 'var(--text-muted, #888)', fontWeight: 500 }}>({pct}%)</span>
                                                </span>
                                            </div>
                                            <div style={{ height: 10, borderRadius: 5, background: 'var(--bg-tertiary, rgba(255,255,255,0.06))', overflow: 'hidden' }}>
                                                <div style={{ width: `${pct}%`, height: '100%', background: paletteAt(i) }} />
                                            </div>
                                            {prev != null && drop > 0 && (
                                                <div style={{ fontSize: 11, color: '#f87171', marginTop: 3 }}>
                                                    −{t('cms_site.analytics.behavior.dropped', '{n} dropped off here', { n: fmt(drop) })}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                </Card>
            )}
        </div>
    );
}
