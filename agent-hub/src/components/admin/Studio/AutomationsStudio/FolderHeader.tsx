import { ChevronDown, ChevronRight, FolderInput, FolderPlus, Pencil, Trash2 } from 'lucide-react';
import React from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import type { AutomationFolder } from '@/components/automation/useAutomationLibrary';

/** The hover buttons share one look. */
const ICON_BUTTON = 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 p-0.5 rounded text-[var(--text-tertiary)]';

function IconButton({ title, label, onClick, danger = false, children }: {
    title: string; label: string; onClick: () => void; danger?: boolean; children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            title={title}
            aria-label={label}
            onClick={onClick}
            className={`${ICON_BUTTON} ${danger ? 'hover:text-red-500' : 'hover:text-[var(--text-primary)]'}`}
        >
            {children}
        </button>
    );
}

/** The inline name field for a new folder or subfolder: Enter keeps it, Escape drops it, leaving the field keeps it. */
export function NewFolderInput({ value, label, onChange, onCommit, onCancel }: {
    value: string; label: string; onChange: (v: string) => void; onCommit: () => void; onCancel: () => void;
}) {
    return (
        <div className="flex items-center gap-1 px-1.5 py-1">
            <span aria-hidden="true">📁</span>
            <input
                autoFocus
                value={value}
                aria-label={label}
                placeholder={label}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') onCommit();
                    if (e.key === 'Escape') onCancel();
                }}
                onBlur={onCommit}
                className="flex-1 min-w-0 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded px-1 py-0.5 text-xs outline-none"
            />
        </div>
    );
}

interface FolderHeaderProps {
    folder: AutomationFolder;
    /** Automations in the folder and everything below it. */
    total: number;
    isOpen: boolean;
    isTarget: boolean;
    /** A search is on: no creating or renaming while it filters the list. */
    filtering: boolean;
    /** The folder can be dragged and moved (the move handler is wired). */
    canMove: boolean;
    renaming: boolean;
    draftName: string;
    dropProps: React.HTMLAttributes<HTMLDivElement>;
    onDragStart: (e: React.DragEvent) => void;
    onToggle: () => void;
    onDraftChange: (name: string) => void;
    onCommitRename: () => void;
    onCancelRename: () => void;
    onStartSub: () => void;
    onMove: () => void;
    onRename: () => void;
    onDelete: () => void;
}

/** One folder's row in the sidebar: open/close, the name (or its rename input), the count and the actions. */
export default function FolderHeader(p: FolderHeaderProps) {
    const { t } = useTranslation();
    const name = p.folder.name;
    return (
        <div
            {...p.dropProps}
            draggable={p.canMove && !p.renaming}
            onDragStart={p.onDragStart}
            className={`group flex items-center gap-1 px-1.5 py-1 rounded-md transition ${
                p.isTarget ? 'bg-[var(--accent)]/15 ring-1 ring-[var(--accent)]' : 'hover:bg-[var(--bg-secondary)]'
            }`}
        >
            <button
                type="button"
                onClick={p.onToggle}
                aria-expanded={p.isOpen}
                aria-label={p.isOpen
                    ? t('studio_misc.folders.collapse_named', 'Collapse {name}', { name })
                    : t('studio_misc.folders.expand_named', 'Expand {name}', { name })}
                className="flex items-center gap-1 flex-1 min-w-0 text-left text-[var(--text-secondary)]"
            >
                {p.isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span aria-hidden="true">{String(p.folder.icon || '📁')}</span>
                {p.renaming ? (
                    <input
                        autoFocus
                        value={p.draftName}
                        aria-label={t('studio_misc.folders.folder_name', 'Folder name')}
                        onChange={(e) => p.onDraftChange(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') p.onCommitRename();
                            if (e.key === 'Escape') p.onCancelRename();
                        }}
                        onBlur={p.onCommitRename}
                        className="flex-1 min-w-0 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded px-1 py-0.5 text-xs outline-none"
                    />
                ) : (
                    <span className="truncate text-xs font-medium" title={name}>{name}</span>
                )}
                <span className="text-[10px] text-[var(--text-tertiary)] shrink-0">{p.total}</span>
            </button>
            {!p.filtering && (
                <IconButton title={t('studio_misc.folders.new_subfolder_title', 'Make a folder inside this folder')} label={t('studio_misc.folders.new_subfolder_in', 'New subfolder in {name}', { name })} onClick={p.onStartSub}>
                    <FolderPlus size={11} />
                </IconButton>
            )}
            {p.canMove && (
                <IconButton title={t('studio_misc.folders.move_folder_title', 'Move this folder into another folder')} label={t('studio_misc.folders.move_folder_named', 'Move {name}', { name })} onClick={p.onMove}>
                    <FolderInput size={11} />
                </IconButton>
            )}
            <IconButton title={t('studio_misc.folders.rename_title', 'Rename this folder')} label={t('studio_misc.folders.rename_named', 'Rename {name}', { name })} onClick={p.onRename}>
                <Pencil size={11} />
            </IconButton>
            <IconButton title={t('studio_misc.folders.remove_title', 'Remove this folder — the automations in it stay')} label={t('studio_misc.folders.delete_named', 'Delete {name}', { name })} onClick={p.onDelete} danger>
                <Trash2 size={11} />
            </IconButton>
        </div>
    );
}
