import type { ReactNode } from 'react';
import { DrawerSection } from '@/components/shared/SideDrawer';
import type { DetailType, ModelRate, UsageRow } from './drawerTypes';
import { useTranslation } from '@/hooks/useTranslation';
import { fmt, fmtCost, fmtDuration, fmtTime, rowCost, agentChipClass, SeriesDot } from '../shared';

interface StatsProps {
    type: DetailType;
    data: UsageRow;
    costPerModel: Record<string, number>;
}

function Stat({ value, label }: { value: ReactNode; label: ReactNode }) {
    return (
        <div className="min-w-0 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-2.5">
            <div className="truncate text-lg font-semibold tabular-nums text-[var(--text-primary)]">{value}</div>
            <div className="mt-0.5 text-[10px] font-semibold uppercase tracking-[0.05em] text-[var(--text-tertiary)]">{label}</div>
        </div>
    );
}

/** Calls, total tokens and cost (billed when the org pays as it goes, otherwise the estimate from list prices). */
export function DrawerStats({ type, data, costPerModel }: StatsProps) {
    const { t } = useTranslation();
    const billed = Number(data.billed_cost || 0);
    const raw = type === 'model' && costPerModel[data.model as string]
        ? costPerModel[data.model as string]
        : (data.estimated_cost || 0);
    const isPayg = billed > 0;
    return (
        <div className="grid grid-cols-3 gap-2">
            <Stat value={fmt(data.calls || 0)} label={t('admin_monitoring.drawer_calls', 'Calls')} />
            <Stat value={fmt(data.total_tokens || 0)} label={t('admin_monitoring.drawer_total_tokens', 'Total Tokens')} />
            <Stat value={fmtCost(isPayg ? billed : raw)} label={isPayg ? `Billed (raw ${fmtCost(raw)})` : 'Est. Cost'} />
        </div>
    );
}

function Line({ label, children }: { label: ReactNode; children: ReactNode }) {
    return (
        <div className="flex items-center justify-between gap-3 text-xs">
            <span className="text-[var(--text-secondary)]">{label}</span>
            <span className="font-semibold tabular-nums text-[var(--text-primary)]">{children}</span>
        </div>
    );
}

interface BreakdownProps {
    type: DetailType;
    data: UsageRow;
    modelCosts: Record<string, ModelRate | undefined>;
}

/** Input vs output tokens, plus the model's list prices per 1M tokens or the agent's type. */
export function DrawerBreakdown({ type, data, modelCosts }: BreakdownProps) {
    const { t } = useTranslation();
    const rate = type === 'model' ? modelCosts[data.model as string] : undefined;
    return (
        <DrawerSection label={t('admin_monitoring.drawer_breakdown', 'Breakdown')}>
            <div className="flex flex-col gap-2 rounded-lg border border-[var(--border-default)] p-3">
                <Line label={<span className="inline-flex items-center gap-1.5"><SeriesDot color="var(--chart-1)" square />{t('admin_monitoring.drawer_input_tokens', 'Input tokens')}</span>}>{fmt(data.prompt_tokens || 0)}</Line>
                <Line label={<span className="inline-flex items-center gap-1.5"><SeriesDot color="var(--chart-4)" square />{t('admin_monitoring.drawer_output_tokens', 'Output tokens')}</span>}>{fmt(data.completion_tokens || 0)}</Line>
                {rate && (
                    <>
                        <div className="h-px bg-[var(--border-default)]" />
                        <Line label={t('admin_monitoring.drawer_input_rate', 'Input rate')}>{t('admin_monitoring.drawer_rate_in', '{price}/1M tokens', { price: `€${rate.input}` })}</Line>
                        <Line label={t('admin_monitoring.drawer_output_rate', 'Output rate')}>{t('admin_monitoring.drawer_rate_out', '{price}/1M tokens', { price: `€${rate.output}` })}</Line>
                    </>
                )}
                {type === 'agent' && data.agent_type && (
                    <Line label={t('admin_monitoring.drawer_agent_type', 'Agent type')}><span className={agentChipClass(data.agent_type)}>{data.agent_type}</span></Line>
                )}
            </div>
        </DrawerSection>
    );
}

function CallCard({ call: r, type, rate }: { call: UsageRow; type: DetailType; rate: ModelRate | undefined }) {
    const { t } = useTranslation();
    const cost = rowCost(r, rate);
    return (
        <li className="rounded-lg border border-[var(--border-default)] px-3 py-2 text-[11px]">
            <div className="mb-1 flex justify-between gap-3">
                <span className="text-[var(--text-tertiary)]">{fmtTime(r.timestamp)}</span>
                <span className="font-semibold tabular-nums text-[var(--text-primary)]">{cost != null ? fmtCost(cost) : '—'}</span>
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 tabular-nums text-[var(--text-secondary)]">
                {type !== 'model' && <span>{r.model || '—'}</span>}
                {type !== 'agent' && <span>{r.agent_name || '—'}</span>}
                <span>{t('admin_monitoring.drawer_in_n', '{n} in', { n: fmt(r.prompt_tokens) })}</span>
                <span>{t('admin_monitoring.drawer_out_n', '{n} out', { n: fmt(r.completion_tokens) })}</span>
                <span className="text-[var(--text-tertiary)]">{fmtDuration(r.duration_ms)}</span>
            </div>
        </li>
    );
}

interface RelatedCallsProps {
    type: DetailType;
    calls: UsageRow[];
    modelCosts: Record<string, ModelRate | undefined>;
}

/** The last calls that went through this model or agent. */
export function RelatedCalls({ type, calls, modelCosts }: RelatedCallsProps) {
    const { t } = useTranslation();
    return (
        <DrawerSection label={t('admin_monitoring.drawer_recent_calls', 'Recent Calls ({n})', { n: calls.length })}>
            {calls.length === 0 ? (
                <p className="m-0 py-4 text-center text-xs text-[var(--text-tertiary)]">{t('admin_monitoring.drawer_no_recent', 'No recent calls found')}</p>
            ) : (
                <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                    {calls.map((r, i) => <CallCard key={i} call={r} type={type} rate={modelCosts[r.model as string]} />)}
                </ul>
            )}
        </DrawerSection>
    );
}
