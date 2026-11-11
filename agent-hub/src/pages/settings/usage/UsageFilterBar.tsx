import { useMemo } from 'react';
import { Activity, Bot, ChevronDown, Cpu, Filter, Users, X, type LucideIcon } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import type { DropdownOption } from '../PreferencesSection.types';
import { shortModel } from './format';
import type { UsageFilters } from './useUsageFilters';
import type { UsageData } from './useUsageReportData';
import { getSourceDetails } from './widgets';

interface FilterPillProps {
    icon: LucideIcon;
    value: string | null;
    onChange: (v: string | null) => void;
    options: DropdownOption[];
    placeholder: string;
}

const FilterPill = ({ icon: Icon, value, onChange, options, placeholder }: FilterPillProps) => (
    <div className="[position:relative]">
        <div className={`flex items-center gap-[5px] rounded-lg border px-2.5 py-[5px] text-xs font-medium transition-all ${value
            ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)] text-white'
            : 'border-[var(--border-subtle)] bg-[var(--bg-primary)] text-[var(--text-secondary)]'}`}>
            {Icon && <Icon className="w-[12px] h-[12px] [flex-shrink:0]" />}
            <select value={value || ''} onChange={(e) => onChange(e.target.value || null)} className="[background:transparent] [border:none] [outline:none] [color:inherit] [font-size:12px] [font-weight:500] [cursor:pointer] [appearance:none] [-webkit-appearance:none] min-w-[60px] [padding-right:14px]">
                <option value="">{placeholder}</option>
                {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <ChevronDown className="w-[11px] h-[11px] [position:absolute] [right:8px] [pointer-events:none] [opacity:0.5]" />
        </div>
    </div>
);

/** Options of the four pills, from the lists the report answered with. */
function useFilterOptions(data: UsageData) {
    const { t } = useTranslation();
    return useMemo(() => ({
        users: data.users.map(u => ({ value: u.user_id, label: u.display_name || u.user_id })),
        agents: data.agents.map(a => ({ value: a.agent_id || a.agent_name, label: a.agent_name || 'Direct Chat' })),
        models: data.models.map(m => ({ value: m.model, label: shortModel(m.model) })),
        sources: data.sources.map(s => ({ value: s.source, label: getSourceDetails(s.source, t).label })),
    }), [data.users, data.agents, data.models, data.sources, t]);
}

interface UsageFilterBarProps {
    filters: UsageFilters;
    data: UsageData;
    /** The customer view abstracts models into tiers, so it has no model pill. */
    isCustomerView: boolean;
}

/** User / agent / model / source filters of the Overview and Spend reports. */
export function UsageFilterBar({ filters, data, isCustomerView }: UsageFilterBarProps) {
    const { t } = useTranslation();
    const options = useFilterOptions(data);
    return (
        <div className="flex flex-wrap items-center gap-1.5 rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-2.5 py-1.5">
            <div className="[display:flex] [align-items:center] [gap:4px] [margin-right:2px]">
                <Filter className="w-[12px] h-[12px] [color:var(--text-muted)]" />
                <span className="[font-size:10px] [font-weight:700] [color:var(--text-muted)] [text-transform:uppercase] [letter-spacing:0.05em]">{t('usage.filters')}</span>
            </div>
            <FilterPill icon={Users} value={filters.user} onChange={filters.setUser} options={options.users} placeholder={t('usage.all_users')} />
            <FilterPill icon={Bot} value={filters.agent} onChange={filters.setAgent} options={options.agents} placeholder={t('usage.all_agents')} />
            {!isCustomerView && (
                <FilterPill icon={Cpu} value={filters.model} onChange={filters.setModel} options={options.models} placeholder={t('usage.all_models')} />
            )}
            <FilterPill icon={Activity} value={filters.source} onChange={filters.setSource} options={options.sources} placeholder={t('usage.all_sources')} />
            {filters.active && (
                <button onClick={filters.clear} className="[display:flex] [align-items:center] [gap:4px] [padding:4px_8px] [border-radius:6px] [border:none] [background:var(--bg-tertiary)] [font-size:10px] [font-weight:600] [color:var(--text-muted)] [cursor:pointer]">
                    <X className="w-[10px] h-[10px]" /> {t('usage.clear')}
                </button>
            )}
        </div>
    );
}
