// One page of the library: rows with their type, owner and last editor,
// selection for moving and categorising, copy, archive (after a confirmation)
// or, in the archive, restore. A notebook row says how many sources it reads,
// is not copied, and is deleted for good rather than archived (a notebook has
// no archive), after a confirmation that says so. Loading, empty and failed are three different
// screens; while the next page or search loads, the current list stays.

import { ArchiveRestore, BookOpen, Copy, FileText, NotebookPen, Presentation, Sheet, Share2, Trash2 } from 'lucide-react';
import React, { useState } from 'react';
import ConfirmDialog from '../../../components/shared/ConfirmDialog';
import EmptyState from '../../../components/shared/EmptyState';
import useRelativeTime from '../../../hooks/useRelativeTime';
import useTranslation from '../../../hooks/useTranslation';
import type { LibraryRow, People } from '../documentQueries';
import { useDocTypeLabel, usePersonLabel } from './labels';
import { isNotebookRow } from './useLibrary';

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
    onShare?: (row: LibraryRow) => void;
    onDuplicate: (row: LibraryRow) => void;
    /** Archives a document; deletes a notebook (the row says which it is). */
    onArchive: (row: LibraryRow) => Promise<unknown>;
    onUnarchive: (row: LibraryRow) => void;
    onRetry: () => void;
    onCreate: () => void;
    busyId: string | null;
}

const ACTION = 'p-1.5 rounded-lg text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)] disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)]';

function rowIcon(docType: string) {
    if (docType === 'presentation') return Presentation;
    if (docType === 'page') return NotebookPen;
    if (docType === 'notebook') return BookOpen;
    if (docType === 'spreadsheet') return Sheet;
    return FileText;
}

function Row({ row, props, onAskArchive }: { row: LibraryRow; props: LibraryListProps; onAskArchive: (row: LibraryRow) => void }) {
    const { t } = useTranslation();
    const rel = useRelativeTime();
    const typeLabel = useDocTypeLabel();
    const person = usePersonLabel(props.people, props.currentUserId);
    const Icon = rowIcon(row.docType);
    const notebook = isNotebookRow(row);
    const sources = !notebook ? null : row.sourceCount === 1
        ? t('documents.notebook.source_one', '1 source')
        : t('documents.notebook.sources', '{count} sources', { count: row.sourceCount || 0 });
    const selected = props.selection.includes(row.id);
    const edited = row.updatedBy && row.updatedBy !== row.userId ? t('documents.library.edited_by', 'edited by {name}', { name: person(row.updatedBy) }) : null;
    return (
        <li className="group flex gap-3 items-center px-4 py-3 rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] shadow-sm hover:border-[var(--accent-primary)] transition-colors" data-testid={`library-row-${row.id}`}>
            {!props.archivedView && (
                <input type="checkbox" checked={selected} aria-label={t('documents.library.select', 'Select {name}', { name: row.name })}
                    onChange={(e) => props.onSelect(e.target.checked ? [...props.selection, row.id] : props.selection.filter((x) => x !== row.id))} />
            )}
            <span className="shrink-0 w-9 h-9 rounded-[10px] flex items-center justify-center text-[var(--kind-doc)] bg-[color-mix(in_srgb,var(--kind-doc)_14%,transparent)]" aria-hidden="true">
                <Icon size={18} />
            </span>
            <button type="button" className="flex-1 min-w-0 text-left disabled:cursor-default" onClick={() => props.onOpen(row)} disabled={props.archivedView}>
                <span className="block text-sm font-semibold truncate text-[var(--text-primary)]">{row.name}</span>
                <span className="block text-xs mt-0.5 text-[var(--text-tertiary)]">
                    {[typeLabel(row.docType), sources, person(row.userId), rel(row.updatedAt), edited, row.visibility === 'team' ? t('documents.library.team', 'Team') : null].filter(Boolean).join(' · ')}
                </span>
                {!!row.categories?.length && <span className="block text-xs mt-1 text-[var(--text-secondary)]">{row.categories.join(' · ')}</span>}
            </button>
            {props.archivedView ? (
                <button type="button" className={ACTION} disabled={props.busyId === row.id} onClick={() => props.onUnarchive(row)} aria-label={t('documents.library.unarchive', 'Restore {name}', { name: row.name })} data-testid={`library-unarchive-${row.id}`}>
                    <ArchiveRestore size={15} aria-hidden="true" />
                </button>
            ) : (
                <>
                    {row.userId === props.currentUserId && props.onShare && <button type="button" className={ACTION} onClick={() => props.onShare?.(row)} aria-label={t('documents.sharing.title', 'Share {name}', { name: row.name })}><Share2 size={15} aria-hidden="true" /></button>}
                    {!notebook && (
                        <button type="button" className={ACTION} disabled={props.busyId === row.id} onClick={() => props.onDuplicate(row)} aria-label={t('documents.library.duplicate', 'Make a copy of {name}', { name: row.name })}><Copy size={15} aria-hidden="true" /></button>
                    )}
                    {row.userId === props.currentUserId && (
                        <button type="button" className={ACTION} disabled={props.busyId === row.id} onClick={() => onAskArchive(row)}
                            aria-label={notebook ? t('documents.notebook.delete', 'Delete {name}', { name: row.name }) : t('documents.library.archive', 'Archive {name}', { name: row.name })}>
                            <Trash2 size={15} aria-hidden="true" />
                        </button>
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
                {[0, 1, 2].map((i) => <li key={i} className="h-[62px] rounded-xl bg-[var(--bg-tertiary)] animate-pulse" />)}
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
    const notebook = !!confirming && isNotebookRow(confirming);
    const name = confirming?.name || '';
    return (
        <>
            <Body props={props} onAskArchive={setConfirming} />
            <ConfirmDialog
                open={!!confirming}
                title={notebook ? t('documents.notebook.delete_title', 'Delete this notebook?') : t('documents.library.archive_title', 'Archive this document?')}
                description={notebook
                    ? t('documents.notebook.delete_desc', '"{name}" is deleted for good, with its sources, its chat and its versions. A notebook cannot be restored.', { name })
                    : t('documents.library.archive_desc', '"{name}" leaves your library and every project it is filed in. You can restore it from Archived; automations that use a saved version keep working.', { name })}
                confirmLabel={notebook ? t('documents.notebook.delete_confirm', 'Delete notebook') : t('documents.library.archive_confirm', 'Archive')}
                cancelLabel={t('documents.cancel', 'Cancel')}
                destructive
                onConfirm={async () => { if (confirming) await props.onArchive(confirming).catch(() => undefined); setConfirming(null); }}
                onCancel={() => setConfirming(null)}
            />
        </>
    );
}
