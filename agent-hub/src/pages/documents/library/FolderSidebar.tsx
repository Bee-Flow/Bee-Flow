// The library's folders: all documents, the root, the folders of the folder
// being looked at, a new folder, and deleting one (after a confirmation that
// says its documents move up, not away).

import { ChevronRight, Folder, Plus, Trash2 } from 'lucide-react';
import React, { useState } from 'react';
import ConfirmDialog from '../../../components/shared/ConfirmDialog';
import useTranslation from '../../../hooks/useTranslation';
import type { Folder as FolderRow } from '../documentQueries';

export interface FolderSidebarProps {
    folders: FolderRow[];
    folderId: string | undefined;
    onFolder: (id: string | undefined) => void;
    onCreate: (name: string) => Promise<unknown>;
    onDelete: (folder: FolderRow) => Promise<unknown>;
    busy: boolean;
}

const ROW = 'w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-left text-[var(--text-secondary)] hover:bg-[var(--item-hover-bg)]';
const ACTIVE = 'bg-[var(--bg-tertiary)] font-semibold text-[var(--text-primary)]';

export default function FolderSidebar({ folders, folderId, onFolder, onCreate, onDelete, busy }: FolderSidebarProps) {
    const { t } = useTranslation();
    const [name, setName] = useState('');
    const [confirming, setConfirming] = useState<FolderRow | null>(null);
    const parent = folders.find((f) => f.id === folderId);
    const visible = folders.filter((f) => (f.parentId || null) === (folderId || null));
    return (
        <aside className="space-y-1" aria-label={t('documents.library.folders', 'Folders')}>
            <button type="button" className={`${ROW} ${folderId === undefined ? ACTIVE : ''}`} onClick={() => onFolder(undefined)}>{t('documents.library.all', 'All documents')}</button>
            <button type="button" className={`${ROW} ${folderId === '' ? ACTIVE : ''}`} onClick={() => onFolder('')}>{t('documents.library.root', 'Not in a folder')}</button>
            {parent && (
                <div className="flex items-center gap-1 px-2 text-sm text-[var(--text-primary)]">
                    <button type="button" className="underline text-[var(--text-tertiary)]" onClick={() => onFolder(parent.parentId || '')}>{t('documents.library.up', 'Up')}</button>
                    <ChevronRight size={14} aria-hidden="true" />
                    <span className="truncate flex-1">{parent.name}</span>
                    <button type="button" className="p-1 rounded hover:bg-[var(--item-hover-bg)]" aria-label={t('documents.library.delete_folder', 'Delete folder {name}', { name: parent.name })} onClick={() => setConfirming(parent)}>
                        <Trash2 size={13} aria-hidden="true" />
                    </button>
                </div>
            )}
            {visible.map((f) => (
                <button type="button" className={ROW} key={f.id} onClick={() => onFolder(f.id)}><Folder size={15} aria-hidden="true" />{f.name}</button>
            ))}
            <form className="flex gap-1 pt-2" onSubmit={(e) => { e.preventDefault(); if (name.trim()) onCreate(name.trim()).then(() => setName('')).catch(() => undefined); }}>
                <input className="w-full min-w-0 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-3 py-2 text-sm" value={name} onChange={(e) => setName(e.target.value)}
                    placeholder={t('documents.library.new_folder', 'New folder')} aria-label={t('documents.library.new_folder_name', 'New folder name')} />
                <button type="submit" className="px-2.5 rounded-lg border border-[var(--border-subtle)] hover:bg-[var(--item-hover-bg)] disabled:opacity-50" disabled={!name.trim() || busy} aria-label={t('documents.library.create_folder', 'Create folder')}>
                    <Plus size={14} aria-hidden="true" />
                </button>
            </form>
            <ConfirmDialog
                open={!!confirming}
                title={t('documents.library.delete_folder_title', 'Delete this folder?')}
                description={t('documents.library.delete_folder_desc', 'The documents and folders in "{name}" move up one level. Nothing else is deleted.', { name: confirming?.name || '' })}
                confirmLabel={t('documents.library.delete_folder_confirm', 'Delete folder')}
                cancelLabel={t('documents.cancel', 'Cancel')}
                destructive
                onConfirm={async () => { const f = confirming; if (!f) return; await onDelete(f).catch(() => undefined); setConfirming(null); onFolder(f.parentId || ''); }}
                onCancel={() => setConfirming(null)}
            />
        </aside>
    );
}
