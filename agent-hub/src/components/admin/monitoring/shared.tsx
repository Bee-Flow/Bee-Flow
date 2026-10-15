import type { CSSProperties } from 'react';
import { useTranslation } from '../../../hooks/useTranslation';
import type { UsageRow } from './drawer/drawerTypes';
import { COLORS, MODEL_COLORS, fmt, fmtCost, fmtDuration, getAgentStyle, shortModel } from './sharedFormat';
import { InOutBar } from './sharedCharts';

export * from './sharedFormat';
export * from './sharedBase';
export * from './sharedCharts';
export * from './sharedFilters';
export * from './sharedTable';

// ── Model / Agent Rows (lightweight) ────────────────────────────────────────

interface ModelRowProps {
    model: UsageRow;
    index: number;
    maxTokens?: number;
    cost?: number | null;
}

export function ModelRow({ model: m, index, cost }: ModelRowProps) {
    const { t } = useTranslation();
    const cached = m.cached_tokens || 0;
    const reasoning = m.reasoning_tokens || 0;
    return (
        <div style={{
            display: 'flex', alignItems: 'center', gap: '10px',
            padding: '10px 0', borderBottom: '1px solid var(--border-default, rgba(255,255,255,0.05))',
        }}>
            <div style={{
                width: '6px', height: '6px', borderRadius: '50%',
                background: MODEL_COLORS[index % MODEL_COLORS.length], flexShrink: 0,
            }} />
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary, #fff)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {shortModel(m.model || 'unknown')}
                </div>
                <InOutBar input={m.prompt_tokens} output={m.completion_tokens} height={3} style={{ marginTop: '4px', maxWidth: '120px' }} />
                {(cached > 0 || reasoning > 0) && (
                    <div style={{ fontSize: '10px', color: 'var(--text-muted, #888)', marginTop: '2px', display: 'flex', gap: '8px' }}>
                        {cached > 0 && <span title={t('admin_monitoring.shared_cached_title', 'Cached input tokens')}>💾 {fmt(cached)}</span>}
                        {reasoning > 0 && <span title={t('admin_monitoring.shared_reasoning_title', 'Reasoning / thinking tokens (billed at output rate)')}>🧠 {fmt(reasoning)}</span>}
                    </div>
                )}
            </div>
            <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div style={{ fontSize: '12px', fontWeight: 600, color: COLORS.green }}>{fmt(m.total_tokens)}</div>
                <div style={{ fontSize: '10px', color: 'var(--text-muted, #888)' }}>
                    {t('admin_monitoring.shared_n_calls', '{n} calls', { n: m.calls })}{cost ? ` · ${fmtCost(cost)}` : ''}
                </div>
            </div>
        </div>
    );
}

interface AgentRowProps {
    agent: UsageRow;
    index: number;
    detailed?: boolean;
}

export function AgentRow({ agent: a, detailed }: AgentRowProps) {
    const { t } = useTranslation();
    const style = getAgentStyle(a.agent_type);
    return (
        <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '10px 0', borderBottom: '1px solid var(--border-default, rgba(255,255,255,0.05))',
        }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                <span style={{
                    padding: '3px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                    background: style.bg, color: style.text, flexShrink: 0,
                }}>{a.agent_type || 'chat'}</span>
                <span style={{
                    fontSize: '12px', fontWeight: 600, color: 'var(--text-primary, #fff)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: detailed ? '200px' : '130px',
                }}>{a.agent_name || a.agent_id || t('admin_monitoring.unknown', 'Unknown')}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px', fontSize: '12px', flexShrink: 0 }}>
                {detailed && (
                    <span style={{ color: 'var(--text-muted, #888)' }}>{t('admin_monitoring.shared_avg', '{duration} avg', { duration: fmtDuration(a.avg_duration_ms) })}</span>
                )}
                <span style={{ color: COLORS.green, fontWeight: 600 }}>{t('admin_monitoring.shared_n_tok', '{n} tok', { n: fmt(a.total_tokens) })}</span>
                <span style={{ color: 'var(--text-muted, #888)' }}>{t('admin_monitoring.shared_n_calls', '{n} calls', { n: a.calls })}</span>
                <span style={{ color: COLORS.amber, fontWeight: 600, minWidth: '50px', textAlign: 'right' }}>{fmtCost(a.estimated_cost || 0)}</span>
            </div>
        </div>
    );
}

// ── Skeleton / Loading ──────────────────────────────────────────────────────

interface SkeletonProps {
    height?: number;
    style?: CSSProperties;
}

export function Skeleton({ height = 80, style }: SkeletonProps) {
    return (
        <div style={{
            height, borderRadius: '12px',
            background: 'var(--bg-tertiary, rgba(255,255,255,0.04))',
            animation: 'pulse 1.5s ease-in-out infinite',
            ...style,
        }} />
    );
}

export function SkeletonGrid({ count = 4, height = 80 }: { count?: number; height?: number }) {
    return (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${count}, 1fr)`, gap: '12px' }}>
            {Array.from({ length: count }, (_, i) => <Skeleton key={i} height={height} />)}
        </div>
    );
}
