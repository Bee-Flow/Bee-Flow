/**
 * Behavior — funnels, user journeys, retention and goals.
 *
 * These reports are computed by Umami from pageviews plus the custom events the
 * public renderer emits (cta_click, form_submit, outbound_click, file_download).
 *
 * Response shapes differ a little between Umami builds, so every reader here is
 * tolerant: it accepts the documented shape and the obvious variants, and falls
 * back to an honest empty state rather than rendering a confident wrong number.
 */
import { Filter, GitBranch, Repeat, Target, Plus, X } from 'lucide-react';
import React, { useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { Empty, fmt, paletteAt, pillClass } from '../ui';
import { Card, ErrorNote, Skeleton } from '../AsyncCard';
import { ACCENT, tint } from '../BarList';
import { useAnalyticsQuery } from '../useAnalyticsQuery';
import type { AnalyticsScope } from '../../analyticsApi';
import type { DrillHandler, XYRow } from '../ui.types';
import type { Listish, BehaviorSectionProps, FunnelRow, Step, FunnelPanelProps, JourneyRow, JourneyPanelProps, RetentionRow, RetentionPanelProps, GoalPayload, GoalsPanelProps } from './BehaviorSection.types';
import { readFunnel, defaultSteps, readJourneys, readRetention } from './BehaviorSection.helpers';

const TABS = [
    { id: 'funnel', labelKey: 'cms_site.analytics.behavior.tab_funnel', label: 'Funnel', icon: Filter },
    { id: 'journey', labelKey: 'cms_site.analytics.behavior.tab_journeys', label: 'Journeys', icon: GitBranch },
    { id: 'retention', labelKey: 'cms_site.analytics.behavior.tab_retention', label: 'Retention', icon: Repeat },
    { id: 'goals', labelKey: 'cms_site.analytics.behavior.tab_goals', label: 'Goals', icon: Target },
];

export default function BehaviorSection({ scope, onDrill }: BehaviorSectionProps) {
    const { t } = useTranslation();
    const [tab, setTab] = useState('funnel');
    return (
        <div className="flex flex-col gap-3.5">
            <div className="flex gap-1.5 flex-wrap">
                {TABS.map(tb => {
                    const Icon = tb.icon;
                    const active = tb.id === tab;
                    return (
                        <button key={tb.id} onClick={() => setTab(tb.id)} aria-pressed={active} className={pillClass(active)}>
                            <Icon className="w-[13px] h-[13px]" /> {t(tb.labelKey, tb.label)}
                        </button>
                    );
                })}
            </div>
            {tab === 'funnel' && <FunnelPanel scope={scope} />}
            {tab === 'journey' && <JourneyPanel scope={scope} onDrill={onDrill} />}
            {tab === 'retention' && <RetentionPanel scope={scope} />}
            {tab === 'goals' && <GoalsPanel scope={scope} />}
        </div>
    );
}

// ── Funnel ───────────────────────────────────────────────────────────

function FunnelPanel({ scope }: FunnelPanelProps) {
    const { t } = useTranslation();
    const pages = useAnalyticsQuery<XYRow[]>('query', 'metrics', scope, { params: { type: 'path', limit: 30 } });
    const events = useAnalyticsQuery<XYRow[]>('query', 'metrics', scope, { params: { type: 'event', limit: 30 } });
    // null = "the user has not touched this yet", which is distinct from an
    // explicitly cleared funnel — clearing must not immediately re-seed.
    const [steps, setSteps] = useState<Step[] | null>(null);
    const pageRows = Array.isArray(pages.payload) ? pages.payload : [];
    const eventRows = Array.isArray(events.payload) ? events.payload : [];
    const pageOptions = pageRows.map(p => ({ type: 'path', value: p.x }));
    const eventOptions = eventRows.map(p => ({ type: 'event', value: p.x }));

    const effectiveSteps = steps ?? defaultSteps(pageRows, eventRows);
    const isDefault = steps === null && effectiveSteps.length > 0;
    const setStepsFrom = (fn: (list: Step[]) => Step[]) => setSteps(fn(effectiveSteps));

    const ready = effectiveSteps.length >= 2;
    const funnel = useAnalyticsQuery<Listish<FunnelRow>>('report', 'funnel', scope, {
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
        <div className="flex flex-col gap-3.5">
            <Card title={t('cms_site.analytics.behavior.funnel_build', 'Build a funnel')} icon={Filter} action={
                isDefault ? (
                    <span className="text-[10px] text-[var(--text-tertiary)]">
                        {t('cms_site.analytics.behavior.funnel_suggested', 'suggested — edit the steps to make it yours')}
                    </span>
                ) : null
            }>
                <div className="flex flex-col gap-2.5">
                    {effectiveSteps.map((s, i) => (
                        <div key={i} className="flex items-center gap-2 py-[7px] px-2.5 rounded-lg bg-[var(--bg-tertiary)]">
                            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--bg-card)] text-[11px] font-semibold text-[var(--text-primary)] ring-2" style={{ '--tw-ring-color': paletteAt(i) } as React.CSSProperties}>{i + 1}</span>
                            <span className="text-xs text-[var(--text-tertiary)]">{s.type}</span>
                            <span className="text-xs text-[var(--text-primary)] flex-1">{s.value}</span>
                            <button onClick={() => setStepsFrom(list => list.filter((_, j) => j !== i))}
                                aria-label={t('cms_site.analytics.behavior.remove_step', 'Remove step {n}', { n: i + 1 })}
                                className="bg-transparent border-0 text-[var(--text-tertiary)] cursor-pointer">
                                <X className="w-[13px] h-[13px]" />
                            </button>
                        </div>
                    ))}

                    <div className="flex items-center gap-2">
                        <Plus className="h-3.5 w-3.5 text-[var(--text-tertiary)]" aria-hidden="true" />
                        <select
                            value=""
                            onChange={(e) => { addStep(e.target.value); e.target.value = ''; }}
                            className="bg-[var(--bg-primary)] text-[var(--text-primary)] border border-[var(--border-default)] rounded-lg py-[7px] px-2.5 text-xs min-w-[260px]"
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
                            <button onClick={() => setSteps([])} className="bg-transparent border border-[var(--border-default)] rounded-lg py-1.5 px-2.5 text-xs text-[var(--text-tertiary)] cursor-pointer">{t('cms_site.analytics.behavior.clear', 'Clear')}</button>
                        )}
                    </div>
                    {!ready && (
                        <p className="text-[11px] text-[var(--text-tertiary)] m-0">
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
                        <span className="text-xs text-[var(--text-tertiary)]">
                            <strong className="text-[15px] font-semibold tabular-nums text-[var(--text-primary)]">{conversion.toFixed(1)}%</strong>
                            {' '}{t('cms_site.analytics.behavior.made_it', 'made it all the way through')}
                        </span>
                    ) : null
                }>
                    {funnel.loading ? <Skeleton height={200} />
                        : funnel.error ? <ErrorNote message={funnel.error} onRetry={funnel.reload} compact />
                        : rows.length === 0 ? <Empty text={t('cms_site.analytics.behavior.funnel_empty', 'No visitors completed this path in the selected period.')} />
                        : (
                            <div className="flex flex-col gap-3">
                                {rows.map((r, i) => {
                                    const pct = top > 0 ? Math.round((r.visitors / top) * 100) : 0;
                                    const prev = i > 0 ? rows[i - 1].visitors : null;
                                    const drop = prev ? prev - r.visitors : 0;
                                    return (
                                        <div key={i}>
                                            <div className="flex justify-between gap-2.5 mb-1">
                                                <span className="text-xs text-[var(--text-primary)]">
                                                    {i + 1}. {r.label || effectiveSteps[i]?.value}
                                                </span>
                                                <span className="text-xs font-semibold tabular-nums text-[var(--text-primary)]">
                                                    {fmt(r.visitors)} <span className="text-[var(--text-tertiary)] font-medium">({pct}%)</span>
                                                </span>
                                            </div>
                                            <div className="h-[10px] rounded bg-[var(--bg-tertiary)] overflow-hidden">
                                                <div className="h-full" style={{ width: `${pct}%`, background: paletteAt(i) }} />
                                            </div>
                                            {prev != null && drop > 0 && (
                                                <div className="text-[11px] text-[var(--error-ink)] mt-[3px]">
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

// ── Journeys ─────────────────────────────────────────────────────────

function JourneyPanel({ scope, onDrill }: JourneyPanelProps) {
    const { t } = useTranslation();
    const [depth, setDepth] = useState(3);
    const { payload, loading, error, reload } = useAnalyticsQuery<Listish<JourneyRow>>('report', 'journey', scope, {
        body: { steps: depth },
    });
    const journeys = readJourneys(payload);

    return (
        <Card title={t('cms_site.analytics.behavior.journeys', 'Common journeys')} icon={GitBranch} action={
            <select value={depth} onChange={(e) => setDepth(Number(e.target.value))} className="bg-[var(--bg-primary)] text-[var(--text-primary)] border border-[var(--border-default)] rounded-md py-1 px-2 text-[11px]">
                {[3, 4, 5, 6, 7].map(n => <option key={n} value={n}>{t('cms_site.analytics.behavior.steps_count', '{n} steps', { n })}</option>)}
            </select>
        }>
            {loading ? <Skeleton height={220} />
                : error ? <ErrorNote message={error} onRetry={reload} compact />
                : journeys.length === 0 ? <Empty text={t('cms_site.analytics.behavior.journeys_empty', 'Not enough multi-page sessions in this period to build journeys.')} />
                : (
                    <div className="flex flex-col gap-2.5">
                        {journeys.slice(0, 15).map((j, i) => (
                            <div key={i} className="py-2 px-2.5 rounded-lg bg-[var(--bg-tertiary)]">
                                <div className="flex items-center gap-1.5 flex-wrap mb-1">
                                    {j.path.map((step, k) => (
                                        <React.Fragment key={k}>
                                            {k > 0 && <span className="text-[var(--text-tertiary)] text-[11px]">→</span>}
                                            <button
                                                onClick={() => step && onDrill('path', step)}
                                                className="bg-transparent border-0 p-0 cursor-pointer text-xs text-[var(--text-primary)]"
                                            >{step || t('cms_site.analytics.behavior.exit', '(exit)')}</button>
                                        </React.Fragment>
                                    ))}
                                </div>
                                <span className="text-[11px] font-semibold tabular-nums text-[var(--text-primary)]">{t('cms_site.analytics.behavior.sessions_count', '{n} sessions', { n: fmt(j.count) })}</span>
                            </div>
                        ))}
                    </div>
                )}
        </Card>
    );
}

// ── Retention ────────────────────────────────────────────────────────

function RetentionPanel({ scope }: RetentionPanelProps) {
    const { t } = useTranslation();
    const { payload, loading, error, reload } = useAnalyticsQuery<Listish<RetentionRow>>('report', 'retention', scope);
    const cohorts = readRetention(payload);
    const maxDay = Math.min(10, Math.max(0, ...cohorts.flatMap(c => [...c.days.keys()])));

    if (loading) return <Card title={t('cms_site.analytics.behavior.retention', 'Retention')}><Skeleton height={240} /></Card>;
    if (error) return <Card title={t('cms_site.analytics.behavior.retention', 'Retention')}><ErrorNote message={error} onRetry={reload} compact /></Card>;
    if (!cohorts.length) {
        return <Card title={t('cms_site.analytics.behavior.retention', 'Retention')} icon={Repeat}><Empty text={t('cms_site.analytics.behavior.retention_empty', 'No returning-visitor data for this period yet.')} /></Card>;
    }

    return (
        <Card title={t('cms_site.analytics.behavior.retention', 'Retention')} icon={Repeat}>
            <div className="overflow-x-auto">
                <table className="[border-collapse:separate] [border-spacing:2px] text-[11px]">
                    <thead>
                        <tr>
                            <th className="text-left text-[var(--text-tertiary)] font-semibold py-0.5 px-1.5">{t('cms_site.analytics.behavior.cohort', 'Cohort')}</th>
                            <th className="text-right text-[var(--text-tertiary)] font-semibold py-0.5 px-1.5">{t('cms_site.analytics.behavior.visitors', 'Visitors')}</th>
                            {Array.from({ length: maxDay + 1 }, (_, d) => (
                                <th key={d} className="text-[var(--text-tertiary)] font-semibold py-0.5 px-1.5 min-w-[38px]">D{d}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {cohorts.slice(0, 14).map(c => (
                            <tr key={c.cohort}>
                                <td className="text-[var(--text-primary)] py-0.5 px-1.5 whitespace-nowrap">
                                    {String(c.cohort).slice(0, 10)}
                                </td>
                                <td className="text-[var(--text-tertiary)] py-0.5 px-1.5 text-right">{fmt(c.visitors)}</td>
                                {Array.from({ length: maxDay + 1 }, (_, d) => {
                                    const pct = c.days.get(d);
                                    const heat = pct == null ? 0 : Math.max(0, Math.min(1, pct / 100));
                                    return (
                                        <td key={d} title={pct == null ? '' : `${Math.round(pct)}%`}
                                            className={`rounded px-1.5 py-1 text-center font-semibold tabular-nums ${pct == null ? 'text-[var(--text-tertiary)]' : heat > 0.45 ? 'text-white' : 'text-[var(--text-primary)]'}`}
                                            style={pct == null ? undefined : { background: tint('var(--chart-1)', Math.round(12 + heat * 75)) }}>
                                            {pct == null ? '·' : `${Math.round(pct)}%`}
                                        </td>
                                    );
                                })}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </Card>
    );
}

// ── Goals ────────────────────────────────────────────────────────────

function GoalsPanel({ scope }: GoalsPanelProps) {
    const { t } = useTranslation();
    const [goal, setGoal] = useState<{ type: string; value: string; } | null>(null);
    const pages = useAnalyticsQuery<XYRow[]>('query', 'metrics', scope, { params: { type: 'path', limit: 20 } });
    const events = useAnalyticsQuery<XYRow[]>('query', 'metrics', scope, { params: { type: 'event', limit: 20 } });

    const result = useAnalyticsQuery<GoalPayload>('report', 'goal', scope, {
        body: goal ? { type: goal.type, value: goal.value } : undefined,
        enabled: !!goal,
    });

    const options = [
        ...(Array.isArray(pages.payload) ? pages.payload : []).map(p => ({ type: 'path', value: p.x })),
        ...(Array.isArray(events.payload) ? events.payload : []).map(p => ({ type: 'event', value: p.x })),
    ];

    // Umami answers { num, total }: num = visitors who reached the goal,
    // total = visitors in the period. Reading `count` first — a key that does
    // not exist — fell through to `total` and printed the DENOMINATOR as the
    // conversion count, so every goal looked like it converted everyone.
    const raw = result.payload;
    const reached = raw && typeof raw === 'object' && raw.num != null ? Number(raw.num)
        : typeof raw === 'number' ? raw
        : null;
    const audience = raw && typeof raw === 'object' && raw.total != null ? Number(raw.total) : null;
    const rate = reached != null && audience ? (reached / audience) * 100 : null;

    return (
        <Card title={t('cms_site.analytics.behavior.goal_title', 'Goal conversion')} icon={Target}>
            <div className="flex flex-col gap-3">
                <select
                    value={goal ? `${goal.type}:${goal.value}` : ''}
                    onChange={(e) => {
                        const v = e.target.value;
                        if (!v) return setGoal(null);
                        const [type, ...rest] = v.split(':');
                        setGoal({ type, value: rest.join(':') });
                    }}
                    className="bg-[var(--bg-primary)] text-[var(--text-primary)] border border-[var(--border-default)] rounded-lg py-[7px] px-2.5 text-xs max-w-[340px]"
                >
                    <option value="">{t('cms_site.analytics.behavior.goal_choose', 'Choose a page or event as the goal…')}</option>
                    {options.map((o, i) => (
                        <option key={i} value={`${o.type}:${o.value}`}>{o.type}: {o.value}</option>
                    ))}
                </select>

                {!goal ? <Empty text={t('cms_site.analytics.behavior.goal_pick', 'Pick a goal to see how many visitors reached it.')} />
                    : result.loading ? <Skeleton height={80} />
                    : result.error ? <ErrorNote message={result.error} onRetry={result.reload} compact />
                    : (
                        <div>
                            <div className="flex items-baseline gap-2.5 flex-wrap">
                                <span className="text-[28px] font-semibold leading-tight tabular-nums text-[var(--text-primary)]">
                                    {reached == null ? '—' : fmt(reached)}
                                </span>
                                {rate != null && (
                                    <span className="text-sm font-semibold text-[var(--text-secondary)]">
                                        {t('cms_site.analytics.behavior.goal_rate', '{rate}% of {total}', { rate: rate.toFixed(1), total: fmt(audience ?? 0) })}
                                    </span>
                                )}
                            </div>
                            <div className="text-xs text-[var(--text-tertiary)]">
                                {goal.type === 'event'
                                    ? t('cms_site.analytics.behavior.goal_reached_event', 'visitors reached the event “{value}”', { value: goal.value })
                                    : t('cms_site.analytics.behavior.goal_reached_page', 'visitors reached the page “{value}”', { value: goal.value })}
                            </div>
                        </div>
                    )}
            </div>
        </Card>
    );
}
