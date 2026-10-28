import { useMemo } from 'react';
import {
    Zap, BarChart3, Clock, DollarSign, Cpu, Bot, Wrench, TrendingUp, Database, Brain
} from 'lucide-react';
import { fmtDuration, MetricCard, Card, AgentRow, type ChartPoint, type ModelUsage, type ToolUsage, type UsageRecord, type UsageSummary } from './shared';
import { DonutChart } from './shared/DonutChart';
import { fmtCost, MODEL_COLORS, ModelRow, shortModel } from './shared/ModelRow';
import { fmt, COLORS, Empty, SvgAreaChart } from './shared/SvgAreaChart';
import type { ModelRate } from './drawer/drawerTypes';
import { useTranslation } from '@/hooks/useTranslation';

export interface UsageDeltas {
    calls?: number | null;
    tokens?: number | null;
    cost?: number | null;
    latency?: number | null;
}

interface OverviewPageProps {
    summary: UsageSummary | null;
    prevSummary?: UsageSummary | null;
    deltas: UsageDeltas;
    byModel: ModelUsage[];
    byAgent: UsageRecord[];
    timeline: ChartPoint[];
    costTimeline: ChartPoint[];
    tools: ToolUsage[];
    deltaLabel: string;
    totalCost: number;
    costPerModel: Record<string, number>;
    modelCosts: Record<string, ModelRate>;
    range: string;
    onSelectModel?: (model: UsageRecord) => void;
    onSelectAgent?: (agent: UsageRecord) => void;
    onNavigate?: (value: string) => void;
}

export function OverviewPage({
    summary, prevSummary, deltas, deltaLabel,
    byModel, byAgent, timeline, costTimeline, tools,
    totalCost, costPerModel, modelCosts, range,
    onSelectModel, onSelectAgent, onNavigate
}: OverviewPageProps) {
    const { t } = useTranslation();
    const modelsWithCost = byModel.filter((m) => costPerModel[m.model]);

    // Donut data: top 5 models by cost + "Other"
    const donutItems = useMemo(() => {
        const sorted = [...byModel]
            .filter(m => costPerModel[m.model])
            .sort((a, b) => (costPerModel[b.model] || 0) - (costPerModel[a.model] || 0));
        const top = sorted.slice(0, 5);
        const otherCost = sorted.slice(5).reduce((s, m) => s + (costPerModel[m.model] || 0), 0);
        const items = top.map((m, i) => ({
            label: shortModel(m.model),
            value: costPerModel[m.model] || 0,
            color: MODEL_COLORS[i % MODEL_COLORS.length],
        }));
        if (otherCost > 0) items.push({ label: t('admin_monitoring.overview_other', 'Other'), value: otherCost, color: '#64748b' });
        return items;
    }, [byModel, costPerModel, t]);

    return (
        <div className="[animation:fadeIn_0.3s_ease]">
            {/* ── KPI Cards ── */}
            <div className="[display:grid] [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))] [gap:14px] [margin-bottom:1.5rem]">
                <MetricCard
                    icon={Zap} label={t('admin_monitoring.overview_total_calls', 'Total Calls')} color={COLORS.primary}
                    value={fmt(summary?.total_calls || 0)}
                    delta={deltas?.calls} deltaLabel={deltaLabel}
                />
                <MetricCard
                    icon={BarChart3} label={t('admin_monitoring.overview_total_tokens', 'Total Tokens')} color={COLORS.green}
                    value={fmt(summary?.total_tokens || 0)}
                    delta={deltas?.tokens} deltaLabel={deltaLabel}
                />
                {(() => {
                    const rawCost = summary?.total_estimated_cost || totalCost || 0;
                    const billed = Number(summary?.total_billed_cost || 0);
                    const isPayg = billed > 0;
                    return (
                        <MetricCard
                            icon={DollarSign}
                            label={isPayg ? t('admin_monitoring.overview_billed_payg', 'Billed (PAYG)') : t('admin_monitoring.overview_est_cost', 'Est. Cost')}
                            color={isPayg ? COLORS.green : COLORS.amber}
                            value={fmtCost(isPayg ? billed : rawCost)}
                            subtitle={isPayg ? t('admin_monitoring.overview_raw_markup', 'raw {cost} · markup applied', { cost: fmtCost(rawCost) }) : undefined}
                            delta={deltas?.cost} deltaLabel={deltaLabel}
                        />
                    );
                })()}
                <MetricCard
                    icon={Clock} label={t('admin_monitoring.overview_avg_latency', 'Avg Latency')} color={COLORS.pink}
                    value={fmtDuration(summary?.avg_duration_ms)}
                    delta={deltas?.latency}
                    deltaLabel={deltas?.latency != null ? (deltas.latency > 0 ? 'slower' : 'faster') : deltaLabel}
                />
            </div>
            {/* ── Cache & reasoning row (only render if either is non-zero) ── */}
            {((summary?.total_cached_tokens || 0) > 0 || (summary?.total_reasoning_tokens || 0) > 0) && (
                <div className="[display:grid] [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))] [gap:14px] [margin-bottom:1.5rem]">
                    <MetricCard
                        icon={Database} label={t('admin_monitoring.overview_cached_tokens', 'Cached Tokens')} color={COLORS.green}
                        value={fmt(summary?.total_cached_tokens || 0)}
                        deltaLabel={(summary?.total_cache_creation_tokens || 0) > 0
                            ? t('admin_monitoring.overview_cache_written', '+ {n} written', { n: fmt(summary?.total_cache_creation_tokens) })
                            : t('admin_monitoring.overview_cache_hits', 'cache hits')}
                    />
                    <MetricCard
                        icon={Brain} label={t('admin_monitoring.overview_reasoning_tokens', 'Reasoning Tokens')} color={COLORS.primary}
                        value={fmt(summary?.total_reasoning_tokens || 0)}
                        deltaLabel={t('admin_monitoring.overview_reasoning_hint', 'o-series / thinking')}
                    />
                </div>
            )}

            {/* ── Timeline Charts ── */}
            <div className="[display:grid] [grid-template-columns:1fr_1fr] [gap:14px] [margin-bottom:1.25rem]">
                <Card title={t('admin_monitoring.overview_token_trend', 'Token Trend')} icon={TrendingUp}>
                    <SvgAreaChart
                        data={timeline} yKey="total_tokens" color={COLORS.primary}
                        formatY={fmt}
                        formatLabel={d => `${d.period || ''} · ${d.calls || 0} calls`}
                    />
                </Card>
                <Card title={Number(summary?.total_billed_cost || 0) > 0 ? t('admin_monitoring.overview_billed_trend', 'Billed Cost Trend (PAYG)') : t('admin_monitoring.overview_cost_trend', 'Cost Trend')} icon={DollarSign}>
                    <SvgAreaChart
                        data={costTimeline}
                        yKey={Number(summary?.total_billed_cost || 0) > 0 ? 'total_billed_cost' : 'total_cost'}
                        color={Number(summary?.total_billed_cost || 0) > 0 ? COLORS.green : COLORS.amber}
                        formatY={fmtCost}
                        formatLabel={d => Number(summary?.total_billed_cost || 0) > 0
                            ? t('admin_monitoring.overview_trend_billed_raw', '{period} · {billed} billed · {raw} raw', { period: d.period || '', billed: fmtCost(d.total_billed_cost || 0), raw: fmtCost(d.total_cost || 0) })
                            : `${d.period || ''} · ${fmtCost(d.total_cost || 0)}`}
                    />
                </Card>
            </div>

            {/* ── Two columns: Top Models + Top Agents ── */}
            <div className="[display:grid] [grid-template-columns:1fr_1fr] [gap:14px] [margin-bottom:1.25rem]">
                <Card title={t('admin_monitoring.overview_top_models', 'Top Models')} icon={Cpu}>
                    {byModel.length === 0 ? <Empty text={t('admin_monitoring.overview_no_model_data', 'No model data')} /> : byModel.slice(0, 5).map((m, i) => (
                        <div key={i} onClick={() => onSelectModel?.(m)} className="[cursor:pointer]">
                            <ModelRow model={m} index={i} maxTokens={Math.max(...byModel.map(m => m.total_tokens || 0), 1)} cost={costPerModel[m.model]} />
                        </div>
                    ))}
                </Card>
                <Card title={t('admin_monitoring.overview_top_agents', 'Top Agents')} icon={Bot}>
                    {byAgent.length === 0 ? <Empty text={t('admin_monitoring.overview_no_agent_data', 'No agent data')} /> : byAgent.slice(0, 5).map((a, i) => (
                        <div key={i} onClick={() => onSelectAgent?.(a)} className="[cursor:pointer]">
                            <AgentRow agent={a} index={i} />
                        </div>
                    ))}
                </Card>
            </div>

            {/* ── Cost Breakdown + Tools ── */}
            <div className="[display:grid] [grid-template-columns:1fr_1fr] [gap:14px]">
                {/* Cost donut */}
                <Card
                    title={t('admin_monitoring.overview_cost_breakdown', 'Cost Breakdown')}
                    icon={DollarSign}
                    action={onNavigate && (
                        <button
                            onClick={() => onNavigate('admin/ai-config')}
                            style={{
                                padding: '4px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 600,
                                background: 'rgba(245, 158, 11, 0.1)', color: COLORS.amber,
                                border: '1px solid rgba(245, 158, 11, 0.2)', cursor: 'pointer',
                            }}
                        >
                            ⚙️ {t('admin_monitoring.overview_model_costs', 'Model Costs')}
                        </button>
                    )}
                >
                    {donutItems.length === 0 ? (
                        <Empty text={t('admin_monitoring.overview_no_cost_data', 'No cost data: configure model pricing in AI Config')} />
                    ) : (
                        <div className="[display:flex] [flex-direction:column] [gap:12px]">
                            <DonutChart items={donutItems} centerLabel={t('admin_monitoring.overview_total', 'Total')} centerValue={fmtCost(totalCost)} />
                            {modelsWithCost.length < byModel.length && (
                                <div className="[font-size:11px] [color:var(--text-muted,#666)] [padding:6px_0]">
                                    ℹ️ {byModel.length - modelsWithCost.length > 1 ? t('admin_monitoring.overview_no_cost_models', '{n} models without cost data', { n: byModel.length - modelsWithCost.length }) : t('admin_monitoring.overview_no_cost_model', '{n} model without cost data', { n: byModel.length - modelsWithCost.length })}
                                </div>
                            )}
                        </div>
                    )}
                </Card>

                {/* Tool usage */}
                <Card title={t('admin_monitoring.overview_tool_usage', 'Tool Usage')} icon={Wrench}>
                    {tools.length === 0 ? <Empty text={t('admin_monitoring.overview_no_tool_calls', 'No tool calls recorded')} /> : (
                        <div className="[display:flex] [gap:8px] [flex-wrap:wrap]">
                            {tools.slice(0, 15).map((t, i) => (
                                <div key={i} className="[padding:6px_12px] [border-radius:20px] [font-size:12px] [background:var(--bg-tertiary,rgba(255,255,255,0.04))] [border:1px_solid_var(--border-default,rgba(255,255,255,0.06))] [color:var(--text-secondary,#aaa)] [display:flex] [align-items:center] [gap:6px]">
                                    <span className="[font-weight:600] [color:var(--text-primary,#fff)]">{t.tool_name}</span>
                                    <span style={{
                                        background: COLORS.primary + '20', color: COLORS.primary,
                                        padding: '1px 6px', borderRadius: '10px', fontSize: '10px', fontWeight: 700,
                                    }}>{t.calls}×</span>
                                </div>
                            ))}
                        </div>
                    )}
                </Card>
            </div>
        </div>
    );
}
