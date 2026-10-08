/**
 * SourcePreviewModal — the extracted text of a source, through the shared
 * Modal (Escape, focus trap, focus back on the source row). z 10060 keeps it
 * above the editor's floating toolbars; a press inside the panel stops there
 * so the editor's outside-press handlers never see it.
 */
import React, { useId } from 'react';
import { Loader2, X } from 'lucide-react';
import Modal from '../../../../components/shared/Modal';
import useTranslation from '../../../../hooks/useTranslation';

export interface SourcePreview { name: string; loading: boolean; content: string; failed?: boolean }

export default function SourcePreviewModal({ preview, onClose }: { preview: SourcePreview; onClose: () => void }) {
    const { t } = useTranslation();
    const titleId = useId();
    return (
        <Modal open onClose={onClose} variant="bare" size="auto" zIndex={10060} labelledBy={titleId} className="max-w-[640px]">
            <div
                className="w-full max-h-[80vh] flex flex-col rounded-2xl border shadow-2xl bg-[var(--bg-primary)] border-[var(--border-default)]"
                onMouseDown={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between gap-2 px-4 py-3 border-b shrink-0 border-[var(--border-subtle)]">
                    <h3 id={titleId} className="m-0 text-sm font-semibold truncate text-[var(--text-primary)]">{preview.name}</h3>
                    <button
                        type="button"
                        onClick={onClose}
                        className="p-1 rounded-lg hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                        aria-label={t('notebooks.close_panel', 'Close')}
                    >
                        <X className="w-4 h-4" aria-hidden="true" />
                    </button>
                </div>
                <div className="flex-1 overflow-y-auto custom-scrollbar p-4">
                    {preview.loading ? (
                        <div className="flex items-center justify-center py-10 text-[var(--text-muted)]" role="status" aria-label={t('notebooks.loading', 'Loading…')}>
                            <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
                        </div>
                    ) : preview.failed ? (
                        <p role="alert" className="m-0 text-xs text-center py-10 text-[var(--error-ink)]">
                            {t('notebooks.preview_failed', 'The preview could not be loaded. Try again in a moment.')}
                        </p>
                    ) : preview.content ? (
                        <pre className="m-0 text-xs leading-relaxed whitespace-pre-wrap break-words font-[inherit] text-[var(--text-secondary)]">{preview.content}</pre>
                    ) : (
                        <p className="m-0 text-xs text-center py-10 text-[var(--text-muted)]">{t('notebooks.no_preview', 'No preview available for this source.')}</p>
                    )}
                </div>
            </div>
        </Modal>
    );
}
