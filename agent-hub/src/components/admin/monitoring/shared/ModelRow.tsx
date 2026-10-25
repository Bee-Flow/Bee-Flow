import { useTranslation } from '../../../../hooks/useTranslation';
import type { InOutBarProps, ModelRowProps } from '../shared.types';
import { fmt, COLORS } from './SvgAreaChart';

export function fmtCost(n: number | null | undefined) {
    if (!n || n === 0) return '$0.00';
    if (n >= 1) return '$' + n.toFixed(2);
    if (n >= 0.01) return '$' + n.toFixed(3);
    if (n >= 0.001) return '$' + n.toFixed(4);
    return '$' + n.toFixed(6);
}

export function shortModel(m: string | null | undefined) {
    if (!m) return 'Unknown';
    return m.replace(/^(openai\/|anthropic\/|google\/|azure\/|mistral\/)/, '')
        .replace(/-\d{4}-\d{2}-\d{2}$/, '');
}

export const MODEL_COLORS = [
    '#6366f1', '#8b5cf6', '#3b82f6', '#06b6d4', '#10b981',
    '#f59e0b', '#f97316', '#ec4899', '#f43f5e', '#14b8a6',
];

export function InOutBar({ input, output, height = 5, style }: InOutBarProps) {
    const total = (input || 0) + (output || 0);
    if (total === 0) return <div style={{ width: '100%', height, borderRadius: 99, background: 'var(--bg-tertiary, rgba(255,255,255,0.06))', ...style }} />;
    const inputPct = ((input || 0) / total) * 100;
    return (
        <div style={{ width: '100%', height, borderRadius: 99, background: 'var(--bg-tertiary, rgba(255,255,255,0.06))', overflow: 'hidden', display: 'flex', ...style }}>
            <div style={{ height: '100%', width: `${inputPct}%`, background: COLORS.blue, borderRadius: '99px 0 0 99px', transition: 'width 0.4s ease' }} />
            <div style={{ height: '100%', flex: 1, background: COLORS.amber, borderRadius: '0 99px 99px 0', transition: 'width 0.4s ease' }} />
        </div>
    );
}

export function ModelRow({ model: m, index, maxTokens, cost }: ModelRowProps) {
    const { t } = useTranslation();
    const cached = m.cached_tokens || 0;
    const reasoning = m.reasoning_tokens || 0;
    return (
        <div className="[display:flex] [align-items:center] [gap:10px] [padding:10px_0] [border-bottom:1px_solid_var(--border-default,rgba(255,255,255,0.05))]">
            <div style={{
                width: '6px', height: '6px', borderRadius: '50%',
                background: MODEL_COLORS[index % MODEL_COLORS.length], flexShrink: 0,
            }} />
            <div className="[flex:1] min-w-[0]">
                <div className="[font-size:12px] [font-weight:600] [color:var(--text-primary,#fff)] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">
                    {shortModel(m.model || 'unknown')}
                </div>
                <InOutBar input={m.prompt_tokens} output={m.completion_tokens} height={3} style={{ marginTop: '4px', maxWidth: '120px' }} />
                {(cached > 0 || reasoning > 0) && (
                    <div className="[font-size:10px] [color:var(--text-muted,#888)] [margin-top:2px] [display:flex] [gap:8px]">
                        {cached > 0 && <span title={t('admin_monitoring.shared_cached_title', 'Cached input tokens')}>💾 {fmt(cached)}</span>}
                        {reasoning > 0 && <span title={t('admin_monitoring.shared_reasoning_title', 'Reasoning / thinking tokens (billed at output rate)')}>🧠 {fmt(reasoning)}</span>}
                    </div>
                )}
            </div>
            <div className="[text-align:right] [flex-shrink:0]">
                <div style={{ fontSize: '12px', fontWeight: 600, color: COLORS.green }}>{fmt(m.total_tokens)}</div>
                <div className="[font-size:10px] [color:var(--text-muted,#888)]">
                    {t('admin_monitoring.shared_n_calls', '{n} calls', { n: m.calls })}{cost ? ` · ${fmtCost(cost)}` : ''}
                </div>
            </div>
        </div>
    );
}
