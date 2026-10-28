import { S } from './drawerTypes';
import type { DetailType, ModelRate, UsageRow } from './drawerTypes';
import { useTranslation } from '@/hooks/useTranslation';
import { fmt, fmtCost, fmtDuration, fmtTime, rowCost, COLORS, getAgentStyle } from '../shared';

interface StatsProps {
    type: DetailType;
    data: UsageRow;
    costPerModel: Record<string, number>;
}

/** Billed cost when the org pays as it goes, otherwise the estimate from list prices. */
function CostStat({ type, data, costPerModel }: StatsProps) {
    const billed = Number(data.billed_cost || 0);
    const raw = type === 'model' && costPerModel[data.model as string]
        ? costPerModel[data.model as string]
        : (data.estimated_cost || 0);
    const isPayg = billed > 0;
    return (
        <>
            <div style={{ fontSize: '22px', fontWeight: 800, color: isPayg ? COLORS.green : COLORS.amber }}>
                {fmtCost(isPayg ? billed : raw)}
            </div>
            <div style={S.statLabel}>
                {isPayg ? `Billed (raw ${fmtCost(raw)})` : 'Est. Cost'}
            </div>
        </>
    );
}

/** Calls, total tokens and cost, side by side. */
export function DrawerStats(props: StatsProps) {
    const { t } = useTranslation();
    const { data } = props;
    return (
        <div style={S.statGrid}>
            <div style={S.statBox}>
                <div className="[font-size:22px] [font-weight:800] [color:var(--text-primary,#fff)]">
                    {fmt(data.calls || 0)}
                </div>
                <div style={S.statLabel}>{t('admin_monitoring.drawer_calls', 'Calls')}</div>
            </div>
            <div style={S.statBox}>
                <div style={{ fontSize: '22px', fontWeight: 800, color: COLORS.green }}>
                    {fmt(data.total_tokens || 0)}
                </div>
                <div style={S.statLabel}>{t('admin_monitoring.drawer_total_tokens', 'Total Tokens')}</div>
            </div>
            <div style={S.statBox}>
                <CostStat {...props} />
            </div>
        </div>
    );
}

function TokenRow({ label, value, color, marginBottom }: { label: string; value: string; color: string; marginBottom: string }) {
    return (
        <div style={{ ...S.row, marginBottom }}>
            <span style={S.rowLabel}>{label}</span>
            <span style={{ fontSize: '13px', fontWeight: 600, color }}>{value}</span>
        </div>
    );
}

/** The model's list prices per 1M tokens. */
function ModelRates({ rate }: { rate: ModelRate }) {
    const { t } = useTranslation();
    return (
        <>
            <div style={S.divider} />
            <div style={{ ...S.row, marginBottom: '6px' }}>
                <span style={S.rowLabel}>{t('admin_monitoring.drawer_input_rate', 'Input rate')}</span>
                <span style={S.rate}>{t('admin_monitoring.drawer_rate_in', '{price}/1M tokens', { price: `$${rate.input}` })}</span>
            </div>
            <div style={S.row}>
                <span style={S.rowLabel}>{t('admin_monitoring.drawer_output_rate', 'Output rate')}</span>
                <span style={S.rate}>{t('admin_monitoring.drawer_rate_out', '{price}/1M tokens', { price: `$${rate.output}` })}</span>
            </div>
        </>
    );
}

interface BreakdownProps {
    type: DetailType;
    data: UsageRow;
    modelCosts: Record<string, ModelRate | undefined>;
}

/** Input vs output tokens, plus the model's rates or the agent's type. */
export function DrawerBreakdown({ type, data, modelCosts }: BreakdownProps) {
    const { t } = useTranslation();
    const rate = type === 'model' ? modelCosts[data.model as string] : undefined;
    return (
        <div className="[padding:0_24px_16px]">
            <div style={S.panel}>
                <div style={{ ...S.sectionLabel, marginBottom: '12px' }}>
                    {t('admin_monitoring.drawer_breakdown', 'Breakdown')}
                </div>
                <TokenRow label={t('admin_monitoring.drawer_input_tokens', 'Input tokens')} value={fmt(data.prompt_tokens || 0)} color={COLORS.blue} marginBottom="8px" />
                <TokenRow label={t('admin_monitoring.drawer_output_tokens', 'Output tokens')} value={fmt(data.completion_tokens || 0)} color={COLORS.amber} marginBottom="8px" />
                {rate && <ModelRates rate={rate} />}
                {type === 'agent' && data.agent_type && (
                    <div style={S.row}>
                        <span style={S.rowLabel}>{t('admin_monitoring.drawer_agent_type', 'Agent type')}</span>
                        <span
                            style={{
                                padding: '2px 8px',
                                borderRadius: '4px',
                                fontSize: '11px',
                                fontWeight: 600,
                                background: getAgentStyle(data.agent_type).bg,
                                color: getAgentStyle(data.agent_type).text,
                            }}
                        >
                            {data.agent_type}
                        </span>
                    </div>
                )}
            </div>
        </div>
    );
}

interface RelatedCallsProps {
    type: DetailType;
    calls: UsageRow[];
    modelCosts: Record<string, ModelRate | undefined>;
}

function CallCard({ call: r, type, rate }: { call: UsageRow; type: DetailType; rate: ModelRate | undefined }) {
    const { t } = useTranslation();
    const cost = rowCost(r, rate);
    return (
        <div style={S.callCard}>
            <div style={{ ...S.row, marginBottom: '4px' }}>
                <span className="[color:var(--text-muted,#888)]">{fmtTime(r.timestamp)}</span>
                <span style={{ color: COLORS.amber, fontWeight: 600 }}>{cost != null ? fmtCost(cost) : '—'}</span>
            </div>
            <div className="[display:flex] [gap:12px] [color:var(--text-secondary,#aaa)]">
                {type !== 'model' && <span>{r.model || '—'}</span>}
                {type !== 'agent' && <span>{r.agent_name || '—'}</span>}
                <span style={{ color: COLORS.blue }}>{t('admin_monitoring.drawer_in_n', '{n} in', { n: fmt(r.prompt_tokens) })}</span>
                <span style={{ color: COLORS.amber }}>{t('admin_monitoring.drawer_out_n', '{n} out', { n: fmt(r.completion_tokens) })}</span>
                <span className="[color:var(--text-muted,#666)]">{fmtDuration(r.duration_ms)}</span>
            </div>
        </div>
    );
}

/** The last calls that went through this model or agent. */
export function RelatedCalls({ type, calls, modelCosts }: RelatedCallsProps) {
    const { t } = useTranslation();
    return (
        <div className="[flex:1] [overflow:auto] [padding:0_24px_24px]">
            <div style={{ ...S.sectionLabel, marginBottom: '10px' }}>
                {t('admin_monitoring.drawer_recent_calls', 'Recent Calls ({n})', { n: calls.length })}
            </div>
            {calls.length === 0 ? (
                <div className="[font-size:12px] [color:var(--text-muted,#666)] [text-align:center] [padding:20px]">
                    {t('admin_monitoring.drawer_no_recent', 'No recent calls found')}
                </div>
            ) : (
                <div className="[display:flex] [flex-direction:column] [gap:6px]">
                    {calls.map((r, i) => (
                        <CallCard key={i} call={r} type={type} rate={modelCosts[r.model as string]} />
                    ))}
                </div>
            )}
        </div>
    );
}
