import { X, FileText } from 'lucide-react';
import { useId } from 'react';
import Modal from '../../../components/shared/Modal';
import useTranslation from '../../../hooks/useTranslation';

/* ── Citation Overlay — shows source name + chunk content ────── */
interface CitationSource {
    title?: string;
    content?: string;
    page?: number;
    index?: number;
}

interface CitationOverlayProps {
    source?: unknown;
    onClose: () => void;
}

export default function CitationOverlay({ source, onClose }: CitationOverlayProps) {
    const { t } = useTranslation();
    const titleId = useId();
    if (!source) return null;

    return (
        <Modal
            open
            onClose={onClose}
            variant="bare"
            size="auto"
            zIndex={200}
            labelledBy={titleId}
            className="max-w-lg"
        >
            <div
                className="w-full rounded-2xl shadow-2xl border overflow-hidden animate-in zoom-in-95 duration-200 bg-[var(--bg-primary)] border-[var(--border-default)]"
            >
                {/* Header */}
                <div className="flex items-center gap-3 px-5 py-4 border-b border-[var(--border-subtle)]">
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center"
                        style={{ background: 'var(--brand-gradient)' }}>
                        <FileText className="w-4 h-4 text-white" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <div id={titleId} className="text-sm font-semibold truncate text-[var(--text-primary)]">
                            {(source as CitationSource).title}
                        </div>
                        {/* The page is the whole point of a citation: it can
                            be checked. Absent for anything ingested before the
                            chunker stamped one — those bytes are gone — so it
                            renders when known and is silent when not. */}
                        {Number.isInteger((source as CitationSource).page) && ((source as CitationSource).page as number) > 0 && (
                            <div className="text-[10px] text-[var(--text-tertiary)]">
                                {t('notebooks.page_short', 'p. {n}', { n: (source as CitationSource).page })}
                            </div>
                        )}
                    </div>
                    <button
                        onClick={onClose}
                        aria-label={t('notebooks.close_panel', 'Close')}
                        className="p-1.5 rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors"
                    >
                        <X className="w-4 h-4 text-[var(--text-secondary)]" />
                    </button>
                </div>

                {/* Content */}
                <div className="px-5 py-4 max-h-[400px] overflow-y-auto custom-scrollbar">
                    <div className="text-sm leading-relaxed whitespace-pre-wrap text-[var(--text-secondary)]">
                        {(source as CitationSource).content || t('notebooks.no_content_preview', 'No content preview available.')}
                    </div>
                </div>

                {/* Footer */}
                <div className="px-5 py-3 border-t flex items-center justify-between border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
                    <span className="text-[10px] font-medium text-[var(--text-tertiary)]">
                        {t('notebooks.source_number', { index: (source as CitationSource).index })}
                    </span>
                    <button
                        onClick={onClose}
                        className="px-3 py-1 text-xs font-medium rounded-lg transition-colors hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                    >
                        {t('notebooks.close_panel', 'Close')}
                    </button>
                </div>
            </div>
        </Modal>
    );
}
