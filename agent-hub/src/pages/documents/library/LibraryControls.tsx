// The library's filters (search, type, visibility, category, sort) and the
// bar that acts on the selected documents (move to a folder, categorise).

import { Search } from 'lucide-react';
import React, { useState } from 'react';
import useTranslation from '../../../hooks/useTranslation';
import type { Folder } from '../documentQueries';
import type { LibraryFormat, useLibraryFilters } from './useLibrary';

const INPUT = 'rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-3 py-2 text-sm min-w-0 text-[var(--text-primary)]';
const BUTTON = 'inline-flex items-center gap-2 rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-sm hover:bg-[var(--item-hover-bg)] disabled:opacity-50';

export function LibraryFilterBar({ f }: { f: ReturnType<typeof useLibraryFilters> }) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-wrap gap-2">
            <label className="flex items-center gap-2 flex-1 min-w-48">
                <Search size={17} aria-hidden="true" className="text-[var(--text-tertiary)]" />
                <input className={`${INPUT} w-full`} value={f.query} onChange={(e) => f.setQuery(e.target.value)} placeholder={t('documents.library.search_placeholder', 'Search documents…')} aria-label={t('documents.library.search', 'Search documents')} />
            </label>
            <select className={INPUT} value={f.format} onChange={(e) => f.setFormat(e.target.value as LibraryFormat)} aria-label={t('documents.library.type', 'Document type')} data-testid="documents-format-filter">
                <option value="">{t('documents.library.type_all', 'All types')}</option>
                <option value="page">{t('documents.library.type_pages', 'Pages')}</option>
                <option value="designed">{t('documents.library.type_designed', 'Designed documents')}</option>
                <option value="presentation">{t('documents.library.type_presentations', 'Presentations')}</option>
            </select>
            <select className={INPUT} value={f.visibility} onChange={(e) => f.setVisibility(e.target.value)} aria-label={t('documents.library.visibility', 'Visibility')}>
                <option value="">{t('documents.library.visibility_all', 'Private and team')}</option>
                <option value="private">{t('documents.library.visibility_private', 'Private')}</option>
                <option value="team">{t('documents.library.team', 'Team')}</option>
            </select>
            <input className={INPUT} value={f.category} onChange={(e) => f.setCategory(e.target.value)} placeholder={t('documents.library.category_placeholder', 'Filter by category')} aria-label={t('documents.library.category', 'Category')} />
            <select className={INPUT} value={f.sort} onChange={(e) => f.setSort(e.target.value as 'updated' | 'name')} aria-label={t('documents.library.sort', 'Sort')}>
                <option value="updated">{t('documents.library.sort_updated', 'Recently updated')}</option>
                <option value="name">{t('documents.library.sort_name', 'Name')}</option>
            </select>
        </div>
    );
}

export function BulkBar({ count, folders, busy, onMove, onCategorise, onClear }: {
    count: number; folders: Folder[]; busy: boolean;
    onMove: (folderId: string | null) => void; onCategorise: (categories: string[]) => void; onClear: () => void;
}) {
    const { t } = useTranslation();
    const [categories, setCategories] = useState('');
    if (!count) return null;
    return (
        <div className="flex flex-wrap items-center gap-2 p-3 rounded-lg bg-[var(--bg-tertiary)]" data-testid="library-bulk">
            <span className="text-sm text-[var(--text-primary)]">{t('documents.library.selected', '{count} selected', { count })}</span>
            <select className={INPUT} value="" disabled={busy} aria-label={t('documents.library.move', 'Move to folder')} onChange={(e) => { if (e.target.value) onMove(e.target.value === 'root' ? null : e.target.value); }}>
                <option value="">{t('documents.library.move_to', 'Move to…')}</option>
                <option value="root">{t('documents.library.root', 'Not in a folder')}</option>
                {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
            </select>
            <input className={INPUT} value={categories} onChange={(e) => setCategories(e.target.value)} placeholder={t('documents.library.categories_placeholder', 'Categories, separated by commas')} aria-label={t('documents.library.categories', 'Categories')} />
            <button type="button" className={BUTTON} disabled={busy} onClick={() => onCategorise(categories.split(',').map((x) => x.trim()).filter(Boolean))}>{t('documents.library.set_categories', 'Set categories')}</button>
            <button type="button" className="text-sm underline ml-auto text-[var(--text-secondary)]" onClick={onClear}>{t('documents.library.clear_selection', 'Clear selection')}</button>
        </div>
    );
}
