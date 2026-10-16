import type { CmsActivePage } from './cmsPanelTypes';
import { NavigatorPanel } from './panelJsComponents';
import { BlogNavigatorList } from './PanelSlots';
import type useCmsBlockEditing from './useCmsBlockEditing';
import type useCmsPageMeta from './useCmsPageMeta';
import type useCmsPagesTemplates from './useCmsPagesTemplates';
import type useCmsPanelState from './useCmsPanelState';
import type { BlogEditor } from '../blog/useBlogEditor';

interface PanelNavigatorProps {
    ps: ReturnType<typeof useCmsPanelState>;
    entryId: string | null;
    activePage: CmsActivePage | null;
    translationMode: boolean;
    pagesOps: ReturnType<typeof useCmsPagesTemplates>;
    blockOps: ReturnType<typeof useCmsBlockEditing>;
    savePageMeta: ReturnType<typeof useCmsPageMeta>['savePageMeta'];
    isBlogView: boolean;
    blog: BlogEditor;
}

/** The left pane: the entry list, the page list and (on a page in the default locale) its blocks. */
export default function PanelNavigator({ ps, entryId, activePage, translationMode, pagesOps, blockOps, savePageMeta, isBlogView, blog }: PanelNavigatorProps) {
    return (
        <NavigatorPanel
            activeEntryId={entryId}
            onSelectEntry={ps.setActivePageId}
            blogSlot={isBlogView ? (
                <BlogNavigatorList blog={blog} locale={ps.activeLocale} confirm={ps.confirm} />
            ) : null}
            pageListProps={{
                pages: ps.site?.pages || [],
                activePageId: ps.activePageId,
                onSelect: ps.setActivePageId,
                onAdd: pagesOps.handleAddPage,
                onDuplicate: pagesOps.handleDuplicatePage,
                onDelete: pagesOps.handleDeletePage,
                onSetHomepage: pagesOps.handleSetHomepage,
                onRename: (pageId: string, title: string) => savePageMeta(pageId, { title }),
                onEditSlug: (pageId: string, slug: string) => savePageMeta(pageId, { slug }),
                onReorder: pagesOps.handleReorderPages,
                templates: ps.templates,
                onSaveAsTemplate: pagesOps.handleSaveAsTemplate,
                onDeleteTemplate: pagesOps.handleDeleteTemplate,
                onExportPage: pagesOps.handleExportPage,
                onImportPage: pagesOps.handleImportPage,
            }}
            blockListProps={(activePage && !translationMode) ? {
                blocks: activePage.blocks || [],
                activeBlockId: ps.activeBlockId,
                onSelect: ps.setActiveBlockId,
                // index:null = default insert-after-active behaviour
                // (the canvas "+" zones request an explicit index).
                onRequestAdd: () => ps.setAddBlockRequest({ index: null }),
                onToggle: blockOps.toggleBlock,
                onDuplicate: blockOps.duplicateBlock,
                onDelete: blockOps.deleteBlock,
                onReorder: blockOps.reorderBlocks,
            } : null}
        />
    );
}
