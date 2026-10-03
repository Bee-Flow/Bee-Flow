// The library's controls, in Studio's overview language (the Agents and
// Automations overviews): a compact search box for the header, counted-style
// pills for the view and the type, small selects for the rest, and the bar
// that acts on the selected documents (move to a folder, categorise).

import { Archive, Search } from 'lucide-react';
import React, { useState, type ComponentType } from 'react';
import FilterPillsJs from '../../../components/shared/FilterPills';
import useTranslation from '../../../hooks/useTranslation';
import type { Folder } from '../documentQueries';
import { formatApplies, type LibraryFormat, type LibraryKind, type useLibraryFilters } from './useLibrary';

// The pills are plain JS (untyped props): typed here for what the library passes.
const FilterPills = FilterPillsJs as unknown as ComponentType<{
    value: string; onChange: (value: string) => void; options: Array<{ value: string; label: string }>; ariaLabel: string; testId?: string;
}>;

const CONTROL = 'h-8 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] px-2.5 text-xs min-w-0 text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent-primary)]';
const BUTTON = 'inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] border border-[var(--border-default)] text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)] disabled:opacity-50';

/** The header's search box (Agents overview SearchBox). */
export function LibrarySearch({ value, onChange }: { value: string; onChange: (value: string) => void }) {
    const { t } = useTranslation();
    return (
        <label className="relative block shrink-0 w-[200px]">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-[var(--text-tertiary)]" aria-hidden="true" />
            <input
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={t('documents.library.search_placeholder', 'Search documents…')}
                aria-label={t('documents.library.search', 'Search documents')}
                className={`${CONTROL} w-full pl-8 pr-2`}
            />
        </label>
    );
}

/** Documents, templates, reusable sections; the archive on the far side. */
export function LibraryViews({ kind, archived, onView }: { kind: LibraryKind; archived: boolean; onView: (kind: LibraryKind | null, archived: boolean) => void }) {
    const { t } = useTranslation();
    const views = [
        { value: 'document', label: t('documents.library.documents', 'Documents') },
        { value: 'template', label: t('documents.library.templates', 'Templates') },
        { value: 'section', label: t('documents.library.sections', 'Reusable sections') },
    ];
    return (
        <nav className="flex flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] pb-3" aria-label={t('documents.library.views', 'Library views')}>
            <FilterPills value={archived ? '' : kind} onChange={(value) => onView(value as LibraryKind, false)} options={views} ariaLabel={t('documents.library.views', 'Library views')} testId="documents-view" />
            <button type="button" aria-pressed={archived} onClick={() => onView(null, !archived)} data-testid="documents-archived-view"
                className={`ml-auto inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium border transition-colors ${archived
                    ? 'border-[var(--accent-primary)] text-[var(--accent-primary)] bg-[color-mix(in_srgb,var(--accent-primary)_14%,transparent)]'
                    : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--item-hover-bg)]'}`}>
                <Archive size={12} aria-hidden="true" />{t('documents.library.archived', 'Archived')}
            </button>
        </nav>
    );
}

/**
 * The type pills and the remaining filters. Notebooks are a type only for a
 * reader the server lists them for (`notebooks`).
 */
export function LibraryFilterBar({ f, notebooks }: { f: ReturnType<typeof useLibraryFilters>; notebooks: boolean }) {
    const { t } = useTranslation();
    const types: Array<{ value: LibraryFormat; label: string }> = [
        { value: '', label: t('documents.library.type_all', 'All types') },
        { value: 'page', label: t('documents.library.type_pages', 'Pages') },
        ...(notebooks ? [{ value: 'notebook' as const, label: t('documents.notebook.type_filter', 'Notebooks') }] : []),
        { value: 'designed', label: t('documents.library.type_designed', 'Designed documents') },
        { value: 'presentation', label: t('documents.library.type_presentations', 'Presentations') },
    ];
    const shown = types.filter((x) => formatApplies(x.value, f.kind, f.archived));
    return (
        <div className="flex flex-wrap items-center gap-2">
            <FilterPills value={formatApplies(f.format, f.kind, f.archived) ? f.format : ''} onChange={(value) => f.setFormat(value as LibraryFormat)} options={shown} ariaLabel={t('documents.library.type', 'Document type')} testId="documents-format-filter" />
            <div className="ml-auto flex flex-wrap items-center gap-2">
                <select className={CONTROL} value={f.visibility} onChange={(e) => f.setVisibility(e.target.value)} aria-label={t('documents.library.visibility', 'Visibility')}>
                    <option value="">{t('documents.library.visibility_all', 'Private and team')}</option>
                    <option value="private">{t('documents.library.visibility_private', 'Private')}</option>
                    <option value="team">{t('documents.library.team', 'Team')}</option>
                </select>
                <input className={`${CONTROL} w-40`} value={f.category} onChange={(e) => f.setCategory(e.target.value)} placeholder={t('documents.library.category_placeholder', 'Filter by category')} aria-label={t('documents.library.category', 'Category')} />
                <select className={CONTROL} value={f.sort} onChange={(e) => f.setSort(e.target.value as 'updated' | 'name')} aria-label={t('documents.library.sort', 'Sort')}>
                    <option value="updated">{t('documents.library.sort_updated', 'Recently updated')}</option>
                    <option value="name">{t('documents.library.sort_name', 'Name')}</option>
                </select>
            </div>
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
        <div className="flex flex-wrap items-center gap-2 p-2.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]" data-testid="library-bulk">
            <span className="text-xs font-medium text-[var(--text-primary)]">{t('documents.library.selected', '{count} selected', { count })}</span>
            <select className={CONTROL} value="" disabled={busy} aria-label={t('documents.library.move', 'Move to folder')} onChange={(e) => { if (e.target.value) onMove(e.target.value === 'root' ? null : e.target.value); }}>
                <option value="">{t('documents.library.move_to', 'Move to…')}</option>
                <option value="root">{t('documents.library.root', 'Not in a folder')}</option>
                {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
            </select>
            <input className={`${CONTROL} w-56`} value={categories} onChange={(e) => setCategories(e.target.value)} placeholder={t('documents.library.categories_placeholder', 'Categories, separated by commas')} aria-label={t('documents.library.categories', 'Categories')} />
            <button type="button" className={BUTTON} disabled={busy} onClick={() => onCategorise(categories.split(',').map((x) => x.trim()).filter(Boolean))}>{t('documents.library.set_categories', 'Set categories')}</button>
            <button type="button" className="text-xs underline ml-auto text-[var(--text-secondary)]" onClick={onClear}>{t('documents.library.clear_selection', 'Clear selection')}</button>
        </div>
    );
}
