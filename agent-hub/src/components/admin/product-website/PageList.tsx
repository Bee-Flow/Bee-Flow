import { useRef, useState } from 'react';
import type { RefObject } from 'react';
import {
    DndContext,
    closestCenter,
    PointerSensor,
    useSensor,
    useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import {
    SortableContext,
    verticalListSortingStrategy,
    arrayMove,
} from '@dnd-kit/sortable';
import { toast } from '../../shared/Toast';
import { BLOCK_DEFAULTS } from './editors';
import { useTranslation } from '../../../hooks/useTranslation';
import { AppIcon } from './fieldKit/jsDeps';
import PageRow from './pageList/PageRow';
import type { PageRowCallbacks } from './pageList/PageRow';
import { AddPageDialog, TemplatesManagerDialog } from './pageList/TemplateDialogs';
import type { NewPageInput, PageListPage, PageTemplate } from './pageList/pageListShared';

// The dialogs moved to ./pageList/TemplateDialogs; re-exported so the
// import path the panel uses stays stable.
export { SaveTemplateDialog, TemplatesManagerDialog } from './pageList/TemplateDialogs';
export type { PageListPage, PageTemplate, NewPageInput } from './pageList/pageListShared';

interface PageListProps extends Omit<PageRowCallbacks, 'onExport'> {
    pages: PageListPage[];
    activePageId?: string | null;
    onSelect: (id: string) => void;
    onAdd: (input: NewPageInput) => void;
    onReorder: (orderedIds: string[]) => void;
    // Templates plumbing — all optional so callers that haven't wired up
    // templates yet keep working with the old surface.
    templates?: PageTemplate[];
    onDeleteTemplate?: (id: string) => Promise<unknown> | unknown;
    // Per-page export / import. Both optional so a caller that hasn't
    // wired them up just renders without the affordance. The same hidden
    // input is shared by the header button and the per-row menu item
    // (both flows create a NEW page from the chosen file).
    onExportPage?: (id: string) => void;
    onImportPage?: (parsed: unknown) => void;
}

const ICON_BTN_CLS = 'w-6 h-6 flex items-center justify-center rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]';

/**
 * Downloads a known-good page file so users can see the exact shape import
 * expects (fields under `content`, one of the valid block types).
 */
async function downloadExamplePage() {
    const { exportPage } = await import('./pageIO');
    const defaults = BLOCK_DEFAULTS as Record<string, unknown>;
    const mk = (type: string) => ({
        id: `blk_${Math.random().toString(36).slice(2, 10)}`,
        type, enabled: true,
        content: JSON.parse(JSON.stringify(defaults[type] || {})),
        style: {},
    });
    exportPage({ title: 'Example page', slug: 'example', blocks: [mk('hero'), mk('features')] });
}

function PageListHeader({ templateCount, canImport, onOpenManager, onImportClick, onToggleAdd }: {
    templateCount: number;
    canImport: boolean;
    onOpenManager: () => void;
    onImportClick: () => void;
    onToggleAdd: () => void;
}) {
    const { t } = useTranslation();
    return (
        <div className="px-4 py-2 flex items-center justify-between border-b border-[var(--border-subtle)] shrink-0">
            <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-semibold">
                {t('cms_site.site.pagelist.pages', 'Pages')}
            </span>
            <div className="flex items-center gap-1">
                {/* Templates manager — opens a modal listing every saved
                    template with a per-row delete. Always visible so users
                    can land on the empty state and discover the feature. */}
                <button
                    type="button"
                    onClick={onOpenManager}
                    className="text-[10px] uppercase tracking-wider px-1.5 py-1 rounded text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] font-semibold"
                    title={t('cms_site.site.pagelist.manage_templates', 'Manage templates')}
                >
                    {t('cms_site.site.pagelist.templates', 'Templates')}{templateCount > 0 ? ` (${templateCount})` : ''}
                </button>
                {canImport ? (
                    <>
                        <button
                            type="button"
                            onClick={onImportClick}
                            className={ICON_BTN_CLS}
                            title={t('cms_site.site.pagelist.import_title', 'Import page from JSON file')}
                        >
                            <AppIcon name="Upload" className="w-4 h-4" />
                        </button>
                        <button
                            type="button"
                            onClick={downloadExamplePage}
                            className={ICON_BTN_CLS}
                            title={t('cms_site.site.pagelist.example_title', 'Download an example page JSON (import template)')}
                        >
                            <AppIcon name="FileDown" className="w-4 h-4" />
                        </button>
                    </>
                ) : null}
                <button
                    type="button"
                    onClick={onToggleAdd}
                    className={ICON_BTN_CLS}
                    title={t('cms_site.site.pagelist.add_page', 'Add page')}
                >
                    <AppIcon name="Plus" className="w-4 h-4" />
                </button>
            </div>
        </div>
    );
}

/**
 * Shared hidden input — both the header Import button and the per-row
 * "Import page…" menu item click this. Resetting value on every change so
 * the same file can be re-picked.
 */
function ImportInput({ inputRef, onImportPage }: { inputRef: RefObject<HTMLInputElement | null>; onImportPage: (parsed: unknown) => void }) {
    return (
        <input
            ref={inputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                try {
                    // Lazy import so the helper module isn't a hard
                    // dependency of PageList — callers without
                    // onImportPage never load it.
                    const { importPage } = await import('./pageIO');
                    const parsed = await importPage(file);
                    onImportPage(parsed);
                } catch (err) {
                    toast.error((err as Error | null)?.message || String(err));
                }
            }}
        />
    );
}

export default function PageList({
    pages,
    activePageId,
    onSelect,
    onAdd,
    onDuplicate,
    onDelete,
    onSetHomepage,
    onRename,
    onEditSlug,
    onReorder,
    templates = [],
    onSaveAsTemplate,
    onDeleteTemplate,
    onExportPage,
    onImportPage,
}: PageListProps) {
    const { t } = useTranslation();
    const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
    const [adding, setAdding]             = useState(false);
    const [managerOpen, setManagerOpen]   = useState(false);
    const importInputRef                  = useRef<HTMLInputElement>(null);

    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;
        if (over && active.id !== over.id) {
            const oldIdx = pages.findIndex(p => p.id === active.id);
            const newIdx = pages.findIndex(p => p.id === over.id);
            onReorder(arrayMove(pages, oldIdx, newIdx).map(p => p.id));
        }
    };

    return (
        <div className="flex flex-col h-full">
            <PageListHeader
                templateCount={templates.length}
                canImport={!!onImportPage}
                onOpenManager={() => setManagerOpen(true)}
                onImportClick={() => importInputRef.current?.click()}
                onToggleAdd={() => setAdding(v => !v)}
            />

            {onImportPage ? <ImportInput inputRef={importInputRef} onImportPage={onImportPage} /> : null}

            {adding && (
                <AddPageDialog
                    templates={templates}
                    existingSlugs={pages.map(p => p.slug)}
                    onConfirm={(payload) => { onAdd(payload); setAdding(false); }}
                    onCancel={() => setAdding(false)}
                />
            )}

            <div className="flex-1 overflow-y-auto px-2 py-2">
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                    <SortableContext items={pages.map(p => p.id)} strategy={verticalListSortingStrategy}>
                        {pages.map(page => (
                            <PageRow
                                key={page.id}
                                page={page}
                                allSlugs={pages.map(p => p.slug)}
                                isActive={page.id === activePageId}
                                onClick={onSelect}
                                onSetHomepage={onSetHomepage}
                                onDuplicate={onDuplicate}
                                onRename={onRename}
                                onEditSlug={onEditSlug}
                                onDelete={onDelete}
                                onSaveAsTemplate={onSaveAsTemplate}
                                onExport={onExportPage}
                                onImport={onImportPage ? () => importInputRef.current?.click() : undefined}
                            />
                        ))}
                    </SortableContext>
                </DndContext>
                {pages.length === 0 && (
                    <p className="text-xs text-[var(--text-muted)] text-center py-6">
                        {t('cms_site.site.pagelist.empty', 'No pages yet. Add one above.')}
                    </p>
                )}
            </div>

            {managerOpen ? (
                <TemplatesManagerDialog
                    templates={templates}
                    onDelete={async (id) => { await onDeleteTemplate?.(id); }}
                    onClose={() => setManagerOpen(false)}
                />
            ) : null}
        </div>
    );
}
