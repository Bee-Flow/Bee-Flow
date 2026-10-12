import { Plus, Search, X } from 'lucide-react';
import React from 'react';
import type { SolutionSection } from './solutionSections';
import { kindInkClass } from './kindBar';
import { useTranslation } from '../../../../hooks/useTranslation';

/**
 * Search, filter pills and the way in for the Content tab. Pills exist only for
 * kinds the Solution holds; the status pill only when the checks have raised
 * something, because a filter that can never match is noise.
 */

export interface ContentToolbarProps {
    query: string;
    onQuery: (q: string) => void;
    kinds: Array<{ section: SolutionSection; count: number }>;
    activeKind: string | null;
    onKind: (kind: string | null) => void;
    /** Number of rows with a finding; 0 hides the status pill. */
    attentionCount: number;
    attention: boolean;
    onAttention: (on: boolean) => void;
    /** Present only for someone who may add. */
    onAdd?: () => void;
}

const PILL = 'inline-flex items-center gap-1.5 px-3 min-h-[44px] sm:min-h-9 rounded-full border text-xs font-medium whitespace-nowrap transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]';
const pillTone = (on: boolean) => on
    ? 'border-[var(--accent-primary)] bg-[var(--bg-tertiary)] text-[var(--text-primary)]'
    : 'border-[var(--border-subtle)] bg-[var(--bg-card)] text-[var(--text-secondary)] hover:bg-[var(--bg-card-hover)]';

export default function ContentToolbar({
    query, onQuery, kinds, activeKind, onKind, attentionCount, attention, onAttention, onAdd,
}: ContentToolbarProps) {
    const { t } = useTranslation();
    return (
        <div className="space-y-3" data-testid="content-toolbar">
            <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                <div className="relative flex-1 min-w-0">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-tertiary)] pointer-events-none" aria-hidden="true" />
                    <input
                        type="search"
                        value={query}
                        onChange={e => onQuery(e.target.value)}
                        aria-label={t('solutions.content_search', 'Search this Solution by name')}
                        placeholder={t('solutions.content_search_placeholder', 'Search by name')}
                        data-testid="content-search"
                        className="w-full h-11 sm:h-10 pl-9 pr-9 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-card)] text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
                    />
                    {query && (
                        <button type="button" onClick={() => onQuery('')} aria-label={t('solutions.content_search_clear', 'Clear search')}
                                className="absolute right-1 top-1/2 -translate-y-1/2 inline-flex items-center justify-center w-10 h-10 rounded-[var(--radius-sm)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]">
                            <X className="w-4 h-4" aria-hidden="true" />
                        </button>
                    )}
                </div>
                {onAdd && (
                    <div data-testid="solution-add-resource" className="sm:flex-shrink-0">
                        <button
                            type="button"
                            onClick={onAdd}
                            data-testid="add-parts-open"
                            className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 h-11 sm:h-10 px-4 rounded-[var(--radius-sm)] text-[13px] font-medium bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] focus-visible:ring-offset-2"
                        >
                            <Plus className="w-4 h-4" aria-hidden="true" />
                            {t('solutions.add_panel_title', 'Add to this Solution')}
                        </button>
                    </div>
                )}
            </div>

            {(kinds.length > 1 || attentionCount > 0) && (
                <div className="flex flex-wrap gap-2" role="group" aria-label={t('solutions.content_filters', 'Filter the content')} data-testid="content-filters">
                    {kinds.length > 1 && (
                        <button type="button" aria-pressed={activeKind === null} onClick={() => onKind(null)} data-testid="content-kind-all" className={`${PILL} ${pillTone(activeKind === null)}`}>
                            {t('solutions.filter_all', 'All')}
                        </button>
                    )}
                    {kinds.length > 1 && kinds.map(({ section, count }) => (
                        <button key={section.kind} type="button" aria-pressed={activeKind === section.kind}
                                onClick={() => onKind(activeKind === section.kind ? null : section.kind)}
                                data-testid={`content-kind-${section.kind}`} className={`${PILL} ${pillTone(activeKind === section.kind)}`}>
                            <section.icon className={`w-3.5 h-3.5 ${kindInkClass(section.kind)}`} aria-hidden="true" />
                            {t(section.labelKey)}
                            <span className="tabular-nums text-[var(--text-tertiary)]">{count}</span>
                        </button>
                    ))}
                    {attentionCount > 0 && (
                        <button type="button" aria-pressed={attention} onClick={() => onAttention(!attention)} data-testid="content-attention" className={`${PILL} ${pillTone(attention)}`}>
                            {t('solutions.filter_attention', 'Needs attention')}
                            <span className="tabular-nums text-[var(--text-tertiary)]">{attentionCount}</span>
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}
