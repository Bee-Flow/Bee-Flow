import { X, FileText } from 'lucide-react';
import React, { useId } from 'react';
import Modal from '../../components/shared/Modal';
import useTranslation from '../../hooks/useTranslation';

/* ── Citation Overlay — shows source name + chunk content ────── */
export default function CitationOverlay({ source, onClose }) {
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
                className="w-full rounded-2xl shadow-2xl border overflow-hidden animate-in zoom-in-95 duration-200"
                style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)' }}
            >
                {/* Header */}
                <div className="flex items-center gap-3 px-5 py-4 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center"
                        style={{ background: 'var(--brand-gradient)' }}>
                        <FileText className="w-4 h-4 text-white" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <div id={titleId} className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                            {source.title}
                        </div>
                        {/* The page is the whole point of a citation: it can
                            be checked. Absent for anything ingested before the
                            chunker stamped one — those bytes are gone — so it
                            renders when known and is silent when not. */}
                        {Number.isInteger(source.page) && source.page > 0 && (
                            <div className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                                {t('notebooks.page_short', 'p. {n}', { n: source.page })}
                            </div>
                        )}
                    </div>
                    <button
                        onClick={onClose}
                        aria-label={t('notebooks.close', 'Close')}
                        className="p-1.5 rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors"
                    >
                        <X className="w-4 h-4" style={{ color: 'var(--text-secondary)' }} />
                    </button>
                </div>

                {/* Content */}
                <div className="px-5 py-4 max-h-[400px] overflow-y-auto custom-scrollbar">
                    <div className="text-sm leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--text-secondary)' }}>
                        {source.content || t('notebooks.no_content_preview', 'No content preview available.')}
                    </div>
                </div>

                {/* Footer */}
                <div className="px-5 py-3 border-t flex items-center justify-between" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-secondary)' }}>
                    <span className="text-[10px] font-medium" style={{ color: 'var(--text-tertiary)' }}>
                        {t('notebooks.source_number', { index: source.index })}
                    </span>
                    <button
                        onClick={onClose}
                        className="px-3 py-1 text-xs font-medium rounded-lg transition-colors hover:bg-[var(--bg-tertiary)]"
                        style={{ color: 'var(--text-secondary)' }}
                    >
                        {t('notebooks.close', 'Close')}
                    </button>
                </div>
            </div>
        </Modal>
    );
}
