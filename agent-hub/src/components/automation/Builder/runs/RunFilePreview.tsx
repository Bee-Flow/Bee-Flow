import React, { useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import Modal from '../../../shared/Modal';
import { useTranslation } from '../../../../hooks/useTranslation';
import useRunFilePreview from '../../../../hooks/automationBuilder/useRunFilePreview';
import type { RunFileRef, RunFilePreviewKind } from '../../../../api/queries/automation/runFiles';

const PAGE_BTN = 'p-1.5 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] disabled:opacity-40 disabled:cursor-not-allowed';

/** A kept file in a dialog: an image whole, a PDF one page at a time. */
export default function RunFilePreview({ runId, file, kind, onClose }: {
    runId: string;
    file: RunFileRef;
    kind: RunFilePreviewKind;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    const [page, setPage] = useState(1);
    const { url, totalPages, loading, errorCode } = useRunFilePreview(runId, file.fileId, kind, page);
    const lastPage = totalPages ?? page;

    let failure: string | null = null;
    if (errorCode === 'preview_unavailable') failure = t('runs.file.preview_unavailable', 'Previews are not available on this server.');
    else if (errorCode === 'run_file_too_large_to_preview') failure = t('runs.file.preview_too_large', 'This file is too large to preview. Download it instead.');
    else if (errorCode) failure = t('runs.file.preview_failed', 'Could not show a preview of this file.');

    return (
        <Modal open onClose={onClose} title={file.name} size="xl" data-testid="run-file-preview">
            <div className="flex flex-col items-center gap-3 min-h-[240px]">
                {failure ? (
                    <div role="alert" className="py-10 text-xs text-[var(--text-secondary)]">{failure}</div>
                ) : (
                    <div className="relative w-full flex justify-center">
                        {url && <img src={url} alt={file.name} className="max-w-full max-h-[70vh] object-contain bg-white rounded-md border border-[var(--border-default)]" />}
                        {loading && (
                            <span role="status" className="absolute inset-0 grid place-items-center text-[var(--text-tertiary)]">
                                <Loader2 size={18} className="animate-spin" aria-label={t('runs.file.preview_loading', 'Loading the preview')} />
                            </span>
                        )}
                    </div>
                )}
                {kind === 'pdf' && lastPage > 1 && (
                    <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                        <button type="button" className={PAGE_BTN} disabled={page <= 1 || loading} onClick={() => setPage(page - 1)} aria-label={t('runs.file.prev_page', 'Previous page')}>
                            <ChevronLeft size={14} aria-hidden />
                        </button>
                        <span>{t('runs.file.page_of', 'Page {page} of {total}', { page, total: lastPage })}</span>
                        <button type="button" className={PAGE_BTN} disabled={page >= lastPage || loading} onClick={() => setPage(page + 1)} aria-label={t('runs.file.next_page', 'Next page')}>
                            <ChevronRight size={14} aria-hidden />
                        </button>
                    </div>
                )}
            </div>
        </Modal>
    );
}
