import React, { useState, useMemo, type ComponentType, type CSSProperties, type ReactNode } from 'react';
import {
    ArrowUp, ArrowDown, Minus, ChevronDown, X, Filter,
    Users, Bot, Cpu, Activity,
    type LucideIcon,
} from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import type { UsageRow, ModelRate } from '../drawer/drawerTypes';
import type { UsageRecord, ModelUsage, AgentUsage, UserUsage, ToolUsage, UsageSummary, ChartPoint, CardProps, MetricCardProps, InOutLabelProps, DonutItem, FilterOption, FilterSelectProps, FilterState, FilterBarProps, SortableColumn, SortableTableProps, SkeletonProps, SkeletonGridProps } from '../shared.types';
import { fmt, COLORS, Empty } from './SvgAreaChart';
import { fmtCost } from './ModelRow';
;
export { fmtCost, shortModel, MODEL_COLORS, InOutBar,  } from './ModelRow';
export { fmt, COLORS, Empty, SvgAreaChart } from './SvgAreaChart';
export type { UsageRecord, ModelUsage, AgentUsage, UserUsage, ToolUsage, UsageSummary, ChartPoint,  FilterState, SortableColumn } from '../shared.types';

// ── Row shapes ──────────────────────────────────────────────────────────────

// ── Formatters ──────────────────────────────────────────────────────────────

// Cache-aware provider cost (USD) for a usage row, given its rate entry `c`
// ({ input, output, cacheRead } per 1M tokens from the model-costs map).
// Cached input tokens are billed at the cached rate, not the full input rate —
// matches the backend computeCost. Falls back gracefully when cacheRead or
// cached_tokens are absent (e.g. redacted non-admin rows → cached defaults 0).
export function rowCost(row: UsageRow, c: ModelRate): number;
export function rowCost(row: UsageRow, c: ModelRate | undefined): number | null;
export function rowCost(row: UsageRow, c: ModelRate | undefined) {
    if (!c) return null;
    const prompt = row?.prompt_tokens || 0;
    const completion = row?.completion_tokens || 0;
    const cached = row?.cached_tokens || 0;
    const uncached = Math.max(0, prompt - cached);
    const cacheRate = c.cacheRead && c.cacheRead > 0 ? c.cacheRead : (c.input || 0);
    return (uncached / 1e6) * (c.input || 0)
        + (cached / 1e6) * cacheRate
        + (completion / 1e6) * (c.output || 0);
}

export function fmtDuration(ms: number | undefined) {
    if (!ms) return '—';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

export function fmtTime(ts: string | number | undefined) {
    if (!ts) return '—';
    const d = new Date(ts);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    if (diff < 60_000) return 'just now';
    if (diff < 3600_000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400_000) return `${Math.floor(diff / 3600000)}h ago`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtPct(n: number) {
    if (!n && n !== 0) return '—';
    const sign = n > 0 ? '+' : '';
    return `${sign}${n.toFixed(1)}%`;
}

// ── Colors ──────────────────────────────────────────────────────────────────

const AGENT_COLORS: Readonly<Record<string, { bg: string; text: string; label: string }>> = {
    chat: { bg: '#6366f115', text: '#818cf8', label: '💬 Chat' },
    system: { bg: '#8b5cf615', text: '#a78bfa', label: '⚙️ System' },
};

export function getAgentStyle(type: string | undefined) {
    return AGENT_COLORS[String(type)] || AGENT_COLORS.chat;
}

const SOURCE_MAP: Readonly<Record<string, { label: string; icon: LucideIcon; color: string }>> = {
    agent: { label: 'Agent Chat', icon: Bot, color: '#6366f1' },
    chat: { label: 'Agent Chat', icon: Bot, color: '#6366f1' },
    direct: { label: 'Direct Chat', icon: Activity, color: '#10b981' },
    notebook: { label: 'Notebooks', icon: Activity, color: '#8b5cf6' },
    research: { label: 'Research', icon: Activity, color: '#f59e0b' },
    template: { label: 'Templates', icon: Activity, color: '#ef4444' },
    designer: { label: 'App Designer', icon: Activity, color: '#0ea5e9' },
    agent_stream: { label: 'Agent Stream', icon: Bot, color: '#6366f1' },
};
export const getSourceDetails = (source: string | null | undefined) =>
    SOURCE_MAP[String(source)] || { label: source || 'Other', icon: Activity, color: '#94a3b8' };

// ── Base UI Components ──────────────────────────────────────────────────────

export function Card({ title, icon: Icon, children, style: extraStyle, action }: CardProps) {
    return (
        <div style={{
            background: 'var(--bg-secondary, #1a1a2e)', borderRadius: '14px',
            padding: '18px 20px', border: '1px solid var(--border-default, rgba(255,255,255,0.08))',
            ...extraStyle,
        }}>
            {(title || action) && (
                <div className="[display:flex] [align-items:center] [justify-content:space-between] [margin-bottom:14px]">
                    <div className="[display:flex] [align-items:center] [gap:8px]">
                        {Icon && <Icon style={{ width: 16, height: 16, color: COLORS.primary }} />}
                        {title && <span className="[font-size:14px] [font-weight:700] [color:var(--text-primary,#fff)]">{title}</span>}
                    </div>
                    {action}
                </div>
            )}
            {children}
        </div>
    );
}

export function MetricCard({ icon: Icon, label, value, color, subtitle, delta, deltaLabel }: MetricCardProps) {
    const deltaColor = (delta ?? 0) > 0 ? COLORS.green : (delta ?? 0) < 0 ? COLORS.rose : 'var(--text-muted, #888)';
    const DeltaIcon = (delta ?? 0) > 0 ? ArrowUp : (delta ?? 0) < 0 ? ArrowDown : Minus;
    return (
        <div className="[background:var(--bg-secondary,#1a1a2e)] [border-radius:14px] [padding:18px] [border:1px_solid_var(--border-default,rgba(255,255,255,0.08))] [display:flex] [flex-direction:column] [gap:6px] [transition:border-color_0.2s,transform_0.2s]">
            <div className="[display:flex] [align-items:center] [gap:8px]">
                <div style={{
                    width: '30px', height: '30px', borderRadius: '8px',
                    background: color + '15', display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                    <Icon style={{ width: 16, height: 16, color }} />
                </div>
                <span className="[font-size:11px] [font-weight:600] [color:var(--text-muted,#888)] [text-transform:uppercase] [letter-spacing:0.04em]">
                    {label}
                </span>
            </div>
            <span className="[font-size:1.75rem] [font-weight:800] [color:var(--text-primary,#fff)] [line-height:1]">
                {value}
            </span>
            <div className="[display:flex] [align-items:center] [gap:6px] min-h-[16px]">
                {delta != null && (
                    <span style={{ display: 'flex', alignItems: 'center', gap: '2px', fontSize: '11px', fontWeight: 600, color: deltaColor }}>
                        <DeltaIcon className="w-[12px] h-[12px]" />
                        {fmtPct(delta)}
                    </span>
                )}
                {(subtitle || deltaLabel) && (
                    <span className="[font-size:11px] [color:var(--text-muted,#888)]">
                        {subtitle || deltaLabel}
                    </span>
                )}
            </div>
        </div>
    );
}

// ── InOut Bar (stacked input/output bar) ────────────────────────────────────

export function InOutLabel({ input, output, inputCost, outputCost, showCost }: InOutLabelProps) {
    return (
        <div style={{ display: 'flex', gap: showCost ? 14 : 10, fontSize: '11px', color: 'var(--text-muted, #888)' }}>
            <span className="[display:flex] [align-items:center] [gap:3px]">
                <span style={{ width: 6, height: 6, borderRadius: 2, background: COLORS.blue, display: 'inline-block' }} />
                <span style={{ color: COLORS.blue, fontWeight: 600 }}>{fmt(input)}</span>
                {showCost && inputCost != null && <span style={{ color: COLORS.blue, opacity: 0.7, fontWeight: 500 }}>({fmtCost(inputCost)})</span>}
            </span>
            <span className="[display:flex] [align-items:center] [gap:3px]">
                <span style={{ width: 6, height: 6, borderRadius: 2, background: COLORS.amber, display: 'inline-block' }} />
                <span style={{ color: COLORS.amber, fontWeight: 600 }}>{fmt(output)}</span>
                {showCost && outputCost != null && <span style={{ color: COLORS.amber, opacity: 0.7, fontWeight: 500 }}>({fmtCost(outputCost)})</span>}
            </span>
        </div>
    );
}

// ── SVG Area Chart ──────────────────────────────────────────────────────────

// ── SVG Donut Chart ─────────────────────────────────────────────────────────

// ── Filter Bar ──────────────────────────────────────────────────────────────

function FilterSelect({ icon: Icon, value, onChange, options, placeholder }: FilterSelectProps) {
    return (
        <div className="[position:relative]">
            <div style={{
                display: 'flex', alignItems: 'center', gap: '5px', padding: '5px 10px', borderRadius: '8px',
                background: value ? `${COLORS.primary}15` : 'var(--bg-primary, #0f0f1a)',
                border: `1px solid ${value ? COLORS.primary + '40' : 'var(--border-default, rgba(255,255,255,0.08))'}`,
                fontSize: '12px', fontWeight: 500,
                color: value ? COLORS.primary : 'var(--text-secondary, #aaa)',
                transition: 'all 0.15s ease',
            }}>
                {Icon && <Icon className="w-[12px] h-[12px] [flex-shrink:0]" />}
                <select
                    value={value || ''}
                    onChange={(e) => onChange(e.target.value || null)}
                    className="[background:transparent] [border:none] [outline:none] [color:inherit] [font-size:12px] [font-weight:500] [cursor:pointer] [appearance:none] [-webkit-appearance:none] min-w-[60px] [padding-right:14px]"
                >
                    <option value="">{placeholder}</option>
                    {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <ChevronDown className="w-[11px] h-[11px] [position:absolute] [right:8px] [pointer-events:none] [opacity:0.5]" />
            </div>
        </div>
    );
}

export function FilterBar({ filters, setFilters, userOptions = [], agentOptions = [], modelOptions = [], sourceOptions = [] }: FilterBarProps) {
    const { t } = useTranslation();
    const hasFilters = filters.user || filters.agent || filters.model || filters.source;
    const clear = () => setFilters({ user: null, agent: null, model: null, source: null });
    return (
        <div className="[display:flex] [align-items:center] [gap:6px] [flex-wrap:wrap] [padding:8px_12px] [border-radius:10px] [background:var(--bg-secondary,#1a1a2e)] [border:1px_solid_var(--border-default,rgba(255,255,255,0.08))] [margin-bottom:16px]">
            <div className="[display:flex] [align-items:center] [gap:4px] [margin-right:4px]">
                <Filter className="w-[12px] h-[12px] [color:var(--text-muted,#888)]" />
                <span className="[font-size:10px] [font-weight:700] [color:var(--text-muted,#888)] [text-transform:uppercase] [letter-spacing:0.05em]">{t('admin_monitoring.shared_filters', 'Filters')}</span>
            </div>
            <FilterSelect icon={Users} value={filters.user} onChange={v => setFilters(f => ({ ...f, user: v }))} options={userOptions} placeholder={t('admin_monitoring.shared_all_users', 'All Users')} />
            <FilterSelect icon={Bot} value={filters.agent} onChange={v => setFilters(f => ({ ...f, agent: v }))} options={agentOptions} placeholder={t('admin_monitoring.shared_all_agents', 'All Agents')} />
            <FilterSelect icon={Cpu} value={filters.model} onChange={v => setFilters(f => ({ ...f, model: v }))} options={modelOptions} placeholder={t('admin_monitoring.all_models', 'All Models')} />
            <FilterSelect icon={Activity} value={filters.source} onChange={v => setFilters(f => ({ ...f, source: v }))} options={sourceOptions} placeholder={t('admin_monitoring.all_sources', 'All Sources')} />
            {hasFilters && (
                <button onClick={clear} className="[display:flex] [align-items:center] [gap:4px] [padding:4px_8px] [border-radius:6px] [border:none] [background:var(--bg-tertiary,rgba(255,255,255,0.04))] [font-size:10px] [font-weight:600] [color:var(--text-muted,#888)] [cursor:pointer]">
                    <X className="w-[10px] h-[10px]" /> {t('admin_monitoring.shared_clear', 'Clear')}
                </button>
            )}
        </div>
    );
}

// ── Sortable Table ──────────────────────────────────────────────────────────

export function SortableTable<Row extends object>({ columns, data, onRowClick, emptyText, maxRows = 50 }: SortableTableProps<Row>) {
    const { t } = useTranslation();
    const [sortCol, setSortCol] = useState<string | null>(null);
    const [sortDir, setSortDir] = useState('desc');

    const handleSort = (colKey: string) => {
        if (sortCol === colKey) {
            setSortDir(d => d === 'desc' ? 'asc' : 'desc');
        } else {
            setSortCol(colKey);
            setSortDir('desc');
        }
    };

    const sorted = useMemo(() => {
        if (!sortCol) return data;
        return [...data].sort((a, b) => {
            const av = (a as Record<string, unknown>)[sortCol], bv = (b as Record<string, unknown>)[sortCol];
            if (typeof av === 'number' && typeof bv === 'number') {
                return sortDir === 'desc' ? bv - av : av - bv;
            }
            const as = String(av || ''), bs = String(bv || '');
            return sortDir === 'desc' ? bs.localeCompare(as) : as.localeCompare(bs);
        });
    }, [data, sortCol, sortDir]);

    if (data.length === 0) return <Empty text={emptyText ?? t('admin_monitoring.shared_no_data', 'No data')} />;

    const gridCols = columns.map(c => c.width || '1fr').join(' ');

    return (
        <div>
            {/* Header */}
            <div style={{
                display: 'grid', gridTemplateColumns: gridCols,
                gap: '8px', padding: '8px 12px', marginBottom: '2px',
                fontSize: '10px', fontWeight: 700, textTransform: 'uppercase',
                letterSpacing: '0.05em', color: 'var(--text-muted, #666)',
            }}>
                {columns.map(col => (
                    <span
                        key={col.key}
                        onClick={() => col.sortable !== false && handleSort(col.key)}
                        style={{
                            textAlign: (col.align || 'left') as CSSProperties['textAlign'],
                            cursor: col.sortable !== false ? 'pointer' : 'default',
                            userSelect: 'none',
                            display: 'flex', alignItems: 'center', gap: '3px',
                            justifyContent: col.align === 'right' ? 'flex-end' : 'flex-start',
                        }}
                    >
                        {col.label}
                        {sortCol === col.key && (
                            <span className="[font-size:8px] [opacity:0.7]">{sortDir === 'desc' ? '▼' : '▲'}</span>
                        )}
                    </span>
                ))}
            </div>
            {/* Rows */}
            {sorted.slice(0, maxRows).map((row, i) => (
                <div
                    key={(row as { _key?: string })._key || i}
                    onClick={() => onRowClick?.(row)}
                    style={{
                        display: 'grid', gridTemplateColumns: gridCols,
                        gap: '8px', padding: '10px 12px', borderRadius: '8px',
                        background: i % 2 === 0 ? 'transparent' : 'var(--bg-tertiary, rgba(255,255,255,0.02))',
                        alignItems: 'center',
                        cursor: onRowClick ? 'pointer' : 'default',
                        transition: 'background 0.12s',
                    }}
                    onMouseEnter={e => { if (onRowClick) e.currentTarget.style.background = 'var(--bg-tertiary, rgba(255,255,255,0.05))'; }}
                    onMouseLeave={e => { if (onRowClick) e.currentTarget.style.background = i % 2 === 0 ? 'transparent' : 'var(--bg-tertiary, rgba(255,255,255,0.02))'; }}
                >
                    {columns.map(col => (
                        <div key={col.key} style={{ textAlign: (col.align || 'left') as CSSProperties['textAlign'], overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {col.render ? col.render(row, i) : (
                                <span style={{ fontSize: '12px', fontWeight: 500, color: col.color || 'var(--text-primary, #fff)' }}>
                                    {(row as Record<string, ReactNode>)[col.key] ?? '—'}
                                </span>
                            )}
                        </div>
                    ))}
                </div>
            ))}
        </div>
    );
}

// ── Model / Agent Rows (lightweight) ────────────────────────────────────────

export function AgentRow({ agent: a, index, detailed }: { agent: UsageRecord; index: number; detailed?: boolean }) {
    const { t } = useTranslation();
    const style = getAgentStyle(a.agent_type);
    return (
        <div className="[display:flex] [justify-content:space-between] [align-items:center] [padding:10px_0] [border-bottom:1px_solid_var(--border-default,rgba(255,255,255,0.05))]">
            <div className="[display:flex] [align-items:center] [gap:8px] min-w-[0]">
                <span style={{
                    padding: '3px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                    background: style.bg, color: style.text, flexShrink: 0,
                }}>{a.agent_type || 'chat'}</span>
                <span style={{
                    fontSize: '12px', fontWeight: 600, color: 'var(--text-primary, #fff)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: detailed ? '200px' : '130px',
                }}>{a.agent_name || a.agent_id || t('admin_monitoring.unknown', 'Unknown')}</span>
            </div>
            <div className="[display:flex] [align-items:center] [gap:16px] [font-size:12px] [flex-shrink:0]">
                {detailed && (
                    <span className="[color:var(--text-muted,#888)]">{t('admin_monitoring.shared_avg', '{duration} avg', { duration: fmtDuration(a.avg_duration_ms) })}</span>
                )}
                <span style={{ color: COLORS.green, fontWeight: 600 }}>{t('admin_monitoring.shared_n_tok', '{n} tok', { n: fmt(a.total_tokens) })}</span>
                <span className="[color:var(--text-muted,#888)]">{t('admin_monitoring.shared_n_calls', '{n} calls', { n: a.calls })}</span>
                <span style={{ color: COLORS.amber, fontWeight: 600, minWidth: '50px', textAlign: 'right' }}>{fmtCost(a.estimated_cost || 0)}</span>
            </div>
        </div>
    );
}

// ── Skeleton / Loading ──────────────────────────────────────────────────────

function Skeleton({ height = 80, style }: SkeletonProps) {
    return (
        <div style={{
            height, borderRadius: '12px',
            background: 'var(--bg-tertiary, rgba(255,255,255,0.04))',
            animation: 'pulse 1.5s ease-in-out infinite',
            ...style,
        }} />
    );
}

function SkeletonGrid({ count = 4, height = 80 }: SkeletonGridProps) {
    return (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${count}, 1fr)`, gap: '12px' }}>
            {Array.from({ length: count }, (_, i) => <Skeleton key={i} height={height} />)}
        </div>
    );
}
