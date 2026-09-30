// One page of the library: rows with their type, owner and last editor,
// selection for moving and categorising, copy, archive (after a confirmation)
// or, in the archive, restore. Loading, empty and failed are three different
// screens; while the next page or search loads, the current list stays.

import { ArchiveRestore, Copy, FileText, NotebookPen, Presentation, Trash2 } from 'lucide-react';
import React, { useState } from 'react';
import ConfirmDialog from '../../../components/shared/ConfirmDialog';
import EmptyState from '../../../components/shared/EmptyState';
import useRelativeTime from '../../../hooks/useRelativeTime';
import useTranslation from '../../../hooks/useTranslation';
import type { LibraryRow, People } from '../documentQueries';
import { useDocTypeLabel, usePersonLabel } from './labels';

export interface LibraryListProps {
    rows: LibraryRow[];
    people: People;
    currentUserId: string | null;
    status: 'loading' | 'error' | 'ok';
    refreshing: boolean;
    archivedView: boolean;
    filtered: boolean;
    selection: string[];
    onSelect: (ids: string[]) => void;
    onOpen: (row: LibraryRow) => void;
    onDuplicate: (row: LibraryRow) => void;
    onArchive: (row: LibraryRow) => Promise<unknown>;
    onUnarchive: (row: LibraryRow) => void;
    onRetry: () => void;
    onCreate: () => void;
    busyId: string | null;
}

const ACTION = 'p-2 rounded-lg border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--item-hover-bg)] disabled:opacity-50';

function Row({ row, props, onAskArchive }: { row: LibraryRow; props: LibraryListProps; onAskArchive: (row: LibraryRow) => void }) {
    const { t } = useTranslation();
    const rel = useRelativeTime();
    const typeLabel = useDocTypeLabel();
    const person = usePersonLabel(props.people, props.currentUserId);
    const Icon = row.docType === 'presentation' ? Presentation : row.docType === 'page' ? NotebookPen : FileText;
    const selected = props.selection.includes(row.id);
    const edited = row.updatedBy && row.updatedBy !== row.userId ? t('documents.library.edited_by', 'edited by {name}', { name: person(row.updatedBy) }) : null;
    return (
        <li className="flex gap-3 items-center p-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]" data-testid={`library-row-${row.id}`}>
            {!props.archivedView && (
                <input type="checkbox" checked={selected} aria-label={t('documents.library.select', 'Select {name}', { name: row.name })}
                    onChange={(e) => props.onSelect(e.target.checked ? [...props.selection, row.id] : props.selection.filter((x) => x !== row.id))} />
            )}
            <Icon size={20} className="shrink-0 text-[var(--kind-doc)]" aria-hidden="true" />
            <button type="button" className="flex-1 min-w-0 text-left disabled:cursor-default" onClick={() => props.onOpen(row)} disabled={props.archivedView}>
                <span className="block font-medium truncate text-[var(--text-primary)]">{row.name}</span>
                <span className="block text-xs mt-1 text-[var(--text-tertiary)]">
                    {[typeLabel(row.docType), person(row.userId), rel(row.updatedAt), edited, row.visibility === 'team' ? t('documents.library.team', 'Team') : null].filter(Boolean).join(' · ')}
                </span>
                {!!row.categories?.length && <span className="block text-xs mt-1 text-[var(--text-secondary)]">{row.categories.join(' · ')}</span>}
            </button>
            {props.archivedView ? (
                <button type="button" className={ACTION} disabled={props.busyId === row.id} onClick={() => props.onUnarchive(row)} aria-label={t('documents.library.unarchive', 'Restore {name}', { name: row.name })} data-testid={`library-unarchive-${row.id}`}>
                    <ArchiveRestore size={15} aria-hidden="true" />
                </button>
            ) : (
                <>
                    <button type="button" className={ACTION} disabled={props.busyId === row.id} onClick={() => props.onDuplicate(row)} aria-label={t('documents.library.duplicate', 'Make a copy of {name}', { name: row.name })}><Copy size={15} aria-hidden="true" /></button>
                    {row.userId === props.currentUserId && (
                        <button type="button" className={ACTION} disabled={props.busyId === row.id} onClick={() => onAskArchive(row)} aria-label={t('documents.library.archive', 'Archive {name}', { name: row.name })}><Trash2 size={15} aria-hidden="true" /></button>
                    )}
                </>
            )}
        </li>
    );
}

function Body({ props, onAskArchive }: { props: LibraryListProps; onAskArchive: (row: LibraryRow) => void }) {
    const { t } = useTranslation();
    if (props.status === 'error') {
        return (
            <div role="alert" className="p-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--error)]/10 text-sm text-[var(--text-primary)] flex items-center gap-3">
                <span className="flex-1">{t('documents.library.load_failed', 'The documents could not be loaded.')}</span>
                <button type="button" className="underline" onClick={props.onRetry}>{t('documents.retry', 'Try again')}</button>
            </div>
        );
    }
    if (props.status === 'loading') {
        return (
            <ul className="space-y-2" role="status" aria-label={t('documents.library.loading', 'Loading documents…')}>
                {[0, 1, 2].map((i) => <li key={i} className="h-[72px] rounded-xl bg-[var(--bg-tertiary)] animate-pulse" />)}
            </ul>
        );
    }
    if (!props.rows.length) {
        if (props.archivedView) return <EmptyState icon={<ArchiveRestore className="w-10 h-10" />} title={t('documents.library.archive_empty', 'Nothing archived')} description={t('documents.library.archive_empty_desc', 'Documents you archive wait here until you restore them.')} />;
        if (props.filtered) return <p className="py-10 text-center text-sm text-[var(--text-tertiary)]">{t('documents.library.no_matches', 'Nothing matches these filters.')}</p>;
        return <EmptyState icon={<FileText className="w-10 h-10" />} title={t('documents.library.empty_title', 'No documents here yet')} description={t('documents.library.empty_desc', 'Start from a template, write a page, or ask the assistant in a chat to draft one.')} action={{ label: t('documents.new_button', 'New document'), onClick: props.onCreate }} />;
    }
    return (
        <ul className={`space-y-2 transition-opacity ${props.refreshing ? 'opacity-60' : ''}`} aria-busy={props.refreshing || undefined} data-testid="library-list">
            {props.rows.map((row) => <Row key={row.id} row={row} props={props} onAskArchive={onAskArchive} />)}
        </ul>
    );
}

export default function LibraryList(props: LibraryListProps) {
    const { t } = useTranslation();
    const [confirming, setConfirming] = useState<LibraryRow | null>(null);
    return (
        <>
            <Body props={props} onAskArchive={setConfirming} />
            <ConfirmDialog
                open={!!confirming}
                title={t('documents.library.archive_title', 'Archive this document?')}
                description={t('documents.library.archive_desc', '"{name}" leaves your library and every project it is filed in. You can restore it from Archived; routines that use a saved version keep working.', { name: confirming?.name || '' })}
                confirmLabel={t('documents.library.archive_confirm', 'Archive')}
                cancelLabel={t('documents.cancel', 'Cancel')}
                destructive
                onConfirm={async () => { if (confirming) await props.onArchive(confirming).catch(() => undefined); setConfirming(null); }}
                onCancel={() => setConfirming(null)}
            />
        </>
    );
}
