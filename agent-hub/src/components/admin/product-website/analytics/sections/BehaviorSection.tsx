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
import { Empty, fmt, paletteAt } from '../ui';
import { Card, ErrorNote, Skeleton } from '../AsyncCard';
import { ACCENT } from '../BarList';
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
        <div className="[display:flex] [flex-direction:column] [gap:14px]">
            <div className="[display:flex] [gap:6px] [flex-wrap:wrap]">
                {TABS.map(tb => {
                    const Icon = tb.icon;
                    const active = tb.id === tab;
                    return (
                        <button key={tb.id} onClick={() => setTab(tb.id)} style={{
                            display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px',
                            borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 700,
                            background: active ? `${ACCENT}14` : 'var(--bg-secondary, #1a1a2e)',
                            border: `1px solid ${active ? `${ACCENT}66` : 'var(--border-default, rgba(255,255,255,0.1))'}`,
                            color: active ? ACCENT : 'var(--text-muted, #888)',
                        }}>
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
        <div className="[display:flex] [flex-direction:column] [gap:14px]">
            <Card title={t('cms_site.analytics.behavior.funnel_build', 'Build a funnel')} icon={Filter} action={
                isDefault ? (
                    <span className="[font-size:10px] [color:var(--text-muted,#777)]">
                        {t('cms_site.analytics.behavior.funnel_suggested', 'suggested — edit the steps to make it yours')}
                    </span>
                ) : null
            }>
                <div className="[display:flex] [flex-direction:column] [gap:10px]">
                    {effectiveSteps.map((s, i) => (
                        <div key={i} className="[display:flex] [align-items:center] [gap:8px] [padding:7px_10px] [border-radius:8px] [background:var(--bg-tertiary,rgba(255,255,255,0.03))]">
                            <span style={{
                                width: 20, height: 20, borderRadius: 99, flexShrink: 0, fontSize: 11, fontWeight: 800,
                                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                background: `${paletteAt(i)}22`, color: paletteAt(i),
                            }}>{i + 1}</span>
                            <span className="[font-size:12px] [color:var(--text-muted,#888)]">{s.type}</span>
                            <span className="[font-size:12px] [color:var(--text-primary,#fff)] [flex:1]">{s.value}</span>
                            <button onClick={() => setStepsFrom(list => list.filter((_, j) => j !== i))}
                                aria-label={t('cms_site.analytics.behavior.remove_step', 'Remove step {n}', { n: i + 1 })}
                                className="[background:transparent] [border:none] [color:var(--text-muted,#888)] [cursor:pointer]">
                                <X className="w-[13px] h-[13px]" />
                            </button>
                        </div>
                    ))}

                    <div className="[display:flex] [align-items:center] [gap:8px]">
                        <Plus style={{ width: 13, height: 13, color: ACCENT }} />
                        <select
                            value=""
                            onChange={(e) => { addStep(e.target.value); e.target.value = ''; }}
                            className="[background:var(--bg-primary,#0f0f1a)] [color:var(--text-primary,#fff)] [border:1px_solid_var(--border-default,rgba(255,255,255,0.12))] [border-radius:8px] [padding:7px_10px] [font-size:12px] min-w-[260px]"
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
                            <button onClick={() => setSteps([])} className="[background:transparent] [border:1px_solid_var(--border-default,rgba(255,255,255,0.12))] [border-radius:8px] [padding:6px_10px] [font-size:12px] [color:var(--text-muted,#888)] [cursor:pointer]">{t('cms_site.analytics.behavior.clear', 'Clear')}</button>
                        )}
                    </div>
                    {!ready && (
                        <p className="[font-size:11px] [color:var(--text-muted,#777)] [margin:0]">
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
                        <span className="[font-size:12px] [color:var(--text-muted,#888)]">
                            <strong style={{ color: ACCENT, fontSize: 15 }}>{conversion.toFixed(1)}%</strong>
                            {' '}{t('cms_site.analytics.behavior.made_it', 'made it all the way through')}
                        </span>
                    ) : null
                }>
                    {funnel.loading ? <Skeleton height={200} />
                        : funnel.error ? <ErrorNote message={funnel.error} onRetry={funnel.reload} compact />
                        : rows.length === 0 ? <Empty text={t('cms_site.analytics.behavior.funnel_empty', 'No visitors completed this path in the selected period.')} />
                        : (
                            <div className="[display:flex] [flex-direction:column] [gap:12px]">
                                {rows.map((r, i) => {
                                    const pct = top > 0 ? Math.round((r.visitors / top) * 100) : 0;
                                    const prev = i > 0 ? rows[i - 1].visitors : null;
                                    const drop = prev ? prev - r.visitors : 0;
                                    return (
                                        <div key={i}>
                                            <div className="[display:flex] [justify-content:space-between] [gap:10px] [margin-bottom:4px]">
                                                <span className="[font-size:12px] [color:var(--text-primary,#fff)]">
                                                    {i + 1}. {r.label || effectiveSteps[i]?.value}
                                                </span>
                                                <span style={{ fontSize: 12, fontWeight: 700, color: ACCENT }}>
                                                    {fmt(r.visitors)} <span className="[color:var(--text-muted,#888)] [font-weight:500]">({pct}%)</span>
                                                </span>
                                            </div>
                                            <div className="h-[10px] [border-radius:5px] [background:var(--bg-tertiary,rgba(255,255,255,0.06))] [overflow:hidden]">
                                                <div style={{ width: `${pct}%`, height: '100%', background: paletteAt(i) }} />
                                            </div>
                                            {prev != null && drop > 0 && (
                                                <div className="[font-size:11px] [color:#f87171] [margin-top:3px]">
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
            <select value={depth} onChange={(e) => setDepth(Number(e.target.value))} className="[background:var(--bg-primary,#0f0f1a)] [color:var(--text-primary,#fff)] [border:1px_solid_var(--border-default,rgba(255,255,255,0.12))] [border-radius:7px] [padding:4px_8px] [font-size:11px]">
                {[3, 4, 5, 6, 7].map(n => <option key={n} value={n}>{t('cms_site.analytics.behavior.steps_count', '{n} steps', { n })}</option>)}
            </select>
        }>
            {loading ? <Skeleton height={220} />
                : error ? <ErrorNote message={error} onRetry={reload} compact />
                : journeys.length === 0 ? <Empty text={t('cms_site.analytics.behavior.journeys_empty', 'Not enough multi-page sessions in this period to build journeys.')} />
                : (
                    <div className="[display:flex] [flex-direction:column] [gap:10px]">
                        {journeys.slice(0, 15).map((j, i) => (
                            <div key={i} className="[padding:8px_10px] [border-radius:8px] [background:var(--bg-tertiary,rgba(255,255,255,0.03))]">
                                <div className="[display:flex] [align-items:center] [gap:6px] [flex-wrap:wrap] [margin-bottom:4px]">
                                    {j.path.map((step, k) => (
                                        <React.Fragment key={k}>
                                            {k > 0 && <span className="[color:var(--text-muted,#666)] [font-size:11px]">→</span>}
                                            <button
                                                onClick={() => step && onDrill('path', step)}
                                                className="[background:transparent] [border:none] [padding:0] [cursor:pointer] [font-size:12px] [color:var(--text-primary,#fff)]"
                                            >{step || t('cms_site.analytics.behavior.exit', '(exit)')}</button>
                                        </React.Fragment>
                                    ))}
                                </div>
                                <span style={{ fontSize: 11, fontWeight: 700, color: ACCENT }}>{t('cms_site.analytics.behavior.sessions_count', '{n} sessions', { n: fmt(j.count) })}</span>
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
            <div className="[overflow-x:auto]">
                <table className="[border-collapse:separate] [border-spacing:2px] [font-size:11px]">
                    <thead>
                        <tr>
                            <th className="[text-align:left] [color:var(--text-muted,#888)] [font-weight:600] [padding:2px_6px]">{t('cms_site.analytics.behavior.cohort', 'Cohort')}</th>
                            <th className="[text-align:right] [color:var(--text-muted,#888)] [font-weight:600] [padding:2px_6px]">{t('cms_site.analytics.behavior.visitors', 'Visitors')}</th>
                            {Array.from({ length: maxDay + 1 }, (_, d) => (
                                <th key={d} className="[color:var(--text-muted,#888)] [font-weight:600] [padding:2px_6px] min-w-[38px]">D{d}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {cohorts.slice(0, 14).map(c => (
                            <tr key={c.cohort}>
                                <td className="[color:var(--text-primary,#fff)] [padding:2px_6px] [white-space:nowrap]">
                                    {String(c.cohort).slice(0, 10)}
                                </td>
                                <td className="[color:var(--text-muted,#999)] [padding:2px_6px] [text-align:right]">{fmt(c.visitors)}</td>
                                {Array.from({ length: maxDay + 1 }, (_, d) => {
                                    const pct = c.days.get(d);
                                    const heat = pct == null ? 0 : Math.max(0, Math.min(1, pct / 100));
                                    return (
                                        <td key={d} title={pct == null ? '' : `${Math.round(pct)}%`} style={{
                                            textAlign: 'center', padding: '4px 6px', borderRadius: 4,
                                            background: pct == null ? 'transparent' : `rgba(20,184,166,${0.12 + heat * 0.75})`,
                                            color: pct == null ? 'var(--text-muted, #555)' : '#fff', fontWeight: 700,
                                        }}>
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
            <div className="[display:flex] [flex-direction:column] [gap:12px]">
                <select
                    value={goal ? `${goal.type}:${goal.value}` : ''}
                    onChange={(e) => {
                        const v = e.target.value;
                        if (!v) return setGoal(null);
                        const [type, ...rest] = v.split(':');
                        setGoal({ type, value: rest.join(':') });
                    }}
                    className="[background:var(--bg-primary,#0f0f1a)] [color:var(--text-primary,#fff)] [border:1px_solid_var(--border-default,rgba(255,255,255,0.12))] [border-radius:8px] [padding:7px_10px] [font-size:12px] max-w-[340px]"
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
                            <div className="[display:flex] [align-items:baseline] [gap:10px] [flex-wrap:wrap]">
                                <span style={{ fontSize: 28, fontWeight: 800, color: ACCENT, lineHeight: 1.1 }}>
                                    {reached == null ? '—' : fmt(reached)}
                                </span>
                                {rate != null && (
                                    <span className="[font-size:14px] [font-weight:700] [color:var(--text-secondary,#aaa)]">
                                        {t('cms_site.analytics.behavior.goal_rate', '{rate}% of {total}', { rate: rate.toFixed(1), total: fmt(audience ?? 0) })}
                                    </span>
                                )}
                            </div>
                            <div className="[font-size:12px] [color:var(--text-muted,#888)]">
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
