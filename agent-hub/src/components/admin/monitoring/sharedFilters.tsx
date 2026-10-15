import { Bot, ChevronDown, Cpu, Activity, Filter, Users, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from '../../../hooks/useTranslation';
import { COLORS } from './sharedFormat';

// ── Filter Bar ──────────────────────────────────────────────────────────────

export interface FilterOption {
    value?: string;
    label?: ReactNode;
}

/** Selected value per filter dimension; null means "all". */
export interface FilterState {
    user: string | null | undefined;
    agent: string | null | undefined;
    model: string | null | undefined;
    source: string | null | undefined;
}

interface FilterSelectProps {
    icon?: LucideIcon;
    value: string | null | undefined;
    onChange: (v: string | null) => void;
    options: FilterOption[];
    placeholder?: string;
}

function FilterSelect({ icon: Icon, value, onChange, options, placeholder }: FilterSelectProps) {
    return (
        <div style={{ position: 'relative' }}>
            <div style={{
                display: 'flex', alignItems: 'center', gap: '5px', padding: '5px 10px', borderRadius: '8px',
                background: value ? `${COLORS.primary}15` : 'var(--bg-primary, #0f0f1a)',
                border: `1px solid ${value ? COLORS.primary + '40' : 'var(--border-default, rgba(255,255,255,0.08))'}`,
                fontSize: '12px', fontWeight: 500,
                color: value ? COLORS.primary : 'var(--text-secondary, #aaa)',
                transition: 'all 0.15s ease',
            }}>
                {Icon && <Icon style={{ width: 12, height: 12, flexShrink: 0 }} />}
                <select
                    value={value || ''}
                    onChange={(e) => onChange(e.target.value || null)}
                    style={{
                        background: 'transparent', border: 'none', outline: 'none',
                        color: 'inherit', fontSize: '12px', fontWeight: 500,
                        cursor: 'pointer', appearance: 'none', WebkitAppearance: 'none',
                        minWidth: '60px', paddingRight: '14px',
                    }}
                >
                    <option value="">{placeholder}</option>
                    {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <ChevronDown style={{ width: 11, height: 11, position: 'absolute', right: 8, pointerEvents: 'none', opacity: 0.5 }} />
            </div>
        </div>
    );
}

interface FilterBarProps {
    filters: FilterState;
    setFilters: React.Dispatch<React.SetStateAction<FilterState>>;
    userOptions?: FilterOption[];
    agentOptions?: FilterOption[];
    modelOptions?: FilterOption[];
    sourceOptions?: FilterOption[];
}

export function FilterBar({ filters, setFilters, userOptions = [], agentOptions = [], modelOptions = [], sourceOptions = [] }: FilterBarProps) {
    const { t } = useTranslation();
    const hasFilters = filters.user || filters.agent || filters.model || filters.source;
    const clear = () => setFilters({ user: null, agent: null, model: null, source: null });

    return (
        <div style={{
            display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap',
            padding: '8px 12px', borderRadius: '10px',
            background: 'var(--bg-secondary, #1a1a2e)',
            border: '1px solid var(--border-default, rgba(255,255,255,0.08))',
            marginBottom: '16px',
        }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginRight: '4px' }}>
                <Filter style={{ width: 12, height: 12, color: 'var(--text-muted, #888)' }} />
                <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted, #888)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('admin_monitoring.shared_filters', 'Filters')}</span>
            </div>
            <FilterSelect icon={Users} value={filters.user} onChange={v => setFilters(f => ({ ...f, user: v }))} options={userOptions} placeholder={t('admin_monitoring.shared_all_users', 'All Users')} />
            <FilterSelect icon={Bot} value={filters.agent} onChange={v => setFilters(f => ({ ...f, agent: v }))} options={agentOptions} placeholder={t('admin_monitoring.shared_all_agents', 'All Agents')} />
            <FilterSelect icon={Cpu} value={filters.model} onChange={v => setFilters(f => ({ ...f, model: v }))} options={modelOptions} placeholder={t('admin_monitoring.all_models', 'All Models')} />
            <FilterSelect icon={Activity} value={filters.source} onChange={v => setFilters(f => ({ ...f, source: v }))} options={sourceOptions} placeholder={t('admin_monitoring.all_sources', 'All Sources')} />
            {hasFilters && (
                <button onClick={clear} style={{
                    display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 8px', borderRadius: '6px',
                    border: 'none', background: 'var(--bg-tertiary, rgba(255,255,255,0.04))',
                    fontSize: '10px', fontWeight: 600, color: 'var(--text-muted, #888)', cursor: 'pointer',
                }}>
                    <X style={{ width: 10, height: 10 }} /> {t('admin_monitoring.shared_clear', 'Clear')}
                </button>
            )}
        </div>
    );
}

