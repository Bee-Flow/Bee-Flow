// Tab bar for a multi-sheet spreadsheet, a tablist: click (or the arrow keys)
// to switch, double-click or F2 to rename, a small × (on the open tab, and on
// hover or focus) to delete after a confirmation, and a + to add.

import { Plus, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import useTranslation from '@/hooks/useTranslation';
import type { SheetTab } from '@/api/sheetApi';

interface SheetTabsProps {
    tabs?: SheetTab[];
    activeTab?: string;
    readOnly?: boolean;
    onChange: (tabId: string) => unknown;
    onAdd: () => unknown;
    onRename: (tabId: string, name: string) => unknown;
    /** Called once the person confirmed; may resolve once the tab is gone. */
    onDelete: (tabId: string) => unknown;
}

export default function SheetTabs({
    tabs = [], activeTab, readOnly, onChange, onAdd, onRename, onDelete,
}: SheetTabsProps) {
    const { t } = useTranslation();
    const [renaming, setRenaming] = useState<string | null>(null);
    const [confirming, setConfirming] = useState<SheetTab | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (renaming) inputRef.current?.focus();
    }, [renaming]);

    const startRename = useCallback((tabId: string) => {
        if (readOnly) return;
        setRenaming(tabId);
    }, [readOnly]);

    const commitRename = useCallback((tabId: string, next: string) => {
        const name = next.trim();
        setRenaming(null);
        if (!name) return;
        const current = tabs.find((t) => t.id === tabId)?.name;
        if (name !== current) onRename(tabId, name);
    }, [tabs, onRename]);

    const tabRefs = useRef(new Map<string, HTMLButtonElement>());
    const focusTab = (index: number) => {
        const tab = tabs[(index + tabs.length) % tabs.length];
        if (!tab) return;
        onChange(tab.id);
        tabRefs.current.get(tab.id)?.focus();
    };
    // Arrows / Home / End move between the tabs (and open them), F2 or Enter on the open tab renames it.
    const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, index: number, tab: SheetTab, active: boolean) => {
        const { key } = e;
        if (key === 'ArrowRight' || key === 'ArrowLeft') { e.preventDefault(); focusTab(index + (key === 'ArrowRight' ? 1 : -1)); }
        else if (key === 'Home' || key === 'End') { e.preventDefault(); focusTab(key === 'Home' ? 0 : tabs.length - 1); }
        else if (!readOnly && (key === 'F2' || (key === 'Enter' && active))) { e.preventDefault(); startRename(tab.id); }
    };

    if (tabs.length <= 1 && readOnly) return null;

    return (
        <div className="flex items-center gap-1 px-2 border-t border-[var(--border-default)] bg-[var(--bg-secondary)] overflow-x-auto">
            <div role="tablist" aria-label={t('doc_sheet.tab.list', 'Sheet tabs')} className="flex items-center gap-1 min-w-0">
                {tabs.map((tab, index) => {
                    const active = tab.id === activeTab;
                    return (
                        <div
                            key={tab.id}
                            className={[
                                'group flex items-center gap-1.5 px-3 py-1.5 text-[13px] select-none border-b-2 transition',
                                active
                                    ? 'bg-[var(--bg-primary)] text-[var(--text-primary)] border-[var(--accent)]'
                                    : 'text-[var(--text-secondary)] border-transparent hover:bg-[var(--bg-tertiary)]',
                            ].join(' ')}
                        >
                            {renaming === tab.id ? (
                                <input
                                    ref={inputRef}
                                    type="text"
                                    defaultValue={tab.name}
                                    aria-label={t('doc_sheet.tab.name_label', 'Tab name')}
                                    className="w-24 px-1 py-0.5 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-[13px] text-[var(--text-primary)]"
                                    onBlur={(e) => commitRename(tab.id, e.currentTarget.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') commitRename(tab.id, e.currentTarget.value);
                                        if (e.key === 'Escape') setRenaming(null);
                                    }}
                                />
                            ) : (
                                <>
                                    <button
                                        type="button"
                                        role="tab"
                                        aria-selected={active}
                                        tabIndex={active ? 0 : -1}
                                        ref={(el) => { if (el) tabRefs.current.set(tab.id, el); else tabRefs.current.delete(tab.id); }}
                                        className="truncate max-w-[8rem] cursor-pointer rounded outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
                                        onClick={() => onChange(tab.id)}
                                        onDoubleClick={() => startRename(tab.id)}
                                        onKeyDown={(e) => onTabKey(e, index, tab, active)}
                                    >
                                        {tab.name}
                                    </button>
                                    {!readOnly && tabs.length > 1 && (
                                        <button
                                            type="button"
                                            className={`${active ? 'opacity-100' : 'opacity-0'} group-hover:opacity-100 focus-visible:opacity-100 p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-tertiary)]`}
                                            title={t('spreadsheet.tab.delete', 'Delete tab')}
                                            aria-label={t('spreadsheet.tab.delete', 'Delete tab')}
                                            onClick={() => setConfirming(tab)}
                                        >
                                            <X size={12} aria-hidden="true" />
                                        </button>
                                    )}
                                </>
                            )}
                        </div>
                    );
                })}
            </div>
            {!readOnly && (
                <button
                    type="button"
                    className="flex items-center gap-1 px-2 py-1.5 text-[13px] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] rounded"
                    title={t('spreadsheet.tab.add', 'Add tab')}
                    aria-label={t('spreadsheet.tab.add', 'Add tab')}
                    onClick={onAdd}
                >
                    <Plus size={14} aria-hidden="true" />
                </button>
            )}
            <ConfirmDialog
                open={confirming !== null}
                title={t('doc_sheet.tab.delete_title', 'Delete this tab?')}
                description={t('doc_sheet.tab.delete_body', 'The tab "{name}" and everything on it, its charts included, are deleted. This cannot be undone.', { name: confirming?.name ?? '' })}
                confirmLabel={t('doc_sheet.tab.delete_confirm', 'Delete tab')}
                cancelLabel={t('common.cancel', 'Cancel')}
                destructive
                onConfirm={async () => { const tab = confirming; setConfirming(null); if (tab) await onDelete(tab.id); }}
                onCancel={() => setConfirming(null)}
            />
        </div>
    );
}
