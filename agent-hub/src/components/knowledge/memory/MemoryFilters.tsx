import { Search } from 'lucide-react';
import React, { useId, useState } from 'react';

import useDebouncedCallback from '../../../hooks/useDebouncedCallback';
import { useTranslation } from '../../../hooks/useTranslation';
import FilterPillsJs from '../../shared/FilterPills';
import SegmentedControl from '../../shared/SegmentedControl';
import {
    MEMORY_TYPE_IDS, typeLabel,
    type MemoryScope, type MemorySort, type MemoryType, type MemoryView,
} from './memoryTypes';

// FilterPills is plain JS whose default props infer as `undefined`; its real contract:
const FilterPills = FilterPillsJs as unknown as React.ComponentType<{
    value: string;
    onChange: (value: string) => void;
    options: { value: string; label: string; count?: number }[];
    ariaLabel?: string;
}>;

interface MemoryFiltersProps {
    view: MemoryView;
    onViewChange: (view: MemoryView) => void;
    /** Hidden when there is nothing to review and no sensitive opt-in. */
    showReview: boolean;
    pendingReview: number;
    scope: MemoryScope;
    onScopeChange: (scope: MemoryScope) => void;
    hasProject: boolean;
    search: string;
    onSearchChange: (value: string) => void;
    type: MemoryType | 'all';
    onTypeChange: (type: MemoryType | 'all') => void;
    typeCounts?: Partial<Record<string, number>>;
    allowedTypes?: readonly MemoryType[];
    sort: MemorySort;
    onSortChange: (sort: MemorySort) => void;
}

export default function MemoryFilters({
    view, onViewChange, showReview, pendingReview, scope, onScopeChange, hasProject, search, onSearchChange,
    type, onTypeChange, typeCounts, allowedTypes = MEMORY_TYPE_IDS, sort, onSortChange,
}: MemoryFiltersProps) {
    const { t } = useTranslation();
    const uid = useId();
    const [input, setInput] = useState(search);
    const commitSearch = useDebouncedCallback((value: string) => onSearchChange(value.trim()), 300);

    const viewOptions = [
        { value: 'active' as const, label: t('knowledge.memory_view_active', 'Memories') },
        ...(showReview ? [{
            value: 'review' as const,
            label: t('knowledge.memory_view_review', 'To review'),
            badge: pendingReview > 0 ? { count: pendingReview, tone: 'warning' as const } : undefined,
        }] : []),
        { value: 'archived' as const, label: t('knowledge.memory_view_archived', 'Archived') },
    ];

    const scopeOptions = [
        { value: 'personal' as const, label: t('knowledge.memory_scope_personal', 'Personal') },
        { value: 'agent' as const, label: t('knowledge.memory_scope_agents', 'Agents') },
        ...(hasProject ? [{ value: 'project' as const, label: t('knowledge.memory_scope_project', 'Project') }] : []),
        { value: 'all' as const, label: t('knowledge.memory_scope_all', 'All') },
    ];

    const typePills = [
        { value: 'all', label: t('knowledge.memory_all', 'All') },
        ...allowedTypes
            .filter((id) => typeCounts === undefined || (typeCounts[id] ?? 0) > 0 || id === type)
            .map((id) => ({ value: id, label: typeLabel(t, id), count: typeCounts?.[id] })),
    ];

    return (
        <div className="space-y-3">
            <SegmentedControl
                size="sm"
                ariaLabel={t('knowledge.memory_view_label', 'Show')}
                value={view}
                onChange={onViewChange}
                options={viewOptions}
            />
            {view !== 'review' && (
                <>
                    <div className="flex flex-wrap items-end gap-3">
                        <div className="relative min-w-48 flex-1">
                            <label htmlFor={`${uid}-search`} className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">
                                {t('knowledge.memory_search_label', 'Search memories')}
                            </label>
                            <Search className="pointer-events-none absolute bottom-2.5 left-3 h-4 w-4 text-[var(--text-tertiary)]" aria-hidden="true" />
                            <input
                                id={`${uid}-search`}
                                type="search"
                                value={input}
                                onChange={(e) => { setInput(e.target.value); commitSearch(e.target.value); }}
                                placeholder={t('project_content.memory_search', 'Search memories…')}
                                className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] py-2 pl-9 pr-3 text-sm text-[var(--text-primary)]"
                            />
                        </div>
                        <div>
                            <label htmlFor={`${uid}-sort`} className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">
                                {t('knowledge.memory_sort_label', 'Sort by')}
                            </label>
                            <select
                                id={`${uid}-sort`}
                                value={sort}
                                onChange={(e) => onSortChange(e.target.value as MemorySort)}
                                className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)]"
                            >
                                <option value="recent">{t('knowledge.memory_sort_recent', 'Recent')}</option>
                                <option value="last_used">{t('knowledge.memory_sort_last_used', 'Last used')}</option>
                                <option value="importance">{t('knowledge.memory_sort_importance', 'Importance')}</option>
                            </select>
                        </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                        <SegmentedControl
                            size="sm"
                            ariaLabel={t('knowledge.memory_source_label', 'Source')}
                            value={scope}
                            onChange={onScopeChange}
                            options={scopeOptions}
                        />
                        <FilterPills
                            ariaLabel={t('knowledge.memory_type_filter_label', 'Filter by type')}
                            value={type}
                            onChange={(v) => onTypeChange(v as MemoryType | 'all')}
                            options={typePills}
                        />
                    </div>
                </>
            )}
        </div>
    );
}
