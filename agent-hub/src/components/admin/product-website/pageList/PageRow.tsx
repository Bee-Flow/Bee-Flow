import { useEffect, useRef, useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useTranslation } from '@/hooks/useTranslation';
import { AppIcon } from '../fieldKit/jsDeps';
import PageMenu from './PageMenu';
import { normalizeSlugForInput, slugIssues } from './pageListShared';
import type { PageListPage } from './pageListShared';

/** The per-page callbacks PageList hands to every row. */
export interface PageRowCallbacks {
    onSetHomepage: (id: string) => void;
    onDuplicate: (id: string) => void;
    onRename: (id: string, title: string) => void;
    onEditSlug?: (id: string, slug: string) => void;
    onDelete: (id: string) => void;
    onSaveAsTemplate?: (page: PageListPage) => void;
    onExport?: (id: string) => void;
}

interface PageRowProps extends PageRowCallbacks {
    page: PageListPage;
    allSlugs: Array<string | undefined>;
    isActive: boolean;
    onClick: (id: string) => void;
    onImport?: () => void;
}

// ── Inline rename input (Enter to save, Escape to cancel) ─────────────

function RenameInput({ initial, onConfirm, onCancel }: { initial: string; onConfirm: (value: string) => void; onCancel: () => void }) {
    const [value, setValue] = useState(initial);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);

    return (
        <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={e => setValue(e.target.value)}
            onClick={e => e.stopPropagation()}
            onMouseDown={e => e.stopPropagation()}
            onBlur={() => onConfirm(value)}
            onKeyDown={(e) => {
                if (e.key === 'Enter')  { e.preventDefault(); onConfirm(value); }
                if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
            }}
            className="flex-1 min-w-0 px-1.5 py-0.5 rounded text-sm border bg-[var(--bg-primary)] border-[var(--accent-primary)] text-[var(--text-primary)] focus:outline-none"
        />
    );
}

// ── Inline slug input ─────────────────────────────────────────────────
//
// Mirrors RenameInput but with slug-shaped sanitisation (see
// normalizeSlugForInput). Same Enter / Esc / blur-to-confirm pattern.

interface SlugInputProps {
    initial: string;
    isHomepage: boolean;
    allSlugs?: Array<string | undefined> | null;
    onConfirm: (value: string) => void;
    onCancel: () => void;
}

function SlugInput({ initial, isHomepage, allSlugs = null, onConfirm, onCancel }: SlugInputProps) {
    const { t } = useTranslation();
    const [value, setValue] = useState(initial);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);

    // Routing lint while typing. Reserved slugs and duplicates BLOCK the
    // commit (the server rejects reserved and would silently -2-suffix a
    // duplicate); `_` slugs warn but stay allowed (legacy data).
    const issue = slugIssues(value, { existingSlugs: allSlugs, currentSlug: initial });
    const commit = () => {
        if (issue?.blocking) { onCancel(); return; }
        onConfirm(value);
    };

    return (
        <span className="flex flex-col w-full gap-0.5">
            <span className="flex items-center gap-1 text-[10px] text-[var(--text-muted)]">
                <span className="font-mono">/</span>
                <input
                    ref={inputRef}
                    type="text"
                    value={value}
                    onChange={e => setValue(normalizeSlugForInput(e.target.value))}
                    onClick={e => e.stopPropagation()}
                    onMouseDown={e => e.stopPropagation()}
                    onBlur={commit}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter')  { e.preventDefault(); commit(); }
                        if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
                    }}
                    placeholder={t('cms_site.site.pagelist.slug_placeholder', 'page-slug')}
                    spellCheck={false}
                    className={`flex-1 min-w-0 px-1.5 py-0.5 rounded text-[10px] font-mono border bg-[var(--bg-primary)] text-[var(--text-primary)] focus:outline-none ${issue?.blocking ? 'border-red-400' : 'border-[var(--accent-primary)]'}`}
                />
            </span>
            {isHomepage ? (
                // Spec: "still allow slug editing but warn the user".
                // Inline warning keeps the affordance one-step (no
                // modal); the user can still cancel via Escape.
                <span className="text-[10px] leading-tight text-amber-500/90">
                    {t('cms_site.site.pagelist.homepage_slug_warning', '⚠ Homepage slug. Changing it may break external links.')}
                </span>
            ) : null}
            {issue ? (
                <span className={`text-[10px] leading-tight ${issue.blocking ? 'text-red-400' : 'text-amber-500/90'}`}>
                    ⚠ {issue.message}{issue.blocking ? ' (press Esc to keep the old slug)' : ''}
                </span>
            ) : null}
        </span>
    );
}

/** Title + slug of a row, or the inline rename / slug input while one is open. */
function RowLabel({ page, allSlugs, renaming, editingSlug, onRenameSubmit, onSlugSubmit, onCancelRename, onCancelSlug }: {
    page: PageListPage;
    allSlugs: Array<string | undefined>;
    renaming: boolean;
    editingSlug: boolean;
    onRenameSubmit: (value: string) => void;
    onSlugSubmit: (value: string) => void;
    onCancelRename: () => void;
    onCancelSlug: () => void;
}) {
    if (renaming) {
        return <RenameInput initial={page.title || ''} onConfirm={onRenameSubmit} onCancel={onCancelRename} />;
    }
    if (editingSlug) {
        // Keep the title visible above the slug input so the user has
        // context for which page they're editing.
        return (
            <span className="flex flex-col min-w-0 w-full">
                <span className="text-sm truncate leading-tight">{page.title || '(untitled)'}</span>
                <SlugInput
                    initial={page.slug || ''}
                    isHomepage={!!page.isHomepage}
                    allSlugs={allSlugs}
                    onConfirm={onSlugSubmit}
                    onCancel={onCancelSlug}
                />
            </span>
        );
    }
    return (
        <span className="flex flex-col min-w-0">
            <span className="text-sm truncate leading-tight" title={page.title || '(untitled)'}>
                {page.title || '(untitled)'}
            </span>
            <span className="text-[10px] text-[var(--text-muted)] truncate leading-tight" title={`/${page.slug}`}>
                /{page.slug}
            </span>
        </span>
    );
}

// ── Single draggable page row ────────────────────────────────────────

export default function PageRow({ page, allSlugs, isActive, onClick, onSetHomepage, onDuplicate, onRename, onEditSlug, onDelete, onSaveAsTemplate, onExport, onImport }: PageRowProps) {
    const { t } = useTranslation();
    const {
        attributes, listeners, setNodeRef, transform, transition, isDragging,
    } = useSortable({ id: page.id });

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
    };

    const [menuOpen, setMenuOpen]       = useState(false);
    const [renaming, setRenaming]       = useState(false);
    const [editingSlug, setEditingSlug] = useState(false);
    // The menu anchors to the button: kept in state (a callback ref) so render never reads a ref.
    const [menuBtn, setMenuBtn] = useState<HTMLButtonElement | null>(null);

    // Row is in some inline-edit mode whenever either field is open.
    // While editing we suppress the row's click-to-select and hide the
    // actions button so it can't be triggered mid-edit.
    const isEditing = renaming || editingSlug;

    const handleRenameSubmit = (nextTitle: string) => {
        const trimmed = nextTitle.trim();
        if (trimmed && trimmed !== page.title) {
            onRename(page.id, trimmed);
        }
        setRenaming(false);
    };

    const handleSlugSubmit = (nextSlug: string) => {
        const cleaned = (nextSlug || '').trim();
        // Empty slug is invalid — cancel rather than wipe.
        if (!cleaned) { setEditingSlug(false); return; }
        if (cleaned === page.slug) { setEditingSlug(false); return; }
        if (typeof onEditSlug === 'function') onEditSlug(page.id, cleaned);
        setEditingSlug(false);
    };

    return (
        <div
            ref={setNodeRef}
            style={style}
            className={`group flex items-center gap-1 px-2 py-1 rounded-md select-none
                ${isEditing ? '' : 'cursor-pointer'}
                ${isActive
                    ? 'bg-[var(--accent-primary)]/10 text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
                }`}
            onClick={() => { if (!isEditing) onClick(page.id); }}
        >
            {/* drag handle */}
            <span
                {...attributes}
                {...listeners}
                className="text-[var(--text-muted)] cursor-grab active:cursor-grabbing p-0.5 shrink-0"
                onClick={e => e.stopPropagation()}
                title={t('cms_site.site.pagelist.drag_to_reorder', 'Drag to reorder')}
            >
                <AppIcon name="GripVertical" className="w-3.5 h-3.5" />
            </span>

            {/* page icon + info (or inline rename / slug input) */}
            <span className="flex items-center gap-1.5 flex-1 min-w-0">
                {page.isHomepage
                    ? <AppIcon name="Home" className="w-3.5 h-3.5 shrink-0 text-[var(--accent-primary)]" />
                    : <AppIcon name="FileText" className="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" />
                }
                <RowLabel
                    page={page}
                    allSlugs={allSlugs}
                    renaming={renaming}
                    editingSlug={editingSlug}
                    onRenameSubmit={handleRenameSubmit}
                    onSlugSubmit={handleSlugSubmit}
                    onCancelRename={() => setRenaming(false)}
                    onCancelSlug={() => setEditingSlug(false)}
                />
            </span>

            {/* actions menu */}
            {!isEditing && (
                <div className="relative shrink-0" onClick={e => e.stopPropagation()}>
                    <button
                        ref={setMenuBtn}
                        type="button"
                        className={`w-6 h-6 flex items-center justify-center rounded hover:bg-[var(--bg-tertiary)]
                            text-[var(--text-muted)] hover:text-[var(--text-secondary)]
                            ${menuOpen ? 'opacity-100' : 'opacity-40 group-hover:opacity-100'}`}
                        onClick={() => setMenuOpen(v => !v)}
                        title={t('cms_site.site.pagelist.page_actions', 'Page actions')}
                    >
                        <AppIcon name="MoreVertical" className="w-3.5 h-3.5" />
                    </button>
                    {menuOpen && (
                        <PageMenu
                            anchorEl={menuBtn}
                            page={page}
                            onClose={() => setMenuOpen(false)}
                            onSetHomepage={()    => { onSetHomepage(page.id); setMenuOpen(false); }}
                            onDuplicate={()      => { onDuplicate(page.id);   setMenuOpen(false); }}
                            onRename={()         => { setMenuOpen(false); setRenaming(true); }}
                            onEditSlug={()       => { setMenuOpen(false); setEditingSlug(true); }}
                            onDelete={()         => { onDelete(page.id);      setMenuOpen(false); }}
                            onSaveAsTemplate={() => { onSaveAsTemplate?.(page); setMenuOpen(false); }}
                            onExport={onExport       ? () => { onExport(page.id); setMenuOpen(false); }   : undefined}
                            onImport={onImport       ? () => { setMenuOpen(false); onImport(); }          : undefined}
                        />
                    )}
                </div>
            )}
        </div>
    );
}
