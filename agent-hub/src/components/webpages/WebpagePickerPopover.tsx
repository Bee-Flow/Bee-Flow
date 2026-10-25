import React, { useEffect, useRef, useState, useMemo } from 'react';
import { Globe, Search, Loader2 } from 'lucide-react';
import { useWebpageListQuery } from '../../api/queries/webpagesPanels';
import { useTranslation } from '../../hooks/useTranslation';
import type { WebpageRow } from '../../api/webpagesWebpageRow.types';
import { errorMessage } from '../../utils/caughtError';

interface WebpagePickerPopoverProps {
    anchorRef?: React.RefObject<HTMLElement | null>;
    open: boolean;
    onClose: () => void;
    onSelect: (id: string) => void;
}

/**
 * Compact popover that lists webpages the user can see (owned + published
 * to their org/groups). Selecting one fires onSelect(id) and closes.
 *
 * Mirrors the click-outside pattern from AgentWizard/pickers/PublishMenu.jsx
 * — same ref dance so two popovers can't fight each other for the document
 * listener.
 */
export default function WebpagePickerPopover({ anchorRef, open, onClose, onSelect }: WebpagePickerPopoverProps) {
    const { t } = useTranslation();
    const popoverRef = useRef<HTMLDivElement>(null);
    const [search, setSearch] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');
    const listQuery = useWebpageListQuery(open);
    // Every open starts from a fresh read: nothing of the previous answer shows while it loads.
    const loading = listQuery.isFetching || (open && listQuery.isPending);
    const state = {
        loading,
        items: loading ? [] : (listQuery.data ?? []),
        error: !loading && listQuery.isError ? errorMessage(listQuery.error) : null,
    };

    // Debounce the search term so each keystroke doesn't re-run the filter
    // (and trigger a fresh useMemo) — irrelevant for small lists, but the
    // picker can show hundreds of pages once an org racks up webpages.
    useEffect(() => {
        const id = setTimeout(() => setDebouncedSearch(search), 120);
        return () => clearTimeout(id);
    }, [search]);

    useEffect(() => {
        if (!open) return;
        const onDoc = (e: MouseEvent) => {
            if (popoverRef.current?.contains(e.target as Node)) return;
            if (anchorRef?.current?.contains(e.target as Node)) return;
            onClose();
        };
        document.addEventListener('mousedown', onDoc);
        return () => document.removeEventListener('mousedown', onDoc);
    }, [open, onClose, anchorRef]);

    const filtered = useMemo(() => {
        const q = debouncedSearch.trim().toLowerCase();
        if (!q) return state.items;
        return state.items.filter((w: WebpageRow) => (w.name || '').toLowerCase().includes(q));
    }, [debouncedSearch, state.items]);

    if (!open) return null;

    return (
        <div
            ref={popoverRef}
            className="absolute z-30 right-0 top-full mt-1 w-[320px] rounded-xl border shadow-xl overflow-hidden bg-[var(--bg-primary)] border-[var(--border-default)]"
        >
            <div className="px-3 py-2 border-b border-[var(--border-subtle)]">
                <div className="text-xs font-medium text-[var(--text-primary)]">{t('webpages.picker.title', 'Open a webpage')}</div>
                <div className="text-[11px] text-[var(--text-tertiary)]">
                    {t('webpages.picker.hint', 'Choose one to view alongside the chat.')}
                </div>
            </div>
            <div className="px-2 py-2 border-b border-[var(--border-subtle)]">
                <div className="relative">
                    <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
                    <input
                        autoFocus
                        type="text"
                        placeholder={t('webpages.picker.search', 'Search webpages…')}
                        value={search}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
                        className="w-full pl-7 pr-2 py-1.5 text-xs rounded-lg border outline-none [background:var(--bg-secondary)] [color:var(--text-primary)]! [border-color:var(--border-subtle)]"
                    />
                </div>
            </div>
            <div className="max-h-[300px] overflow-y-auto">
                {state.loading && (
                    <div className="py-6 flex items-center justify-center">
                        <Loader2 className="w-4 h-4 animate-spin text-[var(--accent-primary)]" />
                    </div>
                )}
                {!state.loading && state.error && (
                    <div className="px-4 py-6 text-xs text-center text-[var(--text-tertiary)]">
                        {state.error}
                    </div>
                )}
                {!state.loading && !state.error && filtered.length === 0 && (
                    <div className="px-4 py-6 text-xs text-center text-[var(--text-tertiary)]">
                        {state.items.length === 0
                            ? 'No webpages yet — create one in Studio › Webpages.'
                            : 'No matches.'}
                    </div>
                )}
                {filtered.map((w: WebpageRow) => (
                    <button
                        key={w.id}
                        onClick={() => { onSelect(w.id); onClose(); }}
                        className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-[var(--bg-secondary)] transition-colors"
                    >
                        <Globe className="w-4 h-4 shrink-0 text-[var(--accent-primary)]" />
                        <div className="flex-1 min-w-0">
                            <div className="text-xs font-medium truncate text-[var(--text-primary)]">{w.name}</div>
                            {w.isPublished && (
                                <div className="text-[10px] text-[var(--text-tertiary)]">
                                    {Array.isArray(w.sharedGroups) && w.sharedGroups.length > 0 ? (w.sharedGroups.length === 1 ? t('webpages.picker.shared_one_group', 'Shared · 1 group') : t('webpages.picker.shared_groups', 'Shared · {count} groups', { count: w.sharedGroups.length })) : t('webpages.picker.shared', 'Shared')}
                                </div>
                            )}
                        </div>
                    </button>
                ))}
            </div>
        </div>
    );
}
