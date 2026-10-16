import { X, Search, Upload } from 'lucide-react';
import React, { useRef } from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import CreateMenuButton from '../admin/Studio/AutomationsStudio/CreateMenuButton';
import Modal from '../shared/Modal';
import type { ReactNode, RefObject } from 'react';
import type { AutomationLibrary } from './useAutomationLibrary';

interface SidebarProps {
    importAutomationFile: AutomationLibrary['importAutomationFile'];
    searchQuery: string;
    setSearchQuery: (query: string) => void;
    onOpenQuickSwitcher: () => void;
    onPlus: () => void;
    onNewBlock: (() => void) | null;
    /** The list itself (automations, folders, building blocks), drawn by the host. */
    children: ReactNode;
}

/** The persistent left column: title, import, the split +, the filter and the list. */
export function AutomationSidebar({
    importAutomationFile, searchQuery, setSearchQuery, onOpenQuickSwitcher, onPlus, onNewBlock, children,
}: SidebarProps) {
    const { t } = useTranslation();
    const importInputRef = useRef<HTMLInputElement | null>(null);
    return (
        <aside className="w-[264px] flex-shrink-0 border-r border-[var(--border-default)] flex flex-col bg-[var(--bg-primary)]">
            {/* Sidebar header — title + plus, mirrors SkillsStudio */}
            <div className="px-4 py-3 border-b border-[var(--border-default)] flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-[var(--text-primary)]">
                        {t('automations.library.automations', 'Automations')}
                    </span>
                </div>
                <div className="flex items-center gap-0.5">
                    {/* One hidden input shared by this button and the row
                        menu. Resetting value on every change is what lets
                        the same file be picked twice in a row. */}
                    <input
                        ref={importInputRef}
                        type="file"
                        accept="application/json,.json"
                        className="hidden"
                        onChange={(e) => {
                            const file = e.target.files?.[0];
                            e.target.value = '';
                            importAutomationFile(file ?? null);
                        }}
                    />
                    <button
                        onClick={() => importInputRef.current?.click()}
                        title={t('automations.automation_page.import_an_automation_from_a_json', 'Import an automation from a JSON export')}
                        aria-label={t('automations.automation_page.import_an_automation', 'Import an automation')}
                        className="p-1 rounded-lg hover:bg-[var(--bg-secondary)] text-[var(--text-tertiary)]"
                    >
                        <Upload size={15} />
                    </button>
                    {/* A split +: the main part makes an automation (the
                        default, and the Learning Center's anchor), the
                        chevron beside it also offers a building block. */}
                    <CreateMenuButton
                        onCreateAutomation={onPlus}
                        onCreateBlock={onNewBlock}
                        tourAnchor="automation-create"
                        testId="sidebar-create"
                    />
                </div>
            </div>

            {/* Search — debounced filter on the visible list. */}
            <div className="px-2 pt-2">
                <div className="relative">
                    <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] pointer-events-none" />
                    <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder={t('automations.automation_page.filter', 'Filter…')}
                        className="w-full bg-[var(--bg-secondary)] border border-transparent focus:border-[var(--border-default)] rounded-md pl-7 pr-10 py-1 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none transition"
                    />
                    {/* The quick switcher's chord, inside the field instead
                        of a tip line under it: one row less above the list,
                        and a click opens the switcher too. */}
                    <button
                        type="button"
                        onClick={onOpenQuickSwitcher}
                        title={t('automations.library.quickSwitch', 'Quick switch')}
                        aria-label={t('automations.library.quickSwitch', 'Quick switch')}
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition"
                    >
                        <kbd className="block px-1 rounded border border-[var(--border-default)] font-sans text-[10px] leading-4">{'⌘K'}</kbd>
                    </button>
                </div>
            </div>

            {/* List body */}
            <div className="flex-1 overflow-y-auto p-1.5 mt-1">
                {children}
            </div>
        </aside>
    );
}

interface FlyoutProps {
    open: boolean;
    onClose: () => void;
    filterRef: RefObject<HTMLInputElement | null>;
    searchQuery: string;
    setSearchQuery: (query: string) => void;
    onPlus: () => void;
    onNewBlock: (() => void) | null;
    /** The list itself, drawn by the host. */
    children: ReactNode;
}

/**
 * The in-editor way back to the list (BFSF-404): a left slide-over that sits
 * ABOVE the fullscreen canvas and any open NDV (z-[1000]) / mapping-picker
 * (z-[1200]) panel, and below QuickSwitcher's z-[2000]. A left-placement Modal:
 * Escape and the scrim close it, Tab stays in it. The surface is an inner div,
 * so its corners stay square.
 */
export function AutomationFlyout({
    open, onClose, filterRef, searchQuery, setSearchQuery, onPlus, onNewBlock, children,
}: FlyoutProps) {
    const { t } = useTranslation();
    return (
        <Modal
            open={open}
            onClose={onClose}
            placement="left"
            variant="bare"
            size="auto"
            zIndex={1500}
            initialFocus={filterRef}
            label={t('automations.library.automations', 'Automations')}
            className="max-w-[300px]"
        >
            <div className="flex-1 min-h-0 flex flex-col border-r border-[var(--border-default)] bg-[var(--bg-primary)] shadow-2xl">
                <div className="px-4 py-3 border-b border-[var(--border-default)] flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-[var(--text-primary)]">
                            {t('automations.library.automations', 'Automations')}
                        </span>
                    </div>
                    <div className="flex items-center gap-0.5">
                        {/* The sidebar's split +, also while a building
                            block is open: automations stay the default. */}
                        <CreateMenuButton
                            onCreateAutomation={() => { onClose(); onPlus(); }}
                            onCreateBlock={onNewBlock}
                            testId="flyout-create"
                        />
                        <button
                            onClick={onClose}
                            title={t('automations.automation_page.close', 'Close')}
                            aria-label={t('automations.automation_page.close', 'Close')}
                            className="p-1 rounded-lg hover:bg-[var(--bg-secondary)] text-[var(--text-tertiary)]"
                        >
                            <X size={16} />
                        </button>
                    </div>
                </div>

                <div className="px-2 pt-2">
                    <div className="relative">
                        <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] pointer-events-none" />
                        <input
                            ref={filterRef}
                            type="text"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            placeholder={t('automations.automation_page.filter', 'Filter…')}
                            className="w-full bg-[var(--bg-secondary)] border border-transparent focus:border-[var(--border-default)] rounded-md pl-7 pr-2 py-1 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none transition"
                        />
                    </div>
                </div>

                {/* The same list as the sidebar: automations, folders,
                    then the building blocks. */}
                <div className="flex-1 overflow-y-auto p-1.5 mt-1">
                    {children}
                </div>
            </div>
        </Modal>
    );
}
