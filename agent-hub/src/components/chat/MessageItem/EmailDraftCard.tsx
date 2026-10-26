import React, { type Dispatch, type SetStateAction } from 'react';
import { Mail, Send, Loader, FileText, X, ExternalLink } from 'lucide-react';
import { API_BASE, authFetch } from '@/utils/helpers';
import type { DraftStatusMap } from '@/hooks/useDraftAction';
import useTranslation from '@/hooks/useTranslation';
import { errorMessage } from '@/utils/caughtError';
import { logger } from '@/utils/logger';

interface EmailDraft {
    to?: string;
    cc?: string;
    bcc?: string;
    subject?: string;
    body?: string;
    status?: string;
    _provider?: string;
    replyToMessageId?: string;
    [key: string]: unknown;
}

interface EmailDraftCardProps {
    msg: { emailDrafts?: EmailDraft[] };
    emailDraftStatuses: DraftStatusMap;
    setEmailDraftStatuses: Dispatch<SetStateAction<DraftStatusMap>>;
}

export default function EmailDraftCard({ msg, emailDraftStatuses, setEmailDraftStatuses }: EmailDraftCardProps) {
    const { t } = useTranslation();
    if (!msg.emailDrafts || msg.emailDrafts.length === 0) return null;

    const handleSendEmail = async (draft: EmailDraft, index: number) => {
        setEmailDraftStatuses((prev: DraftStatusMap) => ({ ...prev, [index]: 'sending' }));
        try {
            const endpoint = draft._provider === 'microsoft' ? 'outlook' : 'gmail';
            const res = await authFetch(`${API_BASE}/api/integrations/${endpoint}/send`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(draft),
            });
            if (res.ok) {
                setEmailDraftStatuses((prev: DraftStatusMap) => ({ ...prev, [index]: 'sent' }));
            } else {
                let errorMsg = `HTTP ${res.status}`;
                try {
                    const err = await res.json();
                    errorMsg = err.error || errorMsg;
                } catch (err) { logger.debug('error body is not JSON, keep the HTTP status', err); }
                setEmailDraftStatuses((prev: DraftStatusMap) => ({ ...prev, [index]: `failed: ${errorMsg}` }));
            }
        } catch (err) {
            setEmailDraftStatuses((prev: DraftStatusMap) => ({ ...prev, [index]: `failed: ${errorMessage(err)}` }));
        }
    };

    const handleSaveAsDraft = async (draft: EmailDraft, index: number) => {
        setEmailDraftStatuses((prev: DraftStatusMap) => ({ ...prev, [index]: 'saving_draft' }));
        try {
            const endpoint = draft._provider === 'microsoft' ? 'outlook' : 'gmail';
            const res = await authFetch(`${API_BASE}/api/integrations/${endpoint}/draft`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(draft),
            });
            if (res.ok) {
                const data = await res.json();
                setEmailDraftStatuses((prev: DraftStatusMap) => ({ ...prev, [index]: `draft_saved:${data.gmailLink || ''}` }));
            } else {
                let errorMsg = `HTTP ${res.status}`;
                try {
                    const err = await res.json();
                    errorMsg = err.error || errorMsg;
                } catch (err) { logger.debug('error body is not JSON, keep the HTTP status', err); }
                setEmailDraftStatuses((prev: DraftStatusMap) => ({ ...prev, [index]: `failed: ${errorMsg}` }));
            }
        } catch (err) {
            setEmailDraftStatuses((prev: DraftStatusMap) => ({ ...prev, [index]: `failed: ${errorMessage(err)}` }));
        }
    };

    const handleDiscard = (index: number) => {
        setEmailDraftStatuses((prev: DraftStatusMap) => ({ ...prev, [index]: 'discarded' }));
    };

    return msg.emailDrafts.map((draft: EmailDraft, i: number) => {
        const status = emailDraftStatuses[i] || draft.status || 'pending';
        const isDraftSaved = status.startsWith('draft_saved');
        const isResolved = status === 'sent' || status === 'discarded' || isDraftSaved || status.startsWith('failed');
        const gmailLink = isDraftSaved ? status.split('draft_saved:')[1] : '';
        const isOutlook = draft._provider === 'microsoft';

        return (
            <div key={i} className={`my-3 rounded-xl border overflow-hidden transition-all duration-300 ${status === 'sent' ? 'border-green-500/40 bg-green-500/5'
                : isDraftSaved ? 'border-blue-500/40 bg-blue-500/5'
                    : status === 'discarded' ? 'border-[var(--border-subtle)] bg-[var(--bg-tertiary)] opacity-50'
                        : status.startsWith('failed') ? 'border-red-500/40 bg-red-500/5'
                            : 'border-blue-500/30 bg-blue-500/5'
                }`}>
                {/* Header */}
                <div className={`flex items-center gap-2 px-4 py-2.5 text-xs font-semibold uppercase tracking-wider ${status === 'sent' ? 'text-green-500'
                    : isDraftSaved ? 'text-blue-500'
                        : status === 'discarded' ? 'text-[var(--text-tertiary)]'
                            : status.startsWith('failed') ? 'text-red-500'
                                : 'text-blue-500'
                    }`}>
                    <Mail className="w-3.5 h-3.5" />
                    <span>{
                        status === 'sent' ? t('chat.draft.mail_sent', 'Email Sent ✓')
                            : isDraftSaved ? t('chat.draft.mail_saved', 'Saved to Drafts ✓')
                                : status === 'discarded' ? t('chat.draft.mail_discarded', 'Email Discarded')
                                    : status === 'sending' ? t('chat.draft.mail_sending', 'Sending...')
                                        : status === 'saving_draft' ? t('chat.draft.mail_saving', 'Saving Draft...')
                                            : status.startsWith('failed') ? t('chat.draft.mail_failed', 'Send Failed')
                                                : t(
                                                    draft.replyToMessageId ? 'chat.draft.mail_reply_pending' : 'chat.draft.mail_pending',
                                                    draft.replyToMessageId ? 'Reply Draft — Awaiting Approval' : 'Email Draft — Awaiting Approval',
                                                )
                    }</span>
                </div>

                {/* Email Content */}
                <div className="px-4 pb-3 space-y-2">
                    <div className="flex items-center gap-2 text-xs">
                        <span className="text-[var(--text-tertiary)] font-medium w-14">{t('chat.draft.mail_to', 'To:')}</span>
                        <span className="text-[var(--text-primary)]">{draft.to}</span>
                    </div>
                    {draft.cc && (
                        <div className="flex items-center gap-2 text-xs">
                            <span className="text-[var(--text-tertiary)] font-medium w-14">{t('chat.draft.mail_cc', 'Cc:')}</span>
                            <span className="text-[var(--text-primary)]">{draft.cc}</span>
                        </div>
                    )}
                    {draft.bcc && (
                        <div className="flex items-center gap-2 text-xs">
                            <span className="text-[var(--text-tertiary)] font-medium w-14">{t('chat.draft.mail_bcc', 'Bcc:')}</span>
                            <span className="text-[var(--text-primary)]">{draft.bcc}</span>
                        </div>
                    )}
                    <div className="flex items-center gap-2 text-xs">
                        <span className="text-[var(--text-tertiary)] font-medium w-14">{t('chat.draft.mail_subject', 'Subject:')}</span>
                        <span className="text-[var(--text-primary)] font-medium">{draft.subject}</span>
                    </div>
                    <div className="mt-2 p-3 rounded-lg bg-[var(--bg-primary)] border border-[var(--border-subtle)] text-sm text-[var(--text-secondary)] whitespace-pre-wrap max-h-[400px] overflow-y-auto custom-scrollbar">
                        {draft.body}
                    </div>
                </div>

                {/* Action Buttons */}
                {!isResolved && (
                    <div className="flex items-center gap-2 px-4 py-3 border-t border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
                        <button
                            onClick={() => handleSendEmail(draft, i)}
                            disabled={status === 'sending' || status === 'saving_draft'}
                            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold bg-green-600 hover:bg-green-500 text-white transition-colors disabled:opacity-50"
                        >
                            {status === 'sending' ? (
                                <><Loader className="w-3 h-3 animate-spin" /> {t('chat.draft.mail_sending', 'Sending...')}</>
                            ) : (
                                <><Send className="w-3 h-3" /> {t('chat.draft.mail_send', 'Send Email')}</>
                            )}
                        </button>
                        {/* No "Save as Draft" for Outlook: saving a draft needs
                            Mail.ReadWrite, which Bee Flow deliberately never
                            requests (Mail.Send covers sending), so Graph would
                            refuse it every time. */}
                        {!isOutlook && <button
                            onClick={() => handleSaveAsDraft(draft, i)}
                            disabled={status === 'sending' || status === 'saving_draft'}
                            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-50"
                        >
                            {status === 'saving_draft' ? (
                                <><Loader className="w-3 h-3 animate-spin" /> {t('chat.draft.saving', 'Saving...')}</>
                            ) : (
                                <><FileText className="w-3 h-3" /> {t('chat.draft.mail_save_draft', 'Save as Draft')}</>
                            )}
                        </button>}
                        <button
                            onClick={() => handleDiscard(i)}
                            disabled={status === 'sending' || status === 'saving_draft'}
                            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-medium text-[var(--text-tertiary)] hover:text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                        >
                            <X className="w-3 h-3" /> {t('chat.draft.discard', 'Discard')}
                        </button>
                    </div>
                )}

                {/* Draft saved — open in Gmail link */}
                {isDraftSaved && gmailLink && (
                    <div className="px-4 py-2 text-xs text-blue-400 border-t border-blue-500/20 flex items-center gap-1.5">
                        <ExternalLink className="w-3 h-3" />
                        <a href={gmailLink} target="_blank" rel="noopener noreferrer" className="hover:underline">
                            {t('chat.draft.mail_open_in', 'Open draft in {provider} →', { provider: isOutlook ? 'Outlook' : 'Gmail' })}
                        </a>
                    </div>
                )}

                {/* Status messages */}
                {status.startsWith('failed') && (
                    <div className="px-4 py-2 text-xs text-red-400 border-t border-red-500/20">
                        {t('chat.draft.error', 'Error: {reason}', { reason: status.replace(/^failed: ?/, '') })}
                    </div>
                )}
            </div>
        );
    });
}
