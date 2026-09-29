import React, { useMemo, useRef, useState } from 'react';
import { ArrowUpDown, Check, Search } from 'lucide-react';
import AnchoredMenu from '../../../components/shared/AnchoredMenu';
import { FilterPill as FilterChip } from '../../../components/shared/FilterPills';
import useTranslation from '../../../hooks/useTranslation';

/**
 * The library rail's controls (Meeting Notes artboard 1a, the 300px rail):
 *
 *   [🔍 Search title, tag or text…]            [⇅]
 *   {viewSwitch}                                       ← Library | Upcoming n
 *   Alles · van mij · gedeeld · dataweging 4 · spelersmonitor 3 · +9 tags
 *
 * Tag chips carry COUNTS and fold: the most-used `VISIBLE_TAGS` show, the
 * rest sit behind one "+N tags" chip that expands the row in place (and
 * "Fewer tags" folds it back). A selected tag is always shown, whatever its
 * rank — a filter you cannot see is a filter you cannot switch off.
 *
 * The vocabulary comes in as `tags: [{ tag, count }]` (useMeetingTags: the
 * server's counts over everything the caller may read, the loaded rows as a
 * fallback). Sorting stays but folds into one icon button with an anchored
 * menu — a 300px rail has no room for a select next to the search field.
 */

export const VISIBLE_TAGS = 5;

const SORT_IDS = ['recent', 'oldest', 'longest', 'title'];

export default function LibraryFilters({
    query, onQueryChange,
    sort, onSortChange,
    owner, onOwnerChange,
    tag, onTagChange,
    tags = [],
    currentUserId,
    viewSwitch = null,
}) {
    const { t } = useTranslation();
    const [expanded, setExpanded] = useState(false);

    const sortLabels = {
        recent: t('meetings.sort_newest', 'Newest first'),
        oldest: t('meetings.sort_oldest', 'Oldest first'),
        longest: t('meetings.sort_longest', 'Longest first'),
        title: t('meetings.sort_title', 'Title (A → Z)'),
    };

    // Ordered by count DESC, then name; the active tag is pinned into the
    // visible slice so it can always be deselected.
    const { shown, hiddenCount } = useMemo(() => {
        const ordered = tags
            .filter((r) => r && typeof r.tag === 'string' && r.tag)
            .slice()
            .sort((a, b) => (b.count || 0) - (a.count || 0) || a.tag.localeCompare(b.tag));
        if (expanded || ordered.length <= VISIBLE_TAGS) return { shown: ordered, hiddenCount: 0 };
        const head = ordered.slice(0, VISIBLE_TAGS);
        if (tag && !head.some((r) => r.tag === tag)) {
            const pinned = ordered.find((r) => r.tag === tag);
            if (pinned) head.splice(VISIBLE_TAGS - 1, 1, pinned);
        }
        return { shown: head, hiddenCount: ordered.length - head.length };
    }, [tags, tag, expanded]);

    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-center gap-1.5">
                <div className="relative flex-1 min-w-0">
                    <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
                    <input
                        value={query}
                        onChange={(e) => onQueryChange(e.target.value)}
                        placeholder={t('meetings.search_placeholder', 'Search title, tag or text…')}
                        aria-label={t('meetings.search_label', 'Search meetings')}
                        className="w-full pl-8 pr-2 py-1.5 rounded-lg text-xs border outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
                        style={{ background: 'var(--bg-card)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                    />
                </div>
                <SortMenu sort={sort} onSortChange={onSortChange} labels={sortLabels} t={t} />
            </div>

            {viewSwitch}

            <div className="flex flex-wrap items-center gap-1" role="group" aria-label={t('meetings.filters_label', 'Filters')}>
                <FilterChip
                    label={t('meetings.filter_all', 'All')}
                    active={owner === 'all'}
                    onClick={() => onOwnerChange('all')}
                />
                {currentUserId && (
                    <>
                        <FilterChip
                            label={t('meetings.filter_mine', 'Mine')}
                            active={owner === 'mine'}
                            onClick={() => onOwnerChange('mine')}
                        />
                        <FilterChip
                            label={t('meetings.filter_shared', 'Shared')}
                            active={owner === 'shared'}
                            onClick={() => onOwnerChange('shared')}
                        />
                    </>
                )}
                {shown.map((r) => (
                    <FilterChip
                        key={r.tag}
                        label={r.tag}
                        count={r.count}
                        active={tag === r.tag}
                        onClick={() => onTagChange(tag === r.tag ? null : r.tag)}
                    />
                ))}
                {hiddenCount > 0 && (
                    <button
                        type="button"
                        onClick={() => setExpanded(true)}
                        data-testid="meetings-more-tags"
                        className="px-2 py-0.5 rounded-full text-[11px] border transition-colors hover:bg-[var(--bg-tertiary)]"
                        style={{ borderColor: 'var(--border-default)', color: 'var(--text-tertiary)' }}
                    >
                        {t('meetings.more_tags', '+{count} tags', { count: hiddenCount })}
                    </button>
                )}
                {expanded && tags.length > VISIBLE_TAGS && (
                    <button
                        type="button"
                        onClick={() => setExpanded(false)}
                        className="px-2 py-0.5 rounded-full text-[11px] border transition-colors hover:bg-[var(--bg-tertiary)]"
                        style={{ borderColor: 'var(--border-default)', color: 'var(--text-tertiary)' }}
                    >
                        {t('meetings.fewer_tags', 'Fewer tags')}
                    </button>
                )}
            </div>
        </div>
    );
}

/**
 * The 11px counted capsule used to live here; it is now the shared
 * `FilterPill` (components/shared/FilterPills.jsx — the neutral tone IS this
 * chip, pixel for pixel), re-exported under its old name for the callers that
 * import `FilterChip` from this file.
 */
export { FilterChip };

function SortMenu({ sort, onSortChange, labels, t }) {
    const [open, setOpen] = useState(false);
    const anchorRef = useRef(null);
    return (
        <>
            <button
                ref={anchorRef}
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={t('meetings.sort_label', 'Sort')}
                title={labels[sort] || labels.recent}
                className="grid place-items-center w-7 h-7 rounded-lg border flex-shrink-0 transition-colors hover:bg-[var(--bg-tertiary)]"
                style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)', background: 'var(--bg-card)' }}
            >
                <ArrowUpDown className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
            <AnchoredMenu
                open={open}
                onClose={() => setOpen(false)}
                anchorRef={anchorRef}
                align="right"
                width={180}
                role="menu"
                aria-label={t('meetings.sort_label', 'Sort')}
                className="py-1"
            >
                {SORT_IDS.map((id) => {
                    const active = id === sort;
                    return (
                        <button
                            key={id}
                            type="button"
                            role="menuitemradio"
                            aria-checked={active}
                            onClick={() => { onSortChange(id); setOpen(false); }}
                            className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 transition ${
                                active
                                    ? 'text-[var(--text-primary)] bg-[var(--bg-secondary)]'
                                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]'
                            }`}
                        >
                            <Check size={12} aria-hidden="true" className={active ? 'opacity-100' : 'opacity-0'} />
                            {labels[id]}
                        </button>
                    );
                })}
            </AnchoredMenu>
        </>
    );
}
