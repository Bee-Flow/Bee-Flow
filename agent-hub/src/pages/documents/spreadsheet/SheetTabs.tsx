// Tab bar for a multi-sheet spreadsheet. Kept minimal: click to switch,
// double-click to rename, a small × on hover to delete, and a + to add.

import { Plus, X } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import useTranslation from '../../../hooks/useTranslation';
import type { SheetTab } from './sheetApi';

interface SheetTabsProps {
    tabs?: SheetTab[];
    activeTab?: string;
    readOnly?: boolean;
    onChange: (tabId: string) => void;
    onAdd: () => void;
    onRename: (tabId: string, name: string) => void;
    onDelete: (tabId: string) => void;
}

export default function SheetTabs({
    tabs = [], activeTab, readOnly, onChange, onAdd, onRename, onDelete,
}: SheetTabsProps) {
    const { t } = useTranslation();
    const [renaming, setRenaming] = useState<string | null>(null);
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

    if (tabs.length <= 1 && readOnly) return null;

    return (
        <div className="flex items-center gap-1 px-2 border-t border-[var(--border-default)] bg-[var(--bg-secondary)] overflow-x-auto">
            {tabs.map((tab) => {
                const active = tab.id === activeTab;
                return (
                    <div
                        key={tab.id}
                        role="tab"
                        aria-selected={active}
                        className={[
                            'group flex items-center gap-1.5 px-3 py-1.5 text-[13px] select-none cursor-pointer border-b-2 transition',
                            active
                                ? 'bg-[var(--bg-primary)] text-[var(--text-primary)] border-[var(--accent)]'
                                : 'text-[var(--text-secondary)] border-transparent hover:bg-[var(--bg-tertiary)]',
                        ].join(' ')}
                        onClick={() => onChange(tab.id)}
                        onDoubleClick={() => startRename(tab.id)}
                    >
                        {renaming === tab.id ? (
                            <input
                                ref={inputRef}
                                type="text"
                                defaultValue={tab.name}
                                className="w-24 px-1 py-0.5 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded text-[13px]"
                                onBlur={(e) => commitRename(tab.id, e.currentTarget.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') commitRename(tab.id, e.currentTarget.value);
                                    if (e.key === 'Escape') setRenaming(null);
                                }}
                                onClick={(e) => e.stopPropagation()}
                            />
                        ) : (
                            <>
                                <span className="truncate max-w-[8rem]">{tab.name}</span>
                                {!readOnly && tabs.length > 1 && (
                                    <button
                                        type="button"
                                        className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-tertiary)]"
                                        title={t('spreadsheet.tab.delete', 'Delete tab')}
                                        onClick={(e) => { e.stopPropagation(); onDelete(tab.id); }}
                                    >
                                        <X size={12} aria-hidden="true" />
                                    </button>
                                )}
                            </>
                        )}
                    </div>
                );
            })}
            {!readOnly && (
                <button
                    type="button"
                    className="flex items-center gap-1 px-2 py-1.5 text-[13px] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] rounded"
                    title={t('spreadsheet.tab.add', 'Add tab')}
                    onClick={onAdd}
                >
                    <Plus size={14} aria-hidden="true" />
                </button>
            )}
        </div>
    );
}
