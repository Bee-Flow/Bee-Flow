/**
 * SourceActivity — what is happening to the notebook's sources right now,
 * shown at the top of the sources rail:
 *
 *   - the upload queue: one row per file (waiting, uploading, added, or
 *     failed with the server's reason and a retry), with an overall count;
 *   - "Source removed — Undo" for a few seconds after a removal, before the
 *     removal is actually sent.
 *
 * Calm by design: rows, not toasts; nothing to confirm in a dialog.
 */
import React from 'react';
import { CheckCircle2, Loader2, RotateCw, Undo2, X, AlertCircle, Clock } from 'lucide-react';
import useTranslation from '../../hooks/useTranslation';
import type { PendingDelete, UploadItem } from './hooks/useSourcesPolling';

interface Props {
    uploads: UploadItem[];
    pendingDelete: PendingDelete | null;
    onUndoDelete: () => void;
    onRetryUpload: (id: string) => void;
    onDismissUpload: (id: string) => void;
}

function formatSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function SourceActivity({ uploads, pendingDelete, onUndoDelete, onRetryUpload, onDismissUpload }: Props) {
    const { t } = useTranslation();
    if (!uploads.length && !pendingDelete) return null;
    const finished = uploads.filter((u) => u.status === 'done').length;
    const inFlight = uploads.filter((u) => u.status === 'queued' || u.status === 'uploading').length;
    // A computed width cannot be a static class.
    const barStyle = { width: `${Math.round((finished / Math.max(1, uploads.length)) * 100)}%` };

    return (
        <div className="shrink-0 mx-3 mb-2 space-y-1.5" data-testid="source-activity">
            {pendingDelete && (
                <div role="status" className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-[var(--bg-tertiary)] text-[12px] text-[var(--text-secondary)]" data-testid="source-undo">
                    <span className="flex-1 min-w-0 truncate">
                        {t('notebooks.source_removed', '"{name}" removed', { name: pendingDelete.source.name })}
                    </span>
                    <button type="button" onClick={onUndoDelete} className="shrink-0 inline-flex items-center gap-1 font-semibold text-[var(--text-primary)] hover:underline" data-testid="source-undo-button">
                        <Undo2 className="w-3 h-3" aria-hidden="true" />{t('notebooks.undo', 'Undo')}
                    </button>
                </div>
            )}
            {uploads.length > 0 && (
                <section aria-label={t('notebooks.uploads_label', 'Uploads')} className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] px-2.5 py-2 space-y-1.5" data-testid="upload-queue">
                    <p className="m-0 flex items-center justify-between text-[11.5px] font-medium text-[var(--text-secondary)]" role="status" aria-live="polite">
                        <span>
                            {inFlight > 0
                                ? t('notebooks.uploads_progress', 'Uploading {done} of {total}', { done: finished, total: uploads.length })
                                : t('notebooks.uploads_finished', 'Uploads finished')}
                        </span>
                    </p>
                    <div className="h-1 rounded-full overflow-hidden bg-[var(--bg-tertiary)]" aria-hidden="true">
                        <div className="h-full rounded-full bg-[var(--accent-primary)] transition-[width] duration-300" style={barStyle} />
                    </div>
                    <ul className="m-0 p-0 list-none space-y-1">
                        {uploads.map((u) => (
                            <li key={u.id} className="flex items-start gap-1.5 text-[11.5px]" data-testid={`upload-${u.status}`}>
                                <span className="mt-0.5 shrink-0" aria-hidden="true">
                                    {u.status === 'queued' && <Clock className="w-3 h-3 text-[var(--text-tertiary)]" />}
                                    {u.status === 'uploading' && <Loader2 className="w-3 h-3 animate-spin text-[var(--accent-primary)]" />}
                                    {u.status === 'done' && <CheckCircle2 className="w-3 h-3 text-[var(--success)]" />}
                                    {u.status === 'failed' && <AlertCircle className="w-3 h-3 text-[var(--error)]" />}
                                </span>
                                <span className="flex-1 min-w-0">
                                    <span className="block truncate text-[var(--text-primary)]" title={u.name}>{u.name}</span>
                                    <span className={`block ${u.status === 'failed' ? 'text-[var(--error-ink)]' : 'text-[var(--text-tertiary)]'}`}>
                                        {u.status === 'queued' && t('notebooks.upload_waiting', 'Waiting…')}
                                        {u.status === 'uploading' && t('notebooks.upload_uploading', 'Uploading {size}', { size: formatSize(u.size) })}
                                        {u.status === 'done' && t('notebooks.upload_done', 'Added — reading it now')}
                                        {u.status === 'failed' && (u.error || t('notebooks.upload_failed', 'Upload failed'))}
                                    </span>
                                </span>
                                {u.status === 'failed' && (
                                    <span className="shrink-0 flex items-center gap-0.5">
                                        <button type="button" onClick={() => onRetryUpload(u.id)} className="p-0.5 rounded hover:bg-[var(--bg-tertiary)]" aria-label={t('notebooks.upload_retry', 'Retry {name}', { name: u.name })}>
                                            <RotateCw className="w-3 h-3 text-[var(--text-secondary)]" aria-hidden="true" />
                                        </button>
                                        <button type="button" onClick={() => onDismissUpload(u.id)} className="p-0.5 rounded hover:bg-[var(--bg-tertiary)]" aria-label={t('notebooks.upload_dismiss', 'Remove {name} from the list', { name: u.name })}>
                                            <X className="w-3 h-3 text-[var(--text-secondary)]" aria-hidden="true" />
                                        </button>
                                    </span>
                                )}
                            </li>
                        ))}
                    </ul>
                </section>
            )}
        </div>
    );
}
