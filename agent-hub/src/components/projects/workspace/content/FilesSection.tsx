// The project's own files: drop or pick files to upload them, see whether
// each one is ready for the AI to use, and delete one. The files live in the
// project's own knowledge base, so chats in the project can answer from them.

import { AlertTriangle, File as FileIcon, Loader2, ShieldCheck, Trash2, Upload } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import {
    useDeleteProjectFile, useProjectFilesQuery, type ProjectFile,
} from '../../../../api/queries/projectContent';
import useRelativeTime from '../../../../hooks/useRelativeTime';
import useTranslation from '../../../../hooks/useTranslation';
import { projectErrorText } from '../projectErrorText';
import { toast } from '../../../shared/Toast';
import useConfirm from '../../../shared/useConfirm';
import { SecondaryButton, SectionCard, SectionError } from './contentUi';
import { formatFileSize } from './labels';
import useFileUploads, { type UploadRow } from './useFileUploads';

function StatusChip({ status }: { status: ProjectFile['status'] }) {
    const { t } = useTranslation();
    if (status === 'ready') return null;
    const failed = status === 'failed';
    return (
        <span className={`shrink-0 px-2 py-0.5 rounded-full text-[11px] border ${failed ? 'border-[var(--error)] text-[var(--error)]' : 'border-[var(--border-default)] text-[var(--text-tertiary)]'}`}>
            {failed ? t('project_content.file_failed', 'Could not be read') : t('project_content.file_processing', 'Indexing…')}
        </span>
    );
}

/** The privacy policy replaced personal data in the file before it was stored. */
function RedactedBadge() {
    const { t } = useTranslation();
    return (
        <span
            className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] border border-[var(--border-default)] text-[var(--text-secondary)]"
            title={t('project_content.file_redacted_hint', 'Personal data in this file was replaced by placeholders before it was stored, as your organisation’s privacy policy asks. Chats answer from the version with placeholders.')}
        >
            <ShieldCheck className="w-3 h-3" aria-hidden="true" />
            {t('project_content.file_redacted', 'Personal data replaced')}
        </span>
    );
}

function FileRow({ file, uploader, canDelete, deleting, onDelete }: {
    file: ProjectFile; uploader: string; canDelete: boolean; deleting: boolean; onDelete: () => void;
}) {
    const { t, locale } = useTranslation();
    const rel = useRelativeTime();
    const meta = [formatFileSize(file.size, locale), uploader, rel(file.createdAt)].filter(Boolean).join(' · ');
    // The server says why a file failed (a duplicate, a privacy-policy block,
    // an interrupted upload); without it the person cannot tell what to do.
    const reason = file.status === 'failed' ? (file.statusReason || '').trim() : '';
    return (
        <li className="flex items-center gap-2.5 px-2 py-2 border-b border-[var(--border-subtle)] last:border-b-0" data-testid={`project-file-${file.id}`}>
            <FileIcon className="w-4 h-4 shrink-0 text-[var(--kind-kb)]" aria-hidden="true" />
            <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium text-[var(--text-primary)] truncate">{file.name}</div>
                {meta && <div className="text-[11px] text-[var(--text-tertiary)] truncate">{meta}</div>}
                {reason && <div className="text-[11px] text-[var(--error)]" data-testid={`project-file-reason-${file.id}`}>{reason}</div>}
            </div>
            {file.redacted && file.status !== 'failed' && <RedactedBadge />}
            <StatusChip status={file.status} />
            {canDelete && (
                <button type="button" onClick={onDelete} disabled={deleting}
                    aria-label={t('project_content.file_delete_named', 'Delete {name}', { name: file.name })}
                    className="grid place-items-center w-7 h-7 rounded-lg text-[var(--text-tertiary)] hover:text-[var(--error)] hover:bg-[var(--item-hover-bg)] disabled:opacity-50">
                    <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
            )}
        </li>
    );
}

function UploadRows({ rows, onDismiss }: { rows: UploadRow[]; onDismiss: (key: string) => void }) {
    const { t } = useTranslation();
    if (!rows.length) return null;
    return (
        <ul className="mb-2 space-y-1" aria-live="polite" data-testid="project-file-uploads">
            {rows.map(r => (
                <li key={r.key} className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-[12px] bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
                    {r.status === 'uploading'
                        ? <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" aria-hidden="true" />
                        : <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-[var(--error)]" aria-hidden="true" />}
                    <span className="truncate font-medium">{r.name}</span>
                    <span className="flex-1 min-w-0 truncate" role={r.status === 'failed' ? 'alert' : undefined}>
                        {r.status === 'uploading' ? t('project_content.file_uploading', 'Uploading…') : r.error}
                    </span>
                    {r.status === 'failed' && (
                        <button type="button" onClick={() => onDismiss(r.key)} className="text-[11px] font-medium text-[var(--accent-primary)] hover:underline">
                            {t('project_content.dismiss', 'Dismiss')}
                        </button>
                    )}
                </li>
            ))}
        </ul>
    );
}

/** The drop target around the list. Only editors can drop. */
function DropZone({ enabled, onFiles, children }: { enabled: boolean; onFiles: (files: File[]) => void; children: React.ReactNode }) {
    const { t } = useTranslation();
    const [over, setOver] = useState(false);
    if (!enabled) return <>{children}</>;
    const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types || []).includes('Files');
    return (
        <div
            data-testid="project-files-dropzone"
            onDragOver={(e) => { if (!hasFiles(e)) return; e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); onFiles(Array.from(e.dataTransfer?.files || [])); }}
            className={`relative rounded-lg border border-dashed p-2 transition-colors ${over ? 'border-[var(--accent-primary)] bg-[var(--bg-secondary)]' : 'border-[var(--border-default)]'}`}
        >
            {children}
            {over && (
                <div className="absolute inset-0 grid place-items-center rounded-lg bg-[var(--bg-card)] text-sm font-medium text-[var(--accent-primary)] pointer-events-none">
                    {t('project_content.files_drop_here', 'Drop to upload into this project')}
                </div>
            )}
        </div>
    );
}

function useFileDelete(projectId: string) {
    const { t } = useTranslation();
    const del = useDeleteProjectFile(projectId);
    const { confirm, confirmDialog } = useConfirm();
    const run = async (file: ProjectFile) => {
        const ok = await confirm({
            title: t('project_content.file_delete_title', 'Delete this file?'),
            description: t('project_content.file_delete_desc', '"{name}" is removed from the project, and chats stop answering from it.', { name: file.name }),
            confirmLabel: t('project_content.delete', 'Delete'),
            cancelLabel: t('project_content.cancel', 'Cancel'),
            destructive: true,
        });
        if (!ok) return;
        try { await del.mutateAsync(file.id); } catch (e) { toast.error(projectErrorText(t, e)); }
    };
    return { run, deletingId: del.isPending ? del.variables ?? null : null, confirmDialog };
}

function FileList({ status, files, emptyText, onRetry, row }: {
    status: 'loading' | 'error' | 'ok'; files: ProjectFile[]; emptyText: string; onRetry: () => void;
    row: (file: ProjectFile) => React.ReactNode;
}) {
    const { t } = useTranslation();
    if (status === 'loading') return <p role="status" className="px-2 py-3 text-sm text-[var(--text-tertiary)]">{t('project_content.files_loading', 'Loading files…')}</p>;
    if (status === 'error') return <SectionError message={t('project_content.files_error', 'The files of this project could not be loaded.')} onRetry={onRetry} />;
    if (!files.length) return <p className="px-2 py-4 text-center text-sm text-[var(--text-tertiary)]">{emptyText}</p>;
    return <ul data-testid="project-files-list">{files.map(row)}</ul>;
}

export default function FilesSection({ projectId, canEdit, uploaderName, openPicker = false }: {
    projectId: string; canEdit: boolean; uploaderName: (userId: string | null | undefined) => string; openPicker?: boolean;
}) {
    const { t } = useTranslation();
    const query = useProjectFilesQuery(projectId);
    const uploads = useFileUploads(projectId);
    const removal = useFileDelete(projectId);
    const input = useRef<HTMLInputElement>(null);
    const status = query.isPending ? 'loading' : query.isError ? 'error' : 'ok';

    // Arriving from an "Upload files" shortcut: offer the chooser once, at once.
    const offered = useRef(false);
    useEffect(() => {
        if (!openPicker || !canEdit || offered.current) return;
        offered.current = true;
        input.current?.click();
    }, [openPicker, canEdit]);

    const actions = canEdit ? (
        <>
            <input ref={input} type="file" multiple className="hidden" data-testid="project-files-input"
                aria-label={t('project_content.files_upload', 'Upload files')}
                onChange={(e) => { const picked = Array.from(e.target.files || []); e.target.value = ''; uploads.add(picked); }} />
            <SecondaryButton icon={Upload} onClick={() => input.current?.click()} testId="project-files-upload">{t('project_content.files_upload', 'Upload files')}</SecondaryButton>
        </>
    ) : null;

    return (
        <SectionCard
            title={t('project_content.files_title', 'Files')}
            description={t('project_content.files_desc', 'Files every member can use: chats in this project answer from them. Up to 20 MB each.')}
            actions={actions}
            testId="project-files-section"
        >
            <UploadRows rows={uploads.rows} onDismiss={uploads.dismiss} />
            <DropZone enabled={canEdit} onFiles={uploads.add}>
                <FileList
                    status={status} files={query.data?.files || []} onRetry={() => { query.refetch(); }}
                    emptyText={canEdit
                        ? t('project_content.files_empty_editor', 'No files yet. Drop files here or use Upload files.')
                        : t('project_content.files_empty', 'No files yet.')}
                    row={(file) => (
                        <FileRow key={file.id} file={file} uploader={uploaderName(file.uploadedBy)} canDelete={canEdit}
                            deleting={removal.deletingId === file.id} onDelete={() => removal.run(file)} />
                    )}
                />
            </DropZone>
            {removal.confirmDialog}
        </SectionCard>
    );
}
