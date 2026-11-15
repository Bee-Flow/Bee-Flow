import { useMemo } from 'react';
import { Info, Settings2 } from 'lucide-react';
import StatGrid from '@/components/shared/dashboard/StatGrid';
import { CHIP, QUIET_BTN } from '@/components/mcpLibrary/ui';
import { fmtDuration, MetricTile, Card, AgentRow, type ChartPoint, type ModelUsage, type ToolUsage, type UsageRecord, type UsageSummary } from './shared';
import { DonutChart } from './shared/DonutChart';
import { fmtCost, MODEL_COLORS, ModelRow, shortModel } from './shared/ModelRow';
import { fmt, SERIES, Empty, SvgAreaChart, periodLabel } from './shared/SvgAreaChart';
import { useLocaleFormat } from '@/hooks/useLocaleFormat';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';

export interface UsageDeltas {
    calls?: number | null;
    tokens?: number | null;
    cost?: number | null;
    latency?: number | null;
}

interface OverviewPageProps {
    summary: UsageSummary | null;
    deltas: UsageDeltas;
    byModel: ModelUsage[];
    byAgent: UsageRecord[];
    timeline: ChartPoint[];
    costTimeline: ChartPoint[];
    tools: ToolUsage[];
    deltaLabel: string;
    totalCost: number;
    costPerModel: Record<string, number>;
    onSelectModel?: (model: UsageRecord) => void;
    onSelectAgent?: (agent: UsageRecord) => void;
    /** Opens where the model prices are set; absent when the viewer may not open it (an organisation admin). */
    onOpenModelPrices?: () => void;
}

/** Calls, tokens, cost (billed when the org pays as it goes) and latency, each against the previous period. */
function OverviewKpis({ summary, deltas, deltaLabel, totalCost }: Pick<OverviewPageProps, 'summary' | 'deltas' | 'deltaLabel' | 'totalCost'>) {
    const { t } = useTranslation();
    const rawCost = summary?.total_estimated_cost || totalCost || 0;
    const billed = Number(summary?.total_billed_cost || 0);
    const isPayg = billed > 0;
    const latencyLabel = deltas?.latency != null
        ? (deltas.latency > 0 ? t('admin_monitoring.latency_slower', 'slower') : t('admin_monitoring.latency_faster', 'faster'))
        : deltaLabel;
    return (
        <StatGrid>
            <MetricTile label={t('admin_monitoring.overview_total_calls', 'Total calls')} value={fmt(summary?.total_calls || 0)} delta={deltas?.calls} deltaLabel={deltaLabel} />
            <MetricTile label={t('admin_monitoring.overview_total_tokens', 'Total tokens')} value={fmt(summary?.total_tokens || 0)} delta={deltas?.tokens} deltaLabel={deltaLabel} />
            <MetricTile
                label={isPayg ? t('admin_monitoring.overview_billed_payg', 'Billed (PAYG)') : t('admin_monitoring.overview_est_cost', 'Est. cost')}
                value={fmtCost(isPayg ? billed : rawCost)}
                subtitle={isPayg ? t('admin_monitoring.overview_raw_markup', 'raw {cost} · markup applied', { cost: fmtCost(rawCost) }) : undefined}
                delta={deltas?.cost} deltaLabel={deltaLabel}
            />
            <MetricTile label={t('admin_monitoring.overview_avg_latency', 'Avg latency')} value={fmtDuration(summary?.avg_duration_ms)} delta={deltas?.latency} deltaLabel={latencyLabel} />
        </StatGrid>
    );
}

/** Cached and reasoning tokens; only when either is non-zero. */
function CacheKpis({ summary }: { summary: UsageSummary | null }) {
    const { t } = useTranslation();
    if (!((summary?.total_cached_tokens || 0) > 0 || (summary?.total_reasoning_tokens || 0) > 0)) return null;
    return (
        <StatGrid>
            <MetricTile
                label={t('admin_monitoring.overview_cached_tokens', 'Cached tokens')} value={fmt(summary?.total_cached_tokens || 0)}
                deltaLabel={(summary?.total_cache_creation_tokens || 0) > 0
                    ? t('admin_monitoring.overview_cache_written', '+ {n} written', { n: fmt(summary?.total_cache_creation_tokens) })
                    : t('admin_monitoring.overview_cache_hits', 'cache hits')}
            />
            <MetricTile
                label={t('admin_monitoring.overview_reasoning_tokens', 'Reasoning tokens')} value={fmt(summary?.total_reasoning_tokens || 0)}
                deltaLabel={t('admin_monitoring.overview_reasoning_hint', 'thinking / reasoning models')}
            />
        </StatGrid>
    );
}

/** Token and cost (or billed cost) over the period. */
function TrendCharts({ summary, timeline, costTimeline }: Pick<OverviewPageProps, 'summary' | 'timeline' | 'costTimeline'>) {
    const { t } = useTranslation();
    const lf = useLocaleFormat();
    const billed = Number(summary?.total_billed_cost || 0) > 0;
    return (
        <div className="grid gap-4 lg:grid-cols-2">
            <Card title={t('admin_monitoring.overview_token_trend', 'Token trend')}>
                <SvgAreaChart
                    data={timeline} yKey="total_tokens" color={SERIES.tokens}
                    formatY={fmt}
                    formatLabel={d => `${periodLabel(d.period, lf)} · ${t('admin_monitoring.shared_n_calls', '{n} calls', { n: lf.number(d.calls || 0) })}`}
                />
            </Card>
            <Card title={billed ? t('admin_monitoring.overview_billed_trend', 'Billed cost trend (PAYG)') : t('admin_monitoring.overview_cost_trend', 'Cost trend')}>
                <SvgAreaChart
                    data={costTimeline}
                    yKey={billed ? 'total_billed_cost' : 'total_cost'}
                    color={billed ? SERIES.billed : SERIES.cost}
                    formatY={fmtCost}
                    formatLabel={d => billed
                        ? t('admin_monitoring.overview_trend_billed_raw', '{period} · {billed} billed · {raw} raw', { period: periodLabel(d.period, lf), billed: fmtCost(d.total_billed_cost || 0), raw: fmtCost(d.total_cost || 0) })
                        : `${periodLabel(d.period, lf)} · ${fmtCost(d.total_cost || 0)}`}
                />
            </Card>
        </div>
    );
}

/** Top 5 models by cost plus "Other", for the donut. */
function donutItemsOf(byModel: ModelUsage[], costPerModel: Record<string, number>, t: TranslateFn) {
    const sorted = [...byModel]
        .filter(m => costPerModel[m.model])
        .sort((a, b) => (costPerModel[b.model] || 0) - (costPerModel[a.model] || 0));
    const items = sorted.slice(0, 5).map((m, i) => ({
        label: shortModel(m.model),
        value: costPerModel[m.model] || 0,
        color: MODEL_COLORS[i % MODEL_COLORS.length],
    }));
    const otherCost = sorted.slice(5).reduce((s, m) => s + (costPerModel[m.model] || 0), 0);
    if (otherCost > 0) items.push({ label: t('admin_monitoring.overview_other', 'Other'), value: otherCost, color: 'var(--text-tertiary)' });
    return items;
}

function CostBreakdown({ byModel, costPerModel, totalCost, onOpenModelPrices }: Pick<OverviewPageProps, 'byModel' | 'costPerModel' | 'totalCost' | 'onOpenModelPrices'>) {
    const { t } = useTranslation();
    const donutItems = useMemo(() => donutItemsOf(byModel, costPerModel, t), [byModel, costPerModel, t]);
    const missing = byModel.length - byModel.filter(m => costPerModel[m.model]).length;
    return (
        <Card
            title={t('admin_monitoring.overview_cost_breakdown', 'Cost breakdown')}
            action={onOpenModelPrices && (
                <button type="button" onClick={onOpenModelPrices} className={QUIET_BTN}>
                    <Settings2 className="h-3.5 w-3.5" aria-hidden="true" /> {t('admin_monitoring.overview_model_costs', 'Model costs')}
                </button>
            )}
        >
            {donutItems.length === 0 ? (
                <Empty text={onOpenModelPrices
                    ? t('admin_monitoring.overview_no_cost_data', 'No cost data: configure model pricing in AI Config')
                    : t('admin_monitoring.overview_no_cost_data_ask', 'No cost data yet: ask your platform administrator to set the model prices.')} />
            ) : (
                <div className="flex flex-col gap-3">
                    <DonutChart items={donutItems} centerLabel={t('admin_monitoring.overview_total', 'Total')} centerValue={fmtCost(totalCost)} />
                    {missing > 0 && (
                        <p className="m-0 flex items-center gap-1.5 text-[11px] text-[var(--text-tertiary)]">
                            <Info className="h-3 w-3 shrink-0" aria-hidden="true" />
                            {missing > 1 ? t('admin_monitoring.overview_no_cost_models', '{n} models without cost data', { n: missing }) : t('admin_monitoring.overview_no_cost_model', '{n} model without cost data', { n: missing })}
                        </p>
                    )}
                </div>
            )}
        </Card>
    );
}

export function OverviewPage({
    summary, deltas, deltaLabel,
    byModel, byAgent, timeline, costTimeline, tools,
    totalCost, costPerModel,
    onSelectModel, onSelectAgent, onOpenModelPrices
}: OverviewPageProps) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-col gap-4">
            <OverviewKpis summary={summary} deltas={deltas} deltaLabel={deltaLabel} totalCost={totalCost} />
            <CacheKpis summary={summary} />
            <TrendCharts summary={summary} timeline={timeline} costTimeline={costTimeline} />

            <div className="grid gap-4 lg:grid-cols-2">
                <Card title={t('admin_monitoring.overview_top_models', 'Top models')}>
                    {byModel.length === 0 ? <Empty text={t('admin_monitoring.overview_no_model_data', 'No model data')} /> : (
                        <div>
                            {byModel.slice(0, 5).map((m, i) => (
                                <ModelRow key={i} model={m} index={i} cost={costPerModel[m.model]} onClick={() => onSelectModel?.(m)} />
                            ))}
                        </div>
                    )}
                </Card>
                <Card title={t('admin_monitoring.overview_top_agents', 'Top agents')}>
                    {byAgent.length === 0 ? <Empty text={t('admin_monitoring.overview_no_agent_data', 'No agent data')} /> : (
                        <div>
                            {byAgent.slice(0, 5).map((a, i) => <AgentRow key={i} agent={a} onClick={() => onSelectAgent?.(a)} />)}
                        </div>
                    )}
                </Card>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
                <CostBreakdown byModel={byModel} costPerModel={costPerModel} totalCost={totalCost} onOpenModelPrices={onOpenModelPrices} />
                <Card title={t('admin_monitoring.overview_tool_usage', 'Tool usage')}>
                    {tools.length === 0 ? <Empty text={t('admin_monitoring.overview_no_tool_calls', 'No tool calls recorded')} /> : (
                        <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
                            {tools.slice(0, 15).map((tool, i) => (
                                <li key={i} className={CHIP}>
                                    <span className="font-semibold text-[var(--text-primary)]">{tool.tool_name}</span>
                                    <span className="tabular-nums text-[var(--text-tertiary)]">{tool.calls}×</span>
                                </li>
                            ))}
                        </ul>
                    )}
                </Card>
            </div>
        </div>
    );
}
