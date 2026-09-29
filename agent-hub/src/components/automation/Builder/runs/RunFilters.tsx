import React, { useEffect, useState } from 'react';
import { Calendar, ChevronDown, FlaskConical, Search } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { RunFacetCounts, RunListFilters, RunPeriod, RunStatusFilter } from '../../../../api/queries/automation/runs';
import { useRunFacets } from '../../../../api/queries/automation/runs';

/** A pasted run link (`?run=<id>`) or a bare run uuid; null for search text. */
export function runLinkId(text: string): string | null {
    const s = text.trim();
    const fromQuery = /[?&]run=([A-Za-z0-9_-]{6,})/.exec(s);
    if (fromQuery) return fromQuery[1];
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuid.test(s) ? s : null;
}

interface RunFiltersProps {
    automationId: string;
    active: boolean;
    filters: RunListFilters;
    onChange: (next: RunListFilters) => void;
    onOpenRun: (runId: string) => void;
}

const SEARCH_DEBOUNCE_MS = 300;

/** All n · Failed n · Waiting for someone n · Running n. */
function StatusSegments({ facets, value, onPick }: {
    facets: RunFacetCounts | undefined;
    value: RunStatusFilter;
    onPick: (v: RunStatusFilter) => void;
}) {
    const { t } = useTranslation();
    const segments: Array<{ value: RunStatusFilter; label: string; count?: number; tone?: string }> = [
        { value: 'all', label: t('runs.tab.filter_all', 'All'), count: facets?.all },
        { value: 'failed', label: t('runs.tab.filter_failed', 'Failed'), count: facets?.failed, tone: 'text-[var(--error)]' },
        { value: 'waiting', label: t('runs.tab.filter_waiting', 'Waiting for someone'), count: facets?.waiting },
        { value: 'running', label: t('runs.tab.filter_running', 'Running'), count: facets?.running },
    ];
    return (
        <div role="tablist" aria-label={t('runs.tab.filter_label', 'Show runs')} className="order-1 flex bg-[var(--bg-tertiary)] rounded-lg p-0.5 gap-0.5 font-medium">
            {segments.map((s) => {
                const on = value === s.value;
                const hot = s.tone && (s.count || 0) > 0 ? s.tone : 'text-[var(--text-secondary)]';
                return (
                    <button
                        key={s.value}
                        type="button"
                        role="tab"
                        aria-selected={on}
                        onClick={() => onPick(s.value)}
                        className={`px-2.5 py-1 rounded-md whitespace-nowrap transition ${on ? 'bg-[var(--bg-card)] shadow-sm text-[var(--text-primary)]' : `${hot} hover:text-[var(--text-primary)]`}`}
                    >
                        {s.label}
                        {s.count != null && <span className="ml-1 text-[var(--text-tertiary)]">{s.count}</span>}
                    </button>
                );
            })}
        </div>
    );
}

/**
 * Status, period, search and the test-run switch above the list, as one
 * wrapping row. The list's own width decides the pairing: from 520px the
 * period sits beside the status segments and the switch shows its words; a
 * narrower list pairs the segments with the bare switch and the period with
 * the search, so it stays two calm rows instead of three. The search's 240px
 * basis is what sends it to the second row.
 */
export default function RunFilters({ automationId, active, filters, onChange, onOpenRun }: RunFiltersProps) {
    const { t } = useTranslation();
    const facets = useRunFacets(automationId, filters, active).data;
    const [text, setText] = useState(filters.q);

    // Typing settles before it queries.
    useEffect(() => {
        if (text === filters.q) return undefined;
        const timer = setTimeout(() => onChange({ ...filters, q: text }), SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [text, filters, onChange]);

    // A pasted run link is not a search: it opens that run.
    const onType = (value: string) => {
        const id = runLinkId(value);
        if (id) {
            setText(filters.q);
            onOpenRun(id);
            return;
        }
        setText(value);
    };

    const periods: Array<{ value: RunPeriod; label: string }> = [
        { value: 24, label: t('runs.tab.period_24h', 'Last 24 hours') },
        { value: 168, label: t('runs.tab.period_7d', 'Last 7 days') },
        { value: 720, label: t('runs.tab.period_30d', 'Last 30 days') },
        { value: 0, label: t('runs.tab.period_all', 'All time') },
    ];
    const showTests = t('runs.tab.show_tests', 'Show test runs');

    return (
        <div className="@container/runfilters border-b border-[var(--border-default)] text-xs">
            <div className="px-4 py-3 flex flex-wrap items-center gap-x-2 gap-y-2.5">
                <StatusSegments facets={facets} value={filters.status} onPick={(status) => onChange({ ...filters, status })} />
                <label className="order-4 @[520px]/runfilters:order-2 ml-auto relative inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[var(--border-default)] text-[var(--text-primary)]">
                    <Calendar size={12} aria-hidden />
                    <span className="sr-only">{t('runs.tab.period_label', 'Period')}</span>
                    <select
                        value={filters.period}
                        onChange={(e) => onChange({ ...filters, period: Number(e.target.value) as RunPeriod })}
                        className="appearance-none bg-transparent pr-4 outline-none cursor-pointer"
                    >
                        {periods.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                    </select>
                    <ChevronDown size={12} aria-hidden className="absolute right-2 pointer-events-none text-[var(--text-tertiary)]" />
                </label>
                <label className="order-3 grow basis-[240px] min-w-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[var(--border-default)] text-[var(--text-tertiary)] focus-within:border-[var(--accent-primary)]">
                    <Search size={13} aria-hidden className="shrink-0" />
                    <input
                        type="search"
                        value={text}
                        onChange={(e) => onType(e.target.value)}
                        placeholder={t('runs.tab.search_placeholder', 'Search by file name, person or run link…')}
                        aria-label={t('runs.tab.search_label', 'Search runs')}
                        className="flex-1 min-w-0 bg-transparent outline-none text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
                    />
                </label>
                <button
                    type="button"
                    role="switch"
                    aria-checked={filters.showTests}
                    aria-label={showTests}
                    title={showTests}
                    onClick={() => onChange({ ...filters, showTests: !filters.showTests })}
                    className="order-2 @[520px]/runfilters:order-4 ml-auto flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[var(--border-default)] text-[var(--text-secondary)] whitespace-nowrap"
                >
                    <FlaskConical size={12} aria-hidden />
                    <span className="hidden @[520px]/runfilters:inline">{showTests}</span>
                    <span className={`relative w-[26px] h-4 rounded-full transition ${filters.showTests ? 'bg-[var(--type-trigger)]' : 'bg-[var(--bg-tertiary)]'}`}>
                        <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${filters.showTests ? 'right-0.5' : 'left-0.5'}`} />
                    </span>
                </button>
            </div>
        </div>
    );
}
