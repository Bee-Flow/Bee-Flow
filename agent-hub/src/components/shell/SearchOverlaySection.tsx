import { Bot, Clock } from 'lucide-react';
import React from 'react';
import type { PillGroupProps, FilterPillProps } from './SearchOverlay.types';

const PillGroup = ({ value, onChange, options, ariaLabel }: PillGroupProps) => (
    <div role="radiogroup" aria-label={ariaLabel} className="inline-flex h-8 bg-[var(--bg-tertiary)]/60 rounded-full p-0.5 border border-[var(--border-subtle)]">
        {options.map(opt => (
            <button
                key={opt.value}
                role="radio"
                aria-checked={value === opt.value}
                onClick={() => onChange(opt.value)}
                className={`px-3 text-[12px] font-medium rounded-full transition-all ${
                    value === opt.value
                        ? 'bg-[var(--bg-card)] text-[var(--text-primary)] shadow-sm'
                        : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]'
                }`}
            >
                {opt.label}
            </button>
        ))}
    </div>
);

/* Pill-shaped filter dropdown — matches the chrome of PillGroup so the whole
   filter row reads as one consistent set of chips. The native <select> sits
   transparently over the pill so the label updates without a custom popup. */
const FilterPill = ({ icon: Icon, value, onChange, options, disabled }: FilterPillProps) => {
    const active = value !== 'all' && value !== undefined && value !== null;
    return (
        <div
            className={`relative inline-flex items-center h-8 px-3 rounded-full border transition-colors ${
                disabled
                    ? 'opacity-40 pointer-events-none border-[var(--border-subtle)] bg-[var(--bg-tertiary)]/30'
                    : active
                        ? 'border-[var(--accent-primary)]/40 bg-[var(--accent-primary)]/10 text-[var(--accent-primary)]'
                        : 'border-[var(--border-subtle)] bg-[var(--bg-tertiary)]/60 hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'
            }`}
        >
            <Icon className={`w-3.5 h-3.5 mr-1.5 flex-shrink-0 ${active ? 'text-[var(--accent-primary)]' : 'text-[var(--text-tertiary)]'}`} />
            <select
                value={value}
                onChange={e => onChange(e.target.value)}
                disabled={disabled}
                className="bg-transparent border-none text-[12px] font-medium focus:ring-0 focus:outline-none cursor-pointer pr-4 appearance-none [color:inherit]!"
            >
                {options.map(o => <option key={o.value} value={o.value} className="text-[var(--text-primary)] bg-[var(--bg-card)]">{o.label}</option>)}
            </select>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="absolute right-2.5 pointer-events-none opacity-60">
                <path d="M2 4L5 7L8 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
        </div>
    );
};

export function SearchOverlaySection({ source, setSource, selectedAgent, setSelectedAgent, agents, dateRange, setDateRange, sortBy, setSortBy }: { source: string; setSource: React.Dispatch<React.SetStateAction<string>>; selectedAgent: string; setSelectedAgent: React.Dispatch<React.SetStateAction<string>>; agents: { id: string; name?: string; description?: string; emoji?: string; }[]; dateRange: string; setDateRange: React.Dispatch<React.SetStateAction<string>>; sortBy: string; setSortBy: React.Dispatch<React.SetStateAction<string>>; }) {
    return <div
        className="flex-shrink-0 flex items-center flex-wrap gap-2 px-5 py-3 border-b border-[var(--border-subtle)]"
    >
        <PillGroup
            value={source}
            onChange={setSource}
            options={[
                { value: 'all', label: 'All' },
                { value: 'agent', label: 'Agents' },
                { value: 'direct', label: 'Direct' },
            ]}
            ariaLabel="Source filter" />
        <FilterPill
            icon={Bot}
            value={selectedAgent}
            onChange={setSelectedAgent}
            disabled={source === 'direct'}
            options={[
                { value: 'all', label: 'All agents' },
                ...(Array.isArray(agents) ? agents.map(a => ({ value: a.id, label: a.name })) : []),
            ]} />
        <FilterPill
            icon={Clock}
            value={dateRange}
            onChange={setDateRange}
            options={[
                { value: 'all', label: 'Any time' },
                { value: '7d', label: 'Last 7 days' },
                { value: '30d', label: 'Last 30 days' },
                { value: '90d', label: 'Last 90 days' },
            ]} />
        <div className="flex-1" />
        <PillGroup
            value={sortBy}
            onChange={setSortBy}
            options={[
                { value: 'relevance', label: 'Relevance' },
                { value: 'date', label: 'Date' },
            ]}
            ariaLabel="Sort by" />
    </div>;
}
