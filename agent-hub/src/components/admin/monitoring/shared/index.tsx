import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp, Minus, X, Users, Bot, Cpu, Activity } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { usageSourceDetails } from '@/components/shared/usageAreaMeta';
import DashCard from '@/components/shared/dashboard/DashCard';
import StatTile from '@/components/shared/dashboard/StatTile';
import { CHIP, CHIP_INFO, QUIET_BTN } from '@/components/mcpLibrary/ui';
import type { UsageRow, ModelRate } from '../drawer/drawerTypes';
import type { UsageRecord, CardProps, MetricTileProps, InOutLabelProps, FilterBarProps, FilterOption, FilterState } from '../shared.types';
import { fmt } from './SvgAreaChart';
import { fmtCost, SeriesDot } from './ModelRow';
import { SelectField } from './FilterControls';

export { fmtCost, shortModel, InOutBar, SeriesDot } from './ModelRow';
export { fmt, Empty, SvgAreaChart } from './SvgAreaChart';
export { SortableTable } from './SortableTable';
export type { UsageRecord, ModelUsage, AgentUsage, UserUsage, ToolUsage, UsageSummary, ChartPoint, FilterState, SortableColumn } from '../shared.types';

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

/** The chip an agent's type wears: chat on the info tone, everything else neutral. */
export function agentChipClass(type: string | undefined) {
    return type === 'chat' || !type ? CHIP_INFO : CHIP;
}

// A ledger `source` named by the area it rolls up to (the shared vocabulary in
// shared/usageAreas.generated.mjs, the same meta the Settings usage pages
// read), so the AI Monitor and Usage & Monitoring use one set of names.
// An unknown source keeps its raw name under "Other".
export const getSourceDetails = (source: string | null | undefined, t?: (key: string, fallback: string) => string) =>
    usageSourceDetails(source, t);

// ── Base UI ─────────────────────────────────────────────────────────────────

/** A titled card on the dashboard surface (the shared DashCard). */
export function Card({ title, children, action, className }: CardProps) {
    return <DashCard title={title} action={action} className={className}>{children}</DashCard>;
}

/** A section with a heading above a table (the table is its own card). */
export function TablePanel({ title, meta, action, children, className = '' }: { title: string; meta?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
    return (
        <section aria-label={title} className={`flex min-w-0 flex-col gap-2 ${className}`}>
            <div className="flex items-end justify-between gap-3">
                <div className="min-w-0">
                    <h3 className="m-0 text-sm font-semibold text-[var(--text-primary)]">{title}</h3>
                    {meta && <p className="m-0 mt-0.5 text-[11px] text-[var(--text-tertiary)]">{meta}</p>}
                </div>
                {action}
            </div>
            {children}
        </section>
    );
}

function DeltaHint({ delta, note }: { delta?: number | null; note?: ReactNode }) {
    if (delta == null && !note) return null;
    const d = delta ?? 0;
    const DeltaIcon = d > 0 ? ArrowUp : d < 0 ? ArrowDown : Minus;
    const tone = d > 0 ? 'text-[var(--success-ink)]' : d < 0 ? 'text-[var(--error-ink)]' : 'text-[var(--text-tertiary)]';
    return (
        <span className="inline-flex flex-wrap items-center gap-1.5">
            {delta != null && (
                <span className={`inline-flex items-center gap-0.5 font-semibold tabular-nums ${tone}`}>
                    <DeltaIcon className="h-3 w-3" aria-hidden="true" />
                    {fmtPct(delta)}
                </span>
            )}
            {note && <span>{note}</span>}
        </span>
    );
}

/** A KPI: the shared StatTile, with the change against the previous period as its hint. */
export function MetricTile({ label, value, subtitle, delta, deltaLabel, testId }: MetricTileProps) {
    return <StatTile label={label} value={value} hint={<DeltaHint delta={delta} note={subtitle || deltaLabel} />} testId={testId} />;
}

export function InOutLabel({ input, output }: InOutLabelProps) {
    return (
        <div className="mt-1 flex gap-2.5 text-[11px] tabular-nums text-[var(--text-secondary)]">
            <span className="inline-flex items-center gap-1"><SeriesDot color="var(--chart-1)" square />{fmt(input)}</span>
            <span className="inline-flex items-center gap-1"><SeriesDot color="var(--chart-4)" square />{fmt(output)}</span>
        </div>
    );
}

// ── Filter Bar ──────────────────────────────────────────────────────────────

function FilterSelect({ icon, value, onChange, options, placeholder }: { icon: typeof Users; value: string | null; onChange: (v: string | null) => void; options: FilterOption[]; placeholder: string }) {
    return (
        <SelectField icon={icon} value={value || ''} onChange={v => onChange(v || null)} label={placeholder}>
            <option value="">{placeholder}</option>
            {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </SelectField>
    );
}

export function FilterBar({ filters, setFilters, userOptions = [], agentOptions = [], modelOptions = [], sourceOptions = [] }: FilterBarProps) {
    const { t } = useTranslation();
    const hasFilters = filters.user || filters.agent || filters.model || filters.source;
    const set = (key: keyof FilterState) => (v: string | null) => setFilters(f => ({ ...f, [key]: v }));
    return (
        <div role="group" aria-label={t('admin_monitoring.shared_filters', 'Filters')} className="flex flex-wrap items-center gap-2">
            <FilterSelect icon={Users} value={filters.user} onChange={set('user')} options={userOptions} placeholder={t('admin_monitoring.shared_all_users', 'All Users')} />
            <FilterSelect icon={Bot} value={filters.agent} onChange={set('agent')} options={agentOptions} placeholder={t('admin_monitoring.shared_all_agents', 'All Agents')} />
            <FilterSelect icon={Cpu} value={filters.model} onChange={set('model')} options={modelOptions} placeholder={t('admin_monitoring.all_models', 'All Models')} />
            <FilterSelect icon={Activity} value={filters.source} onChange={set('source')} options={sourceOptions} placeholder={t('admin_monitoring.all_sources', 'All Sources')} />
            {hasFilters && (
                <button type="button" onClick={() => setFilters({ user: null, agent: null, model: null, source: null })} className={QUIET_BTN}>
                    <X className="h-3 w-3" aria-hidden="true" /> {t('admin_monitoring.shared_clear', 'Clear')}
                </button>
            )}
        </div>
    );
}

// ── Agent row (Overview's top agents) ───────────────────────────────────────

export function AgentRow({ agent: a, onClick }: { agent: UsageRecord; onClick?: () => void }) {
    const { t } = useTranslation();
    return (
        <button
            type="button"
            onClick={onClick}
            className="flex w-full items-center justify-between gap-3 border-b border-[var(--border-default)] py-2.5 text-left last:border-b-0 hover:bg-[var(--bg-secondary)] focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
        >
            <span className="flex min-w-0 items-center gap-2">
                <span className={agentChipClass(a.agent_type)}>{a.agent_type || 'chat'}</span>
                <span className="truncate text-xs font-semibold text-[var(--text-primary)]">{a.agent_name || a.agent_id || t('admin_monitoring.unknown', 'Unknown')}</span>
            </span>
            <span className="flex shrink-0 items-center gap-4 text-xs tabular-nums">
                <span className="font-semibold text-[var(--text-primary)]">{t('admin_monitoring.shared_n_tok', '{n} tok', { n: fmt(a.total_tokens) })}</span>
                <span className="text-[var(--text-tertiary)]">{t('admin_monitoring.shared_n_calls', '{n} calls', { n: a.calls })}</span>
                <span className="min-w-[50px] text-right text-[var(--text-secondary)]">{fmtCost(a.estimated_cost || 0)}</span>
            </span>
        </button>
    );
}
