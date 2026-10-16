import { useEffect, useState } from 'react';
import ReactDOM from 'react-dom';
import type { PageListPage } from './pageListShared';
import { useTranslation } from '../../../../hooks/useTranslation';
import { AppIcon } from '../fieldKit/jsDeps';

function MenuBtn({ icon, label, onClick, danger }: { icon: string; label: string; onClick?: () => void; danger?: boolean }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={`w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--bg-tertiary)] transition-colors
                ${danger ? 'text-red-400' : 'text-[var(--text-primary)]'}`}
        >
            <AppIcon name={icon} className="w-3.5 h-3.5 shrink-0" />
            {label}
        </button>
    );
}

export interface PageMenuActions {
    onSetHomepage: () => void;
    onDuplicate: () => void;
    onRename: () => void;
    onEditSlug: () => void;
    onDelete: () => void;
    onSaveAsTemplate: () => void;
    onExport?: () => void;
    onImport?: () => void;
}

interface PageMenuProps extends PageMenuActions {
    anchorEl: HTMLElement | null;
    page: PageListPage;
    onClose: () => void;
}

const MENU_W = 176;
const MENU_H_EST = 140;     // approximate, only used to decide flip

/**
 * Menu coordinates from the button's viewport rect. Anchored to the right
 * edge so the menu unfolds left/down; flips up when there isn't enough room
 * below, and is clamped to the viewport so it can't run off-screen.
 */
function menuCoords(anchorEl: HTMLElement) {
    const rect = anchorEl.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const flipUp = spaceBelow < MENU_H_EST + 8;
    const top = flipUp
        ? Math.max(8, rect.top - MENU_H_EST - 4)
        : rect.bottom + 4;
    const left = Math.min(
        Math.max(8, rect.right - MENU_W),
        window.innerWidth - MENU_W - 8,
    );
    return { top, left };
}

/**
 * Actions menu — rendered in a portal at fixed coords so it escapes the page
 * list's overflow-y:auto container and doesn't clip.
 */
export default function PageMenu({ anchorEl, page, onClose, onSetHomepage, onDuplicate, onRename, onEditSlug, onDelete, onSaveAsTemplate, onExport, onImport }: PageMenuProps) {
    const { t } = useTranslation();
    const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);

    useEffect(() => {
        if (!anchorEl) return;
        setCoords(menuCoords(anchorEl));
    }, [anchorEl]);

    // Close on outside click. Use mousedown so the click that opens a menu
    // on a different row doesn't immediately close it. Skip clicks inside
    // the menu itself (the menu stops propagation on mousedown).
    useEffect(() => {
        const handler = () => onClose();
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [onClose]);

    if (!coords) return null;

    return ReactDOM.createPortal(
        <div
            style={{
                position: 'fixed',
                top: coords.top,
                left: coords.left,
                width: MENU_W,
                zIndex: 1000,
            }}
            className="rounded-md shadow-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] py-1 text-sm"
            onMouseDown={e => e.stopPropagation()}
        >
            {!page.isHomepage && (
                <MenuBtn icon="Home" label={t('cms_site.site.pagelist.set_homepage', 'Set as homepage')} onClick={onSetHomepage} />
            )}
            <MenuBtn icon="Pencil"   label={t('cms_site.site.pagelist.rename_page', 'Rename page')} onClick={onRename} />
            <MenuBtn icon="Link"     label={t('cms_site.site.pagelist.edit_slug', 'Edit slug')} onClick={onEditSlug} />
            <MenuBtn icon="Copy"     label={t('cms_site.site.pagelist.duplicate_page', 'Duplicate page')} onClick={onDuplicate} />
            <MenuBtn icon="Bookmark" label={t('cms_site.site.pagelist.save_as_template_menu', 'Save as template…')} onClick={onSaveAsTemplate} />
            {onExport ? (
                <MenuBtn icon="Download" label={t('cms_site.site.pagelist.export_page', 'Export page')} onClick={onExport} />
            ) : null}
            {onImport ? (
                <MenuBtn icon="Upload"   label={t('cms_site.site.pagelist.import_page', 'Import page…')} onClick={onImport} />
            ) : null}
            <div className="my-1 border-t border-[var(--border-subtle)]" />
            <MenuBtn icon="Trash2"   label={t('cms_site.site.pagelist.delete_page', 'Delete page')} onClick={onDelete} danger />
        </div>,
        document.body,
    );
}
