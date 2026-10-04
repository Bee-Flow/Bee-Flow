import { Loader2, Search } from 'lucide-react';
import React, { useMemo } from 'react';
import type { AddItem, KindLoad } from './addPartsSources';
import { useTranslation } from '../../../../hooks/useTranslation';

/**
 * The search box and the checklist of ONE kind. Four states stay apart because
 * they send someone to four different places: still loading, could not be read
 * (with a retry), read and empty ("nothing of yours left"), and read but
 * filtered away by the search. What sits in another Solution is listed,
 * disabled, with that Solution's name.
 */

export const keyOf = (i: Pick<AddItem, 'kind' | 'id'>) => `${i.kind}:${i.id}`;

export interface AddKindListProps {
    load: KindLoad | undefined;
    query: string;
    onQuery: (q: string) => void;
    names: Map<string, string>;
    picked: Set<string>;
    busy: boolean;
    onToggle: (item: AddItem) => void;
    onRetry: () => void;
}

function Note({ children, testId }: { children: React.ReactNode; testId: string }) {
    return (
        <p className="px-3 py-2 rounded-[var(--radius-md)] text-xs bg-[var(--bg-secondary)] text-[var(--text-secondary)]" data-testid={testId}>
            {children}
        </p>
    );
}

function Row({ item, owner, checked, busy, onToggle }: { item: AddItem; owner: string | undefined; checked: boolean; busy: boolean; onToggle: () => void }) {
    const { t } = useTranslation();
    const taken = item.inProjectId !== null;
    return (
        <li>
            <label className={`flex items-center gap-3 px-3 min-h-[44px] rounded-[var(--radius-md)] text-sm border border-[var(--border-subtle)] bg-[var(--bg-card)] hover:bg-[var(--bg-card-hover)] focus-within:ring-2 focus-within:ring-[var(--accent-primary)] ${taken ? 'opacity-60' : 'cursor-pointer'}`}>
                <input type="checkbox" disabled={taken || busy} checked={checked} onChange={onToggle} className="w-4 h-4 accent-[var(--accent-primary)]" />
                <span className="flex-1 min-w-0 truncate text-[var(--text-primary)]">{item.label}</span>
                {taken && (
                    <span className="text-[11px] flex-shrink-0 text-[var(--text-tertiary)]" data-testid="add-parts-taken">
                        {owner
                            ? t('solutions.add_in_other', 'In {name}', { name: owner })
                            : t('solutions.add_in_other_unnamed', 'In another Solution')}
                    </span>
                )}
            </label>
        </li>
    );
}

export default function AddKindList({ load, query, onQuery, names, picked, busy, onToggle, onRetry }: AddKindListProps) {
    const { t } = useTranslation();
    const visible = useMemo(() => {
        if (!load || load.status !== 'ok') return [];
        const q = query.trim().toLowerCase();
        return load.items.filter(i => !q || i.label.toLowerCase().includes(q));
    }, [load, query]);
    const total = load && load.status === 'ok' ? load.items.length : 0;

    return (
        <div className="space-y-2">
            <label className="relative block">
                <span className="sr-only">{t('solutions.add_search', 'Search by name')}</span>
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-tertiary)]" aria-hidden="true" />
                <input
                    type="search"
                    value={query}
                    onChange={(e) => onQuery(e.target.value)}
                    placeholder={t('solutions.add_search', 'Search by name')}
                    className="w-full pl-8 pr-2 h-10 rounded-[var(--radius-sm)] text-sm border border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
                />
            </label>

            {(!load || load.status === 'loading') && (
                <p className="flex items-center gap-2 px-3 py-2 text-xs text-[var(--text-tertiary)]" data-testid="add-parts-loading">
                    <Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                    {t('solutions.add_loading', 'Loading…')}
                </p>
            )}
            {load?.status === 'error' && (
                <p role="alert" className="flex flex-wrap items-center gap-2 px-3 py-2 rounded-[var(--radius-md)] text-xs border-l-[3px] border-l-[var(--error)] bg-[var(--bg-secondary)] text-[var(--text-primary)]" data-testid="solution-add-error">
                    {t('solutions.add_list_failed', 'That list could not be loaded. Try again shortly.')}
                    <button type="button" onClick={onRetry} className="underline min-h-[28px] rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]" data-testid="add-parts-retry">
                        {t('solutions.add_retry', 'Try again')}
                    </button>
                </p>
            )}
            {load?.status === 'ok' && total === 0 && (
                <Note testId="add-parts-none-left">{t('solutions.add_nothing_left', 'Nothing of yours left to add here.')}</Note>
            )}
            {total > 0 && visible.length === 0 && (
                <Note testId="add-parts-no-match">{t('solutions.add_no_match', 'Nothing matches “{query}”.', { query: query.trim() })}</Note>
            )}
            {visible.length > 0 && (
                <ul className="space-y-1 max-h-64 overflow-y-auto" data-testid="add-parts-list">
                    {visible.map(item => (
                        <Row key={keyOf(item)} item={item} owner={item.inProjectId ? names.get(item.inProjectId) : undefined}
                             checked={picked.has(keyOf(item))} busy={busy} onToggle={() => onToggle(item)} />
                    ))}
                </ul>
            )}
        </div>
    );
}
