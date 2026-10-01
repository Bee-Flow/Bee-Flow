// The collapsible search row under a team chat's header: a query box, the
// "n of m" position, up/down through the matches, and a hint that only the
// loaded (decrypted) messages can be searched — with a way to pull in older
// ones when the chat has them.

import { ChevronDown, ChevronUp, Loader2, Search, X } from 'lucide-react';
import React from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { ChatSearch } from './useChatSearch';

const NAV_CLASS = 'grid place-items-center w-7 h-7 rounded-md text-[var(--text-secondary)] '
    + 'hover:text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)] disabled:opacity-40 disabled:pointer-events-none transition-colors';

export default function ChatSearchBar({ search, hasOlder, onLoadOlder, loadingOlder, onClose }: {
    search: ChatSearch;
    hasOlder: boolean;
    onLoadOlder: () => void;
    loadingOlder: boolean;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    const { query, matches } = search;
    const trimmed = query.trim();
    const offerOlder = !!trimmed && hasOlder && matches.length < 3;
    return (
        <div className="flex-shrink-0 px-4 pb-2" data-testid="team-chat-search-bar">
            <div className="max-w-4xl mx-auto">
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] focus-within:border-[var(--accent-primary)]">
                    <Search className="w-3.5 h-3.5 flex-shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
                    <input
                        value={query}
                        onChange={e => search.setQuery(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Escape') { e.preventDefault(); onClose(); }
                            else if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? search.prev() : search.next(); }
                        }}
                        aria-label={t('project_chat.search_in_chat', 'Search in this chat')}
                        placeholder={t('project_chat.search_placeholder', 'Search the messages of this chat')}
                        className="flex-1 min-w-0 bg-transparent text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none"
                    />
                    {trimmed && (
                        <span className="flex-shrink-0 text-[11.5px] tabular-nums text-[var(--text-secondary)]" data-testid="team-chat-search-count" role="status">
                            {matches.length
                                ? t('project_chat.search_match_of', '{current} of {total}', { current: search.active + 1, total: matches.length })
                                : t('project_chat.search_no_matches', 'No matches')}
                        </span>
                    )}
                    <button type="button" className={NAV_CLASS} onClick={search.prev} disabled={!matches.length}
                        aria-label={t('project_chat.search_prev', 'Previous match')} title={t('project_chat.search_prev', 'Previous match')}>
                        <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                    <button type="button" className={NAV_CLASS} onClick={search.next} disabled={!matches.length}
                        aria-label={t('project_chat.search_next', 'Next match')} title={t('project_chat.search_next', 'Next match')}>
                        <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                    <button type="button" className={NAV_CLASS} onClick={onClose}
                        aria-label={t('project_chat.close_search', 'Close search')} title={t('project_chat.close_search', 'Close search')}>
                        <X className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                </div>
                <div className="flex items-center gap-2 px-1 pt-1 text-[11px] text-[var(--text-tertiary)]">
                    <span>{t('project_chat.search_loaded_note', 'Searches only the messages loaded here — this chat is encrypted end-to-end.')}</span>
                    {offerOlder && (
                        <button type="button" onClick={onLoadOlder} disabled={loadingOlder}
                            className="inline-flex items-center gap-1 font-medium text-[var(--accent-primary)] hover:underline disabled:opacity-50">
                            {loadingOlder && <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />}
                            {t('project_chat.search_load_older', 'Load earlier messages to search further')}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
