// The small line under an answer the AI gave on its own: why it joined, and a
// one-click "Not helpful" for members who can post. The feedback is quiet on
// purpose — a word of thanks in place of the button, no toast — and two of
// them in a day make the AI hold back in this chat for a day.

import { ThumbsDown } from 'lucide-react';
import React, { useState } from 'react';
import type { TeamChatMessage } from '../../../../api/queries/projectChats';
import { useTranslation, type TranslateFn } from '../../../../hooks/useTranslation';

/** The reason code in the reader's words, as "Joined because <reason>" finishes it. */
export function joinReasonText(reason: string | null | undefined, t: TranslateFn): string {
    switch (reason) {
        case 'direct_request': return t('project_participation.reason_direct_request', 'someone asked for its help');
        case 'open_question_answerable': return t('project_participation.reason_open_question_answerable', 'a question came up that it could answer');
        case 'unanswered_question': return t('project_participation.reason_unanswered_question', 'a question had gone unanswered');
        case 'summary_or_next_steps_requested': return t('project_participation.reason_summary_or_next_steps_requested', 'someone asked for a summary or next steps');
        case 'factual_error_worth_flagging': return t('project_participation.reason_factual_error_worth_flagging', 'something looked factually wrong');
        default: return t('project_participation.reason_other', 'it could help here');
    }
}

export default function AutoAnswerNote({ message, canGiveFeedback, onNotHelpful }: {
    message: TeamChatMessage;
    canGiveFeedback: boolean;
    onNotHelpful: (message: TeamChatMessage) => Promise<void>;
}) {
    const { t } = useTranslation();
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState(false);
    const given = message.myFeedback === 'not_helpful';
    const send = async () => {
        setBusy(true);
        setFailed(false);
        try { await onNotHelpful(message); } catch { setFailed(true); } finally { setBusy(false); }
    };
    return (
        <div className="mt-1 flex items-center gap-2 flex-wrap text-[11.5px] text-[var(--text-tertiary)]" data-testid={`team-chat-auto-note-${message.id}`}>
            <span>{t('project_participation.joined_because', 'Joined because {reason}', { reason: joinReasonText(message.aiReason, t) })}</span>
            {canGiveFeedback && !given && (
                <button type="button" onClick={send} disabled={busy}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)] disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)]"
                    title={t('project_participation.not_helpful_hint', 'Tell the AI to hold back in this chat')}>
                    <ThumbsDown className="w-3 h-3" aria-hidden="true" />
                    {t('project_participation.not_helpful', 'Not helpful')}
                </button>
            )}
            {given && <span role="status">{t('project_participation.feedback_thanks', 'Thanks. The AI will hold back more here.')}</span>}
            {failed && <span role="alert" className="text-[var(--error-ink)]">{t('project_participation.feedback_failed', 'Could not send your feedback. Try again.')}</span>}
        </div>
    );
}
