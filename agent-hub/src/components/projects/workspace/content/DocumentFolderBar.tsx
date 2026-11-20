// The folders of a project's Documents tab, as a row of tabs above the table:
// "All documents", one per folder (with how many documents it holds), and for
// an editor "New folder", plus rename and delete on the open folder. The
// folders are the team's (api/queries/projectDocumentFolders.ts): everyone on
// the project sees the same ones. MoveToFolderButton moves one document.

import { Check, Folder, FolderInput, FolderPlus, Pencil, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import type { DocumentFolder } from '@/api/queries/projectDocumentFolders';
import useTranslation from '@/hooks/useTranslation';

const TAB = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)]';
const ICON_BUTTON = 'grid place-items-center w-7 h-7 rounded-lg text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)] disabled:opacity-50';
const INPUT = 'h-7 w-44 rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] px-2 text-xs text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]';

function NameInput({ initial, label, busy, onSave, onCancel }: {
    initial: string; label: string; busy: boolean; onSave: (name: string) => void; onCancel: () => void;
}) {
    const { t } = useTranslation();
    const [name, setName] = useState(initial);
    const input = useRef<HTMLInputElement>(null);
    // The field the person just asked for takes the typing.
    useEffect(() => { input.current?.focus(); }, []);
    const submit = (e: FormEvent) => {
        e.preventDefault();
        if (name.trim()) onSave(name.trim());
    };
    return (
        <form onSubmit={submit} className="inline-flex items-center gap-1">
            <input ref={input} aria-label={label} value={name} maxLength={120} onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }} className={INPUT} data-testid="document-folder-name" />
            <button type="submit" className={ICON_BUTTON} disabled={busy || !name.trim()} aria-label={t('doc_folders.folder_save', 'Save')}>
                <Check className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
            <button type="button" className={ICON_BUTTON} onClick={onCancel} aria-label={t('doc_folders.folder_cancel', 'Cancel')}>
                <X className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
        </form>
    );
}

export interface DocumentFolderBarProps {
    folders: DocumentFolder[];
    counts: Record<string, number>;
    total: number;
    current: string | null;
    onSelect: (folderId: string | null) => void;
    canEdit: boolean;
    busy: boolean;
    onCreate: (name: string) => void;
    onRename: (folderId: string, name: string) => void;
    onDelete: (folder: DocumentFolder) => void;
}

export default function DocumentFolderBar({ folders, counts, total, current, onSelect, canEdit, busy, onCreate, onRename, onDelete }: DocumentFolderBarProps) {
    const { t } = useTranslation();
    const [editing, setEditing] = useState<'new' | 'rename' | null>(null);
    const open = folders.find((f) => f.id === current) || null;
    if (folders.length === 0 && !canEdit) return null;
    const tab = (active: boolean) => `${TAB} ${active
        ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)]/10 text-[var(--text-primary)]'
        : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--item-hover-bg)]'}`;
    return (
        <nav aria-label={t('doc_folders.folders_label', 'Folders')} className="flex flex-wrap items-center gap-1.5" data-testid="document-folder-bar">
            <button type="button" className={tab(current === null)} aria-pressed={current === null} onClick={() => onSelect(null)}>
                {t('doc_folders.folders_all', 'All documents')}
                <span className="tabular-nums text-[var(--text-tertiary)]">{total}</span>
            </button>
            {folders.map((f) => (
                <button key={f.id} type="button" className={tab(current === f.id)} aria-pressed={current === f.id}
                    onClick={() => onSelect(f.id)} data-testid={`document-folder-${f.id}`}>
                    <Folder className="w-3.5 h-3.5" aria-hidden="true" />
                    <span className="max-w-[16rem] truncate">{f.name}</span>
                    <span className="tabular-nums text-[var(--text-tertiary)]">{counts[f.id] || 0}</span>
                </button>
            ))}
            {canEdit && editing === 'new' && (
                <NameInput initial="" label={t('doc_folders.folder_new_name', 'Name of the new folder')} busy={busy}
                    onSave={(name) => { onCreate(name); setEditing(null); }} onCancel={() => setEditing(null)} />
            )}
            {canEdit && editing === 'rename' && open && (
                <NameInput initial={open.name} label={t('doc_folders.folder_rename_name', 'New name of the folder')} busy={busy}
                    onSave={(name) => { onRename(open.id, name); setEditing(null); }} onCancel={() => setEditing(null)} />
            )}
            {canEdit && editing === null && (
                <button type="button" className={`${TAB} border-dashed border-[var(--border-default)] text-[var(--accent-primary)] hover:bg-[var(--item-hover-bg)]`}
                    onClick={() => setEditing('new')} disabled={busy} data-testid="document-folder-new">
                    <FolderPlus className="w-3.5 h-3.5" aria-hidden="true" />
                    {t('doc_folders.folder_new', 'New folder')}
                </button>
            )}
            {canEdit && editing === null && open && (
                <span className="inline-flex items-center gap-0.5 ml-1">
                    <button type="button" className={ICON_BUTTON} onClick={() => setEditing('rename')} disabled={busy}
                        aria-label={t('doc_folders.folder_rename', 'Rename folder {name}', { name: open.name })}>
                        <Pencil className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                    <button type="button" className={ICON_BUTTON} onClick={() => onDelete(open)} disabled={busy} data-testid="document-folder-delete"
                        aria-label={t('doc_folders.folder_delete', 'Delete folder {name}', { name: open.name })}>
                        <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                </span>
            )}
        </nav>
    );
}

/** "Move to folder" on one document row: the project's folders and "No folder". */
export function MoveToFolderButton({ folders, currentFolderId, documentName, onMove }: {
    folders: DocumentFolder[]; currentFolderId: string | null; documentName: string; onMove: (folderId: string | null) => void;
}) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    if (folders.length === 0) return null;
    const choose = (folderId: string | null) => { setOpen(false); if (folderId !== currentFolderId) onMove(folderId); };
    const item = (active: boolean) => `block w-full text-left px-3 py-1.5 text-sm hover:bg-[var(--item-hover-bg)] ${active ? 'font-semibold text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`;
    return (
        <span className="relative" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} role="presentation">
            <button type="button" className={ICON_BUTTON} aria-expanded={open} onClick={() => setOpen((v) => !v)}
                aria-label={t('doc_folders.folder_move', 'Move {name} to a folder', { name: documentName })}
                title={t('doc_folders.folder_move_short', 'Move to folder')} data-testid="document-move-to-folder">
                <FolderInput className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
            {open && (
                <div role="menu" className="absolute right-0 top-full mt-1 z-20 min-w-[200px] max-h-64 overflow-y-auto rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] shadow-lg py-1">
                    <button type="button" role="menuitem" className={item(currentFolderId === null)} onClick={() => choose(null)}>
                        {t('doc_folders.folder_none', 'No folder')}
                    </button>
                    {folders.map((f) => (
                        <button key={f.id} type="button" role="menuitem" className={item(currentFolderId === f.id)} onClick={() => choose(f.id)}>
                            {f.name}
                        </button>
                    ))}
                </div>
            )}
        </span>
    );
}
