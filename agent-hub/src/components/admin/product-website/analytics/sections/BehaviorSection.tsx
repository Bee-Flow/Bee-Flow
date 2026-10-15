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
import { useTranslation } from '../../../../../hooks/useTranslation';
import { ACCENT, PALETTE, Card, Empty, ErrorNote, Skeleton, fmt, paletteAt } from '../ui';
import type { IconType } from '../ui';
import type { AnalyticsScope } from '../../analyticsApi';
import { useAnalyticsQuery } from '../useAnalyticsQuery';

import type { Tab, MetricRow, StepSpec, FunnelPayload, JourneyPayload, RetentionPayload, CohortAcc, GoalPayload } from './BehaviorSection.types';
import { FunnelPanel } from './BehaviorFunnel';
const TABS: Array<{ id: Tab; labelKey: string; label: string; icon: IconType }> = [
    { id: 'funnel', labelKey: 'cms_site.analytics.behavior.tab_funnel', label: 'Funnel', icon: Filter },
    { id: 'journey', labelKey: 'cms_site.analytics.behavior.tab_journeys', label: 'Journeys', icon: GitBranch },
    { id: 'retention', labelKey: 'cms_site.analytics.behavior.tab_retention', label: 'Retention', icon: Repeat },
    { id: 'goals', labelKey: 'cms_site.analytics.behavior.tab_goals', label: 'Goals', icon: Target },
];

export default function BehaviorSection({ scope, onDrill }: { scope: AnalyticsScope; onDrill: (kind: string, value: string) => void }) {
    const { t } = useTranslation();
    const [tab, setTab] = useState<Tab>('funnel');
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
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
                            <Icon style={{ width: 13, height: 13 }} /> {t(tb.labelKey, tb.label)}
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

// ── Journeys ─────────────────────────────────────────────────────────

function readJourneys(payload: JourneyPayload) {
    const rows = Array.isArray(payload) ? payload : (Array.isArray(payload?.data) ? payload.data : []);
    return rows.map(r => ({
        path: Array.isArray(r.items) ? r.items : (Array.isArray(r.path) ? r.path : []),
        count: Number(r.count ?? r.y ?? r.visitors ?? 0),
    })).filter(r => r.path.length > 0);
}

function JourneyPanel({ scope, onDrill }: { scope: AnalyticsScope; onDrill: (kind: string, value: string) => void }) {
    const { t } = useTranslation();
    const [depth, setDepth] = useState<number>(3);
    const { payload, loading, error, reload } = useAnalyticsQuery<JourneyPayload>('report', 'journey', scope, {
        body: { steps: depth },
    });
    const journeys = readJourneys(payload);

    return (
        <Card title={t('cms_site.analytics.behavior.journeys', 'Common journeys')} icon={GitBranch} action={
            <select value={depth} onChange={(e) => setDepth(Number(e.target.value))} style={{
                background: 'var(--bg-primary, #0f0f1a)', color: 'var(--text-primary, #fff)',
                border: '1px solid var(--border-default, rgba(255,255,255,0.12))',
                borderRadius: 7, padding: '4px 8px', fontSize: 11,
            }}>
                {[3, 4, 5, 6, 7].map(n => <option key={n} value={n}>{t('cms_site.analytics.behavior.steps_count', '{n} steps', { n })}</option>)}
            </select>
        }>
            {loading ? <Skeleton height={220} />
                : error ? <ErrorNote message={error} onRetry={reload} compact />
                : journeys.length === 0 ? <Empty text={t('cms_site.analytics.behavior.journeys_empty', 'Not enough multi-page sessions in this period to build journeys.')} />
                : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        {journeys.slice(0, 15).map((j, i) => (
                            <div key={i} style={{ padding: '8px 10px', borderRadius: 8, background: 'var(--bg-tertiary, rgba(255,255,255,0.03))' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 4 }}>
                                    {j.path.map((step, k) => (
                                        <React.Fragment key={k}>
                                            {k > 0 && <span style={{ color: 'var(--text-muted, #666)', fontSize: 11 }}>→</span>}
                                            <button
                                                onClick={() => step && onDrill('path', step)}
                                                style={{
                                                    background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
                                                    fontSize: 12, color: 'var(--text-primary, #fff)',
                                                }}
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

function readRetention(payload: RetentionPayload) {
    const rows = Array.isArray(payload) ? payload : (Array.isArray(payload?.data) ? payload.data : []);
    const byCohort = new Map<string, CohortAcc>();
    for (const r of rows) {
        const cohort = r.date ?? r.cohort ?? '';
        const day = Number(r.day ?? r.offset ?? 0);
        const pct = r.percentage != null ? Number(r.percentage)
            : (r.visitors && r.returnVisitors != null ? (Number(r.returnVisitors) / Number(r.visitors)) * 100 : null);
        if (!cohort) continue;
        if (!byCohort.has(cohort)) byCohort.set(cohort, { cohort, visitors: Number(r.visitors ?? 0), days: new Map() });
        (byCohort.get(cohort) as CohortAcc).days.set(day, pct);
    }
    return [...byCohort.values()];
}

function RetentionPanel({ scope }: { scope: AnalyticsScope }) {
    const { t } = useTranslation();
    const { payload, loading, error, reload } = useAnalyticsQuery<RetentionPayload>('report', 'retention', scope);
    const cohorts = readRetention(payload);
    const maxDay = Math.min(10, Math.max(0, ...cohorts.flatMap(c => [...c.days.keys()])));

    if (loading) return <Card title={t('cms_site.analytics.behavior.retention', 'Retention')}><Skeleton height={240} /></Card>;
    if (error) return <Card title={t('cms_site.analytics.behavior.retention', 'Retention')}><ErrorNote message={error} onRetry={reload} compact /></Card>;
    if (!cohorts.length) {
        return <Card title={t('cms_site.analytics.behavior.retention', 'Retention')} icon={Repeat}><Empty text={t('cms_site.analytics.behavior.retention_empty', 'No returning-visitor data for this period yet.')} /></Card>;
    }

    return (
        <Card title={t('cms_site.analytics.behavior.retention', 'Retention')} icon={Repeat}>
            <div style={{ overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'separate', borderSpacing: 2, fontSize: 11 }}>
                    <thead>
                        <tr>
                            <th style={{ textAlign: 'left', color: 'var(--text-muted, #888)', fontWeight: 600, padding: '2px 6px' }}>{t('cms_site.analytics.behavior.cohort', 'Cohort')}</th>
                            <th style={{ textAlign: 'right', color: 'var(--text-muted, #888)', fontWeight: 600, padding: '2px 6px' }}>{t('cms_site.analytics.behavior.visitors', 'Visitors')}</th>
                            {Array.from({ length: maxDay + 1 }, (_, d) => (
                                <th key={d} style={{ color: 'var(--text-muted, #888)', fontWeight: 600, padding: '2px 6px', minWidth: 38 }}>D{d}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {cohorts.slice(0, 14).map(c => (
                            <tr key={c.cohort}>
                                <td style={{ color: 'var(--text-primary, #fff)', padding: '2px 6px', whiteSpace: 'nowrap' }}>
                                    {String(c.cohort).slice(0, 10)}
                                </td>
                                <td style={{ color: 'var(--text-muted, #999)', padding: '2px 6px', textAlign: 'right' }}>{fmt(c.visitors)}</td>
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

function GoalsPanel({ scope }: { scope: AnalyticsScope }) {
    const { t } = useTranslation();
    const [goal, setGoal] = useState<{ type: string; value: string } | null>(null);
    const pages = useAnalyticsQuery<MetricRow[]>('query', 'metrics', scope, { params: { type: 'path', limit: 20 } });
    const events = useAnalyticsQuery<MetricRow[]>('query', 'metrics', scope, { params: { type: 'event', limit: 20 } });

    const result = useAnalyticsQuery<GoalPayload | number | null>('report', 'goal', scope, {
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
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <select
                    value={goal ? `${goal.type}:${goal.value}` : ''}
                    onChange={(e) => {
                        const v = e.target.value;
                        if (!v) return setGoal(null);
                        const [type, ...rest] = v.split(':');
                        setGoal({ type, value: rest.join(':') });
                    }}
                    style={{
                        background: 'var(--bg-primary, #0f0f1a)', color: 'var(--text-primary, #fff)',
                        border: '1px solid var(--border-default, rgba(255,255,255,0.12))',
                        borderRadius: 8, padding: '7px 10px', fontSize: 12, maxWidth: 340,
                    }}
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
                            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                                <span style={{ fontSize: 28, fontWeight: 800, color: ACCENT, lineHeight: 1.1 }}>
                                    {reached == null ? '—' : fmt(reached)}
                                </span>
                                {rate != null && (
                                    <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-secondary, #aaa)' }}>
                                        {t('cms_site.analytics.behavior.goal_rate', '{rate}% of {total}', { rate: rate.toFixed(1), total: fmt(audience) })}
                                    </span>
                                )}
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--text-muted, #888)' }}>
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
