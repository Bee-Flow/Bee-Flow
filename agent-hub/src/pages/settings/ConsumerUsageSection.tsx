import React, { useState, useEffect, useMemo } from 'react';
import { Activity, Zap, DollarSign, BarChart3, Bot, MessageSquare, BookOpen, Search, Code, LayoutTemplate, type LucideIcon } from 'lucide-react';
import { API_BASE, authFetch } from '../../utils/helpers';
import { useTranslation } from '../../hooks/useTranslation';

const fNum = (n: number|null) => {
    if (n == null) return '0';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return n.toLocaleString();
};
const fCur = (c: number) => `$${(c || 0).toFixed(2)}`;

const shortModel = (m: string) => {
    if (!m) return 'Unknown';
    return m.replace(/^(openai\/|anthropic\/|google\/|azure\/|mistral\/)/, '')
            .replace(/-\d{4}-\d{2}-\d{2}$/, '');
};

const SOURCE_MAP: Record<string, { label: string; icon: LucideIcon; color: string; }> = {
    agent: { label: 'Agent Chat', icon: Bot, color: '#0ea5e9' },
    chat: { label: 'Agent Chat', icon: Bot, color: '#0ea5e9' },
    direct: { label: 'Direct Chat', icon: MessageSquare, color: '#10b981' },
    notebook: { label: 'Notebooks', icon: BookOpen, color: '#14b8a6' },
    research: { label: 'Research', icon: Search, color: '#f59e0b' },
    template: { label: 'Templates', icon: LayoutTemplate, color: '#ef4444' },
    designer: { label: 'App Designer', icon: Code, color: '#0ea5e9' },
    agent_stream: { label: 'Agent Stream', icon: Bot, color: '#0ea5e9' },
};
const sourceFor = (k: string) => SOURCE_MAP[k] || { label: k || 'Other', icon: Bot, color: '#94a3b8' };

interface CardProps {
    children?: React.ReactNode;
    style?: React.CSSProperties;
}

const Card = ({ children, style }: CardProps) => (
    <div style={{
        background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)',
        borderRadius: 12, overflow: 'hidden', ...style,
    }}>{children}</div>
);

interface StatCardProps {
    icon: LucideIcon;
    label: string;
    value: string;
    sub?: string;
    color: string;
}

const StatCard = ({ icon: Icon, label, value, sub, color }: StatCardProps) => (
    <Card style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 1 }}>
        <div className="[display:flex] [align-items:center] [gap:5px] [margin-bottom:4px]">
            <div style={{
                width: 24, height: 24, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: `${color}15`,
            }}>
                <Icon style={{ width: 13, height: 13, color }} />
            </div>
            <span className="[font-size:10px] [font-weight:600] [text-transform:uppercase] [letter-spacing:0.06em] [color:var(--text-muted)]">{label}</span>
        </div>
        <div className="[font-size:22px] [font-weight:800] [color:var(--text-primary)] [letter-spacing:-0.02em]">{value}</div>
        {sub && <div className="[margin-top:2px] [font-size:11px] [color:var(--text-muted)]">{sub}</div>}
    </Card>
);

// Tiny inline SVG line — no chart dep. Renders a single sparkline over the
// daily cost timeline so the user can see spend trend at a glance.
interface SparklinePoint {
    value: number;
    label: string;
}

interface SparklineProps {
    data?: SparklinePoint[];
    color?: string;
    height?: number;
}

const Sparkline = ({ data, color = '#0ea5e9', height = 60 }: SparklineProps) => {
    const { t } = useTranslation();
    if (!Array.isArray(data) || data.length < 2) {
        return <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: 'var(--text-muted)' }}>{t('settings.consumer_usage.not_enough_data', 'Not enough data yet')}</div>;
    }
    const max = Math.max(...data.map(d => d.value || 0), 0.01);
    const w = 600;
    const points = data.map((d, i) => {
        const x = (i / (data.length - 1)) * w;
        const y = height - ((d.value || 0) / max) * (height - 8) - 4;
        return `${x},${y}`;
    }).join(' ');
    return (
        <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" style={{ width: '100%', height }}>
            <polyline points={points} fill="none" stroke={color} strokeWidth="2" />
        </svg>
    );
};

interface UsageSummary {
    total_calls?: number;
    billed_cost?: number;
    combined_total_cost?: number;
    total_estimated_cost?: number;
    total_input_cost?: number;
    total_output_cost?: number;
    total_tokens?: number;
    total_prompt_tokens?: number;
    total_completion_tokens?: number;
}

interface CostTimelineRow {
    billed_cost?: number;
    total_cost?: number;
    cost?: number;
    value?: number;
    date?: string;
    day?: string;
}

interface UsageRow {
    model: string;
    source: string;
    total_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
    total_calls?: number;
    total_cost?: number;
    estimated_cost?: number;
}

const ConsumerUsageSection = () => {
    const { t } = useTranslation();
    const [days, setDays] = useState(30);
    const [loading, setLoading] = useState(true);
    const [summary, setSummary] = useState<UsageSummary | null>(null);
    const [costTimeline, setCostTimeline] = useState<CostTimelineRow[]>([]);
    const [byModel, setByModel] = useState<UsageRow[]>([]);
    const [bySource, setBySource] = useState<UsageRow[]>([]);

    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            setLoading(true);
            try {
                const [s, ct, m, src] = await Promise.all([
                    authFetch(`${API_BASE}/api/usage/summary?days=${days}`).then(r => r.ok ? r.json() : null),
                    authFetch(`${API_BASE}/api/usage/cost-timeline?days=${days}`).then(r => r.ok ? r.json() : []),
                    authFetch(`${API_BASE}/api/usage/by-model?days=${days}`).then(r => r.ok ? r.json() : []),
                    authFetch(`${API_BASE}/api/usage/sources?days=${days}`).then(r => r.ok ? r.json() : []),
                ]);
                if (cancelled) return;
                setSummary(s);
                setCostTimeline(Array.isArray(ct) ? ct : []);
                setByModel(Array.isArray(m) ? m : []);
                setBySource(Array.isArray(src) ? src : []);
            } catch (e) {
                console.error('[ConsumerUsage] load error:', e);
            } finally {
                if (!cancelled) setLoading(false);
            }
        };
        load();
        return () => { cancelled = true; };
    }, [days]);

    const sparklinePoints = useMemo(() => {
        return costTimeline.map(row => ({
            value: Number(row.billed_cost ?? row.total_cost ?? row.cost ?? row.value ?? 0),
            label: row.date || row.day || '',
        }));
    }, [costTimeline]);

    // Backend redacts token/message counts for non-admin callers and replaces
    // estimated_cost with marked-up billed_cost. Detect that shape so the UI
    // shows a cost-only customer view.
    const isCustomerView = summary && summary.total_calls === undefined && summary.billed_cost !== undefined;
    const totalCost = isCustomerView
        ? Number(summary?.billed_cost || 0)
        : Number(summary?.combined_total_cost ?? summary?.total_estimated_cost ?? 0);

    if (loading && !summary) {
        return (
            <div className="space-y-4 animate-pulse">
                <div className="h-6 w-48 bg-[var(--bg-tertiary)] rounded-lg" />
                <div className="grid grid-cols-3 gap-3">
                    <div className="h-24 bg-[var(--bg-tertiary)] rounded-xl" />
                    <div className="h-24 bg-[var(--bg-tertiary)] rounded-xl" />
                    <div className="h-24 bg-[var(--bg-tertiary)] rounded-xl" />
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-5 animate-fadeIn">
            {/* Header + range picker */}
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-lg font-semibold text-[var(--text-primary)]">
                        {t('settings.usage_monitoring', 'Usage & Monitoring')}
                    </h2>
                    <p className="text-sm text-[var(--text-muted)] mt-1">
                        {t('settings.consumer_usage.subtitle', 'Track your AI usage and spend')}
                    </p>
                </div>
                <div className="flex gap-1 p-1 rounded-lg [background:var(--bg-secondary)] [border:1px_solid_var(--border-subtle)]">
                    {[7, 30, 90].map(d => (
                        <button
                            key={d}
                            type="button"
                            aria-pressed={days === d}
                            onClick={() => setDays(d)}
                            className="px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
                            style={{
                                background: days === d ? 'var(--accent-primary)' : 'transparent',
                                color: days === d ? '#fff' : 'var(--text-muted)',
                            }}
                        >
                            {d}d
                        </button>
                    ))}
                </div>
            </div>

            {/* Stat cards */}
            {isCustomerView ? (
                <div className="grid grid-cols-1 gap-3">
                    <StatCard
                        icon={DollarSign}
                        label={t('usage.ai_usage_this_period', 'AI usage this period')}
                        value={`€${totalCost.toFixed(2)}`}
                        color="#10b981"
                    />
                </div>
            ) : (
                <div className="grid grid-cols-3 gap-3">
                    <StatCard
                        icon={DollarSign}
                        label="Estimated cost"
                        value={fCur(totalCost)}
                        sub={`In: ${fCur(summary?.total_input_cost ?? 0)} · Out: ${fCur(summary?.total_output_cost ?? 0)}`}
                        color="#10b981"
                    />
                    <StatCard
                        icon={Zap}
                        label="AI calls"
                        value={fNum(summary?.total_calls ?? 0)}
                        sub={`${fNum(summary?.total_tokens ?? 0)} tokens`}
                        color="#0ea5e9"
                    />
                    <StatCard
                        icon={Activity}
                        label="Tokens"
                        value={fNum(summary?.total_tokens ?? 0)}
                        sub={`In: ${fNum(summary?.total_prompt_tokens || 0)} · Out: ${fNum(summary?.total_completion_tokens || 0)}`}
                        color="#f59e0b"
                    />
                </div>
            )}

            {/* Cost trend */}
            <Card>
                <div className="[padding:14px_16px] [border-bottom:1px_solid_var(--border-subtle)] [display:flex] [align-items:center] [gap:8px]">
                    <BarChart3 style={{ width: 14, height: 14, color: 'var(--text-muted)' }} />
                    <span className="[font-size:12px] [font-weight:600] [color:var(--text-primary)]">{t('settings.consumer_usage.cost_trend', 'Cost trend')}</span>
                </div>
                <div className="[padding:16px]">
                    <Sparkline data={sparklinePoints} color="#10b981" />
                </div>
            </Card>

            {/* Per-model + per-source side by side — admin/raw view only */}
            {!isCustomerView && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <Card>
                    <div className="[padding:12px_16px] [border-bottom:1px_solid_var(--border-subtle)] [font-size:12px] [font-weight:600] [color:var(--text-primary)]">
                        {t('settings.consumer_usage.per_model', 'Per model')}
                    </div>
                    {byModel.length === 0 ? (
                        <div className="[padding:16px] [font-size:12px] [color:var(--text-muted)]">{t('settings.consumer_usage.no_model_usage', 'No model usage yet.')}</div>
                    ) : (
                        <div>
                            {byModel.slice(0, 8).map((row, i) => (
                                <div
                                    key={row.model || i}
                                    style={{ padding: '10px 16px', borderBottom: i < Math.min(byModel.length, 8) - 1 ? '1px solid var(--border-subtle)' : 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                                >
                                    <div className="min-w-[0] [flex:1]">
                                        <p className="[font-size:12px] [font-weight:600] [color:var(--text-primary)] [text-overflow:ellipsis] [overflow:hidden] [white-space:nowrap]">{shortModel(row.model)}</p>
                                        <p className="[font-size:10px] [color:var(--text-muted)]">
                                            {t('settings.consumer_usage.tokens_calls', '{tokens} tokens · {calls} calls', { tokens: fNum(row.total_tokens || (row.prompt_tokens || 0) + (row.completion_tokens || 0)), calls: row.total_calls || 0 })}
                                        </p>
                                    </div>
                                    <span className="[font-size:12px] [font-weight:700] [color:var(--text-primary)]">{fCur(row.total_cost || row.estimated_cost || 0)}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </Card>
                <Card>
                    <div className="[padding:12px_16px] [border-bottom:1px_solid_var(--border-subtle)] [font-size:12px] [font-weight:600] [color:var(--text-primary)]">
                        {t('settings.consumer_usage.per_source', 'Per source')}
                    </div>
                    {bySource.length === 0 ? (
                        <div className="[padding:16px] [font-size:12px] [color:var(--text-muted)]">{t('settings.consumer_usage.no_source_usage', 'No source usage yet.')}</div>
                    ) : (
                        <div>
                            {bySource.slice(0, 8).map((row, i) => {
                                const meta = sourceFor(row.source);
                                const Icon = meta.icon;
                                return (
                                    <div
                                        key={row.source || i}
                                        style={{ padding: '10px 16px', borderBottom: i < Math.min(bySource.length, 8) - 1 ? '1px solid var(--border-subtle)' : 'none', display: 'flex', alignItems: 'center', gap: 10 }}
                                    >
                                        <div style={{ width: 28, height: 28, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', background: `${meta.color}15` }}>
                                            <Icon style={{ width: 14, height: 14, color: meta.color }} />
                                        </div>
                                        <div className="min-w-[0] [flex:1]">
                                            <p className="[font-size:12px] [font-weight:600] [color:var(--text-primary)]">{meta.label}</p>
                                            <p className="[font-size:10px] [color:var(--text-muted)]">{t('settings.consumer_usage.calls_tokens', '{calls} calls · {tokens} tokens', { calls: row.total_calls || 0, tokens: fNum(row.total_tokens || 0) })}</p>
                                        </div>
                                        <span className="[font-size:12px] [font-weight:700] [color:var(--text-primary)]">{fCur(row.total_cost || row.estimated_cost || 0)}</span>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </Card>
            </div>
            )}
        </div>
    );
};

export default ConsumerUsageSection;
