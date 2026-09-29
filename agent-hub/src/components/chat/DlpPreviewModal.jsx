/**
 * DLP Preview Modal — shown when the server emits a `dlp_preview` event,
 * i.e. the user's prompt contains sensitive content AND the org's DLP mode
 * is 'ask'. Lets the user pick Redact / Block / Allow before the prompt
 * is sent to an external LLM.
 *
 * Mount point only. The rich review (content rendered with inline
 * highlights, category + color badges, manual "mark as personal data")
 * lives in dlpReview/DlpReviewShell — this file just decides which UI a
 * given payload supports. `pending.reviewText` is the feature-detect: it's
 * new, so its absence means an OLDER server sent the flat legacy shape
 * (deploy skew, old server / new client) and we fall back to the plain
 * grouped list rather than crash on missing offsets/text.
 */

import { ShieldAlert, Eye, X, Send, Lock } from 'lucide-react';
import React, { useMemo } from 'react';
import DlpReviewShell from './dlpReview/DlpReviewShell';
import useDlpDecision from '../../hooks/useDlpDecision';
import { useTranslation } from '../../hooks/useTranslation';
import Modal from '../shared/Modal';

// A decision, not a notice: the server holds the prompt until one of the three
// buttons answers, so neither Escape nor a press beside the dialog may make it
// go away without one. Modal is here for the focus trap and the labelling.
const NO_DISMISS = () => {};

function groupFindings(findings) {
    const map = new Map();
    for (const f of findings || []) {
        const key = f.label || f.category || 'Other';
        const entry = map.get(key) || { label: key, source: f.source, count: 0 };
        entry.count++;
        map.set(key, entry);
    }
    return [...map.values()].sort((a, b) => b.count - a.count);
}

function LegacyDlpPreview({ pending, submit, submitting, error }) {
    const { t } = useTranslation();
    const [remember, setRemember] = React.useState(false);
    const grouped = useMemo(() => groupFindings(pending?.findings), [pending]);
    const provider = pending.provider || {};
    const providerLabel = provider.displayName || 'external provider';

    return (
        <Modal
            open
            onClose={NO_DISMISS}
            disableBackdropClose
            disableEscapeClose
            variant="bare"
            size="auto"
            zIndex={1000}
            labelledBy="dlp-preview-title"
            className="max-w-lg"
        >
            <div
                className="w-full rounded-2xl border shadow-2xl overflow-hidden"
                style={{ background: 'var(--bg-card)', borderColor: 'var(--border-default)', animation: 'overlayContentIn .2s ease-out' }}
            >
                <div className="px-5 py-4 border-b flex items-start gap-3" style={{ borderColor: 'var(--border-subtle)' }}>
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: 'rgba(234, 88, 12, 0.12)' }}>
                        <ShieldAlert className="w-5 h-5" style={{ color: '#ea580c' }} />
                    </div>
                    <div className="flex-1 min-w-0">
                        <h3 id="dlp-preview-title" className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                            {t('dlp.preview_title', 'Sensitive content detected')}
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

                <div className="px-5 py-4">
                    <div className="text-xs font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
                        {t('dlp.findings_title', 'Detected items')}
                    </div>
                    <ul className="space-y-1.5">
                        {grouped.map(({ label, source, count }) => (
                            <li key={label} className="flex items-center justify-between text-sm px-3 py-2 rounded-lg" style={{ background: 'var(--bg-secondary)' }}>
                                <span className="flex items-center gap-2 min-w-0">
                                    <span className="text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wider font-medium shrink-0" style={{
                                        background: source === 'custom' ? 'rgba(139, 92, 246, 0.12)' : 'rgba(59, 130, 246, 0.12)',
                                        color: source === 'custom' ? '#8b5cf6' : '#3b82f6',
                                    }}>
                                        {source === 'custom' ? t('dlp.source_custom', 'custom') : t('dlp.source_pii', 'pii')}
                                    </span>
                                    <span className="truncate" style={{ color: 'var(--text-primary)' }}>{label}</span>
                                </span>
                                <span className="text-xs shrink-0 ml-2" style={{ color: 'var(--text-muted)' }}>×{count}</span>
                            </li>
                        ))}
                    </ul>

                    <label className="flex items-center gap-2 mt-4 text-xs cursor-pointer select-none" style={{ color: 'var(--text-secondary)' }}>
                        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="rounded" />
                        {t('dlp.remember_label', 'Remember my choice for this conversation')}
                    </label>

                    {error && (
                        <div className="mt-3 text-xs px-3 py-2 rounded-lg" style={{ background: 'rgba(239, 68, 68, 0.1)', color: '#dc2626' }}>
                            {error}
                        </div>
                    )}
                </div>

                <div className="px-5 py-3 border-t flex items-center gap-2 justify-end" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-secondary)' }}>
                    <button
                        onClick={() => submit('block')}
                        disabled={submitting}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
                        style={{ color: '#dc2626', background: 'rgba(239, 68, 68, 0.08)' }}
                    >
                        <X className="w-3.5 h-3.5" />
                        {t('dlp.action_block', 'Block')}
                    </button>
                    <button
                        onClick={() => submit('allow', { rememberForConversation: remember })}
                        disabled={submitting}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
                        style={{ color: 'var(--text-secondary)', background: 'var(--bg-tertiary)' }}
                        title={t('dlp.action_allow_tooltip', 'Send the prompt unchanged')}
                    >
                        <Send className="w-3.5 h-3.5" />
                        {t('dlp.action_allow', 'Send anyway')}
                    </button>
                    <button
                        onClick={() => submit('redact', { rememberForConversation: remember })}
                        disabled={submitting}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white transition-colors disabled:opacity-50"
                        style={{ background: 'var(--accent-primary)' }}
                    >
                        <Eye className="w-3.5 h-3.5" />
                        {t('dlp.action_redact', 'Redact and send')}
                    </button>
                </div>
            </div>
        </Modal>
    );
}

export default function DlpPreviewModal() {
    const { pending, submit, submitting, error } = useDlpDecision();
    if (!pending) return null;

    // reviewText is only present on the rich payload (this change) — its
    // absence means an older server build, not a message with empty text.
    if (typeof pending.reviewText === 'string') {
        return <DlpReviewShell pending={pending} onSubmit={submit} submitting={submitting} error={error} />;
    }
    return <LegacyDlpPreview pending={pending} submit={submit} submitting={submitting} error={error} />;
}
