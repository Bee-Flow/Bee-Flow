/**
 * Rich pre-send DLP review: the message rendered in its own chat-bubble
 * shell with detected PII highlighted inline (category + color, never a raw
 * score), plus the ability to select any other text and mark it as personal
 * data the detector missed before confirming.
 */
import { ShieldAlert, X, Send, Eye, Lock } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import DlpChatTextRenderer from './DlpChatTextRenderer';
import DlpDocumentRenderer from './DlpDocumentRenderer';
import { mergeSpans, nextManualId } from './dlpFindingsState';
import DlpFindingsSummaryBar from './DlpFindingsSummaryBar';
import { useTranslation } from '../../../hooks/useTranslation';
import Modal from '../../shared/Modal';

// A decision, not a notice: the server holds the message until Block, Send or
// Redact answers, so neither Escape nor a press beside the dialog may dismiss
// it without one. Modal is here for the focus trap and the labelling.
const NO_DISMISS = () => {};

export default function DlpReviewShell({ pending, onSubmit, submitting, error }) {
    const { t } = useTranslation();
    const [remember, setRemember] = useState(false);
    const [manualSpans, setManualSpans] = useState([]);

    const spans = useMemo(() => mergeSpans(pending.findings, manualSpans), [pending.findings, manualSpans]);

    const addSpan = (span) => setManualSpans(prev => [...prev, { ...span, id: nextManualId() }]);
    const removeSpan = (id) => setManualSpans(prev => prev.filter(s => s.id !== id));

    const provider = pending.provider || {};
    const providerLabel = provider.displayName || 'external provider';
    const isAttachment = pending.kind === 'attachment';

    const submitRedact = () => onSubmit('redact', {
        rememberForConversation: remember,
        manualAdditions: manualSpans.map(({ offset, length }) => ({ offset, length })),
    });

    return (
        <Modal
            open
            onClose={NO_DISMISS}
            disableBackdropClose
            disableEscapeClose
            variant="bare"
            size="auto"
            zIndex={1000}
            labelledBy="dlp-review-title"
            className="max-w-xl"
        >
            <div
                className="w-full rounded-2xl border shadow-2xl overflow-hidden flex flex-col"
                style={{ background: 'var(--bg-card)', borderColor: 'var(--border-default)', maxHeight: '85vh', animation: 'overlayContentIn .2s ease-out' }}
            >
                {/* Header */}
                <div className="px-5 py-4 border-b flex items-start gap-3 shrink-0" style={{ borderColor: 'var(--border-subtle)' }}>
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: 'rgba(234, 88, 12, 0.12)' }}>
                        <ShieldAlert className="w-5 h-5" style={{ color: '#ea580c' }} />
                    </div>
                    <div className="flex-1 min-w-0">
                        <h3 id="dlp-review-title" className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                            {isAttachment
                                ? t('dlp.review_title_attachment', 'Check this attachment before it goes to the AI')
                                : t('dlp.review_title', 'Check this before it goes to the AI')}
                        </h3>
                        <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                            {t('dlp.preview_subtitle', 'This prompt will be sent to')}{' '}
                            <strong style={{ color: 'var(--text-primary)' }}>{providerLabel}</strong>
                            {provider.isExternal !== false && (
                                <span className="ml-1 inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(234, 88, 12, 0.12)', color: '#ea580c' }}>
                                    <Lock className="w-2.5 h-2.5" />
                                    {t('dlp.external_badge', 'external')}
                                </span>
                            )}
                        </p>
                    </div>
                </div>

                {/* Reviewed content */}
                <div className="px-5 py-4 overflow-y-auto custom-scrollbar space-y-3">
                    <DlpFindingsSummaryBar spans={spans} />
                    {isAttachment
                        ? <DlpDocumentRenderer filename={pending.filename} text={pending.reviewText} spans={spans} onAddSpan={addSpan} onRemoveSpan={removeSpan} />
                        : <DlpChatTextRenderer text={pending.reviewText} spans={spans} onAddSpan={addSpan} onRemoveSpan={removeSpan} />}
                    <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        {t('dlp.select_text_hint', 'Tip: select text above to mark something the detector missed.')}
                    </p>

                    <label className="flex items-center gap-2 text-xs cursor-pointer select-none" style={{ color: 'var(--text-secondary)' }}>
                        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="rounded" />
                        {t('dlp.remember_label', 'Remember my choice for this conversation')}
                    </label>

                    {error && (
                        <div className="text-xs px-3 py-2 rounded-lg" style={{ background: 'rgba(239, 68, 68, 0.1)', color: '#dc2626' }}>
                            {error}
                        </div>
                    )}
                </div>

                {/* Actions */}
                <div className="px-5 py-3 border-t flex items-center gap-2 justify-end shrink-0" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-secondary)' }}>
                    <button
                        onClick={() => onSubmit('block')}
                        disabled={submitting}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
                        style={{ color: '#dc2626', background: 'rgba(239, 68, 68, 0.08)' }}
                    >
                        <X className="w-3.5 h-3.5" />
                        {t('dlp.action_block', 'Block')}
                    </button>
                    <button
                        onClick={() => onSubmit('allow', { rememberForConversation: remember })}
                        disabled={submitting}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
                        style={{ color: 'var(--text-secondary)', background: 'var(--bg-tertiary)' }}
                        title={t('dlp.action_allow_tooltip', 'Send the prompt unchanged')}
                    >
                        <Send className="w-3.5 h-3.5" />
                        {t('dlp.action_allow', 'Send anyway')}
                    </button>
                    <button
                        onClick={submitRedact}
                        disabled={submitting}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white transition-colors disabled:opacity-50"
                        style={{ background: 'var(--accent-primary)' }}
                    >
                        <Eye className="w-3.5 h-3.5" />
                        {spans.length > 0 ? t('dlp.action_redact', 'Redact and send') : t('dlp.action_confirm_send', 'Send')}
                    </button>
                </div>
            </div>
        </Modal>
    );
}
