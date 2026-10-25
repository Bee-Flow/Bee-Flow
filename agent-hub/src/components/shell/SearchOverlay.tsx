import { Search, X, Clock, type LucideIcon } from 'lucide-react';
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { loadRecent, saveRecent } from './searchRecents';
import { API_BASE } from '../../utils/helpers';
import useTranslation, { TranslateParams } from '../../hooks/useTranslation';
import type { SearchMessage, SearchConversation, SearchResult, SearchOverlayProps, EmptyStateProps } from './SearchOverlay.types';
import { logger } from '../../utils/logger';
import { request, RefusedError } from '../../api/mutate';
import { SearchOverlaySection } from './SearchOverlaySection';
import { ResultRow } from './ResultRow';

const SearchOverlay = ({ isOpen, onClose, onSelectResult, agents = [] }: SearchOverlayProps) => {
    const { t } = useTranslation();
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<SearchResult[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [selectedIdx, setSelectedIdx] = useState(0);
    const [recent, setRecent] = useState(loadRecent);

    // Filters
    const [source, setSource] = useState('all'); // all, agent, direct
    const [selectedAgent, setSelectedAgent] = useState('all');
    const [dateRange, setDateRange] = useState('all');
    const [sortBy, setSortBy] = useState('date');

    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const debounceRef = useRef<NodeJS.Timeout>(null);
    const lastSearchedRef = useRef('');

    useEffect(() => {
        if (isOpen) {
            setTimeout(() => inputRef.current?.focus(), 50);
            setRecent(loadRecent());
        } else {
            // Reset on close so next open starts fresh
            setQuery('');
            setResults([]);
            setSelectedIdx(0);
        }
    }, [isOpen]);

    const buildFilters = useCallback(() => {
        const filters: { source?: string; agentId?: string; startDate?: string } = {};
        if (source !== 'all') filters.source = source;
        if (selectedAgent !== 'all' && source !== 'direct') filters.agentId = selectedAgent;
        if (dateRange !== 'all') {
            const past = new Date();
            if (dateRange === '7d') past.setDate(past.getDate() - 7);
            if (dateRange === '30d') past.setDate(past.getDate() - 30);
            if (dateRange === '90d') past.setDate(past.getDate() - 90);
            filters.startDate = past.toISOString();
        }
        return filters;
    }, [source, selectedAgent, dateRange]);

    const processResults = useCallback((conversations: SearchConversation[], searchTerm: string) => {
        const processed: SearchResult[] = [];
        const lowerTerm = searchTerm.toLowerCase();

        conversations.forEach((conv: SearchConversation) => {
            let messages: SearchMessage[] = [];
            try {
                messages = typeof conv.messages_json === 'string'
                    ? JSON.parse(conv.messages_json)
                    : conv.messages_json || [];
            } catch (err) { logger.debug('ignore', err); }

            const match = messages.find((m: SearchMessage) =>
                m.content && typeof m.content === 'string' &&
                m.content.toLowerCase().includes(lowerTerm)
            );

            if (match) {
                const content = match.content as string;
                const idx = content.toLowerCase().indexOf(lowerTerm);
                const start = Math.max(0, idx - 40);
                const end = Math.min(content.length, idx + searchTerm.length + 80);
                const snippet = (start > 0 ? '…' : '') +
                    content.substring(start, end) +
                    (end < content.length ? '…' : '');
                const relevanceScore = (content.match(new RegExp(lowerTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')) || []).length;
                processed.push({ ...conv, snippet, matchRole: match.role, relevanceScore });
            } else {
                processed.push({ ...conv, snippet: 'Matched in conversation title', matchRole: 'title', relevanceScore: 1 });
            }
        });
        return processed;
    }, []);

    const handleSearch = useCallback(async (searchTerm: string) => {
        if (!searchTerm || searchTerm.length < 2) {
            setResults([]);
            return;
        }
        lastSearchedRef.current = searchTerm;
        setIsLoading(true);
        try {
            const filters = buildFilters();
            const queryParams = new URLSearchParams({ q: searchTerm, ...filters });
            const res = await request(`${API_BASE}/agents/conversations/search?${queryParams.toString()}`).catch((err: unknown) => {
                if (err instanceof RefusedError) return null;
                throw err;
            });
            if (res) {
                const data = await res.json();
                if (lastSearchedRef.current === searchTerm) {
                    setResults(processResults(data, searchTerm));
                    setSelectedIdx(0);
                }
            }
        } catch (error) {
            console.error('Search failed:', error);
        } finally {
            setIsLoading(false);
        }
    }, [buildFilters, processResults]);

    useEffect(() => {
        if (query.length >= 2) handleSearch(query);
    }, [source, selectedAgent, dateRange]); // eslint-disable-line

    const handleInput = (e: React.ChangeEvent<HTMLInputElement, HTMLInputElement>) => {
        const val = e.target.value;
        setQuery(val);
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => handleSearch(val), 300);
    };

    const sortedResults = useMemo(() => {
        return [...results].sort((a, b) => {
            if (sortBy === 'relevance') {
                if (b.relevanceScore !== a.relevanceScore) return b.relevanceScore - a.relevanceScore;
                return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
            }
            return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
        });
    }, [results, sortBy]);

    const handleSelect = useCallback((result: SearchResult) => {
        if (query.trim()) setRecent(saveRecent(query.trim()));
        onSelectResult(result);
    }, [query, onSelectResult]);

    const resetFilters = () => {
        setSource('all');
        setSelectedAgent('all');
        setDateRange('all');
    };

    // Keyboard navigation
    useEffect(() => {
        if (!isOpen) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
            if (sortedResults.length === 0) return;
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSelectedIdx(i => Math.min(sortedResults.length - 1, i + 1));
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSelectedIdx(i => Math.max(0, i - 1));
            } else if (e.key === 'Enter') {
                e.preventDefault();
                const r = sortedResults[selectedIdx];
                if (r) handleSelect(r);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [isOpen, sortedResults, selectedIdx, onClose, handleSelect]);

    // Scroll selected row into view
    useEffect(() => {
        if (!listRef.current) return;
        const el = listRef.current.querySelector(`[data-idx="${selectedIdx}"]`);
        if (el) el.scrollIntoView({ block: 'nearest' });
    }, [selectedIdx]);

    if (!isOpen) return null;

    const hasFilters = source !== 'all' || selectedAgent !== 'all' || dateRange !== 'all';
    const showRecent = !query && recent.length > 0;

    return (
        <div
            className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[max(2rem,8vh)] pb-8 animate-fade-in [background:color-mix(in_srgb,var(--bg-primary,#0f172a)_55%,rgba(15,23,42,0.45))] [backdrop-filter:blur(8px)] [-webkit-backdrop-filter:blur(8px)]"
            onClick={onClose}
            role="dialog"
            aria-label={t('sidebar.search_conversations', 'Search conversations')}
            aria-modal="true"
        >
            <div
                className="w-[720px] max-w-[95vw] max-h-full flex flex-col rounded-2xl shadow-2xl overflow-hidden"
                data-surface="opaque"
                onClick={e => e.stopPropagation()}
                data-testid="search-overlay"
            >
                {/* Header: icon + input + clear + close */}
                <SearchOverlaySection2 inputRef={inputRef} query={query} handleInput={handleInput} t={t} sortedResults={sortedResults} selectedIdx={selectedIdx} setQuery={setQuery} setResults={setResults} onClose={onClose} />

                {/* Filter bar — all chips share the same pill chrome so it reads as one row */}
                <SearchOverlaySection source={source} setSource={setSource} selectedAgent={selectedAgent} setSelectedAgent={setSelectedAgent} agents={agents} dateRange={dateRange} setDateRange={setDateRange} sortBy={sortBy} setSortBy={setSortBy} />

                {/* Results */}
                <div ref={listRef} className="flex-1 overflow-y-auto custom-scrollbar" id="search-results" role="listbox">
                    {isLoading && sortedResults.length === 0 ? (
                        <div className="p-2 space-y-1">
                            {[0, 1, 2].map(i => <SkeletonRow key={i} />)}
                        </div>
                    ) : sortedResults.length > 0 ? (
                        <div className="p-2 space-y-0.5">
                            {sortedResults.map((result, idx) => (
                                <ResultRow
                                    key={`${result.kind || 'agent'}-${result.id}`}
                                    result={result}
                                    query={query}
                                    idx={idx}
                                    selected={idx === selectedIdx}
                                    onSelect={handleSelect}
                                    onHover={() => setSelectedIdx(idx)}
                                />
                            ))}
                        </div>
                    ) : query.length >= 2 ? (
                        <EmptyState
                            title={`No matches for "${query}"`}
                            hint={hasFilters ? 'Try removing some filters or changing your query.' : 'Try a different phrase.'}
                            action={hasFilters ? { label: 'Reset filters', onClick: resetFilters } : null}
                        />
                    ) : showRecent ? (
                        <div className="px-5 py-5">
                            <div className="flex items-center gap-2 mb-3">
                                <Clock className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                                <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">{t('sidebar.search_recent', 'Recent searches')}</span>
                            </div>
                            <div className="flex flex-wrap gap-2">
                                {recent.map(term => (
                                    <button
                                        key={term}
                                        onClick={() => {
                                            setQuery(term);
                                            handleSearch(term);
                                            inputRef.current?.focus();
                                        }}
                                        className="inline-flex items-center gap-1.5 px-3 h-7 rounded-full bg-[var(--bg-tertiary)]/70 hover:bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                                    >
                                        <Search className="w-3 h-3 text-[var(--text-tertiary)]" />
                                        {term}
                                    </button>
                                ))}
                            </div>
                        </div>
                    ) : (
                        <EmptyState
                            title={t('sidebar.search_empty_title', 'Search your conversations')}
                            hint={t('sidebar.search_empty_hint', 'Find messages across agent chats and direct conversations.')}
                        />
                    )}
                </div>

                {/* Footer */}
                {query.length >= 2 && (
                    <div className="flex-shrink-0 flex items-center justify-end px-4 h-9 border-t border-[var(--border-subtle)] bg-[var(--bg-secondary)]/30 text-[11px] text-[var(--text-tertiary)]">
                        <span>{sortedResults.length === 1 ? t('sidebar.search_result_count', '{count} result', { count: sortedResults.length }) : t('sidebar.search_result_count_plural', '{count} results', { count: sortedResults.length })}</span>
                    </div>
                )}
            </div>
        </div>
    );
};

// ── Sub-components ──────────────────────────────────────────────────────────

const SkeletonRow = () => (
    <div className="flex gap-3 p-3 animate-pulse">
        <div className="w-8 h-8 rounded-lg bg-[var(--bg-secondary)]" />
        <div className="flex-1 space-y-2">
            <div className="h-3 w-1/3 bg-[var(--bg-secondary)] rounded" />
            <div className="h-2.5 w-5/6 bg-[var(--bg-secondary)] rounded" />
            <div className="h-2.5 w-2/3 bg-[var(--bg-secondary)] rounded" />
        </div>
    </div>
);

const EmptyState = ({ title, hint, action }: EmptyStateProps) => (
    <div className="flex flex-col items-center justify-center text-center py-12 px-6">
        <div className="w-10 h-10 rounded-full bg-[var(--bg-secondary)] flex items-center justify-center mb-3">
            <Search className="w-4 h-4 text-[var(--text-tertiary)]" />
        </div>
        <div className="text-sm font-medium text-[var(--text-secondary)]">{title}</div>
        {hint && <div className="text-xs text-[var(--text-tertiary)] mt-1">{hint}</div>}
        {action && (
            <button
                onClick={action.onClick}
                className="mt-3 px-3 py-1.5 text-xs font-medium rounded-md bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-[var(--text-primary)] transition-colors"
            >
                {action.label}
            </button>
        )}
    </div>
);

export default SearchOverlay;

function SearchOverlaySection2({ inputRef, query, handleInput, t, sortedResults, selectedIdx, setQuery, setResults, onClose }: { inputRef: React.RefObject<HTMLInputElement | null>; query: string; handleInput: (e: React.ChangeEvent<HTMLInputElement, HTMLInputElement>) => void; t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; sortedResults: SearchResult[]; selectedIdx: number; setQuery: React.Dispatch<React.SetStateAction<string>>; setResults: React.Dispatch<React.SetStateAction<SearchResult[]>>; onClose: () => void; }) {
    return <div className="flex-shrink-0 flex items-center gap-3 px-5 h-16 border-b border-[var(--border-subtle)]">
        <Search className="w-[18px] h-[18px] text-[var(--text-tertiary)] flex-shrink-0" />
        <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={handleInput}
            placeholder={t('sidebar.search_placeholder', 'Search conversations and messages…')}
            className="flex-1 bg-transparent border-none text-[16px] text-[var(--text-primary)] placeholder-[var(--text-tertiary)] focus:ring-0 focus:outline-none"
            data-testid="search-input"
            aria-label={t('sidebar.search_query', 'Search query')}
            aria-controls="search-results"
            aria-activedescendant={sortedResults[selectedIdx] ? `search-result-${sortedResults[selectedIdx].id}` : undefined} />
        {query && (
            <button
                onClick={() => { setQuery(''); setResults([]); inputRef.current?.focus(); } }
                className="p-1.5 rounded-md hover:bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
                aria-label={t('sidebar.search_clear', 'Clear search')}
            >
                <X className="w-4 h-4" />
            </button>
        )}
        <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
            aria-label={t('sidebar.search_close', 'Close search')}
        >
            <X className="w-4 h-4" />
        </button>
    </div>;
}

