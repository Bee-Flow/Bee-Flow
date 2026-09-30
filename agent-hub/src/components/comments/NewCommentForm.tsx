// Starting a thread: the passage that was selected when "Add comment" was
// pressed (or "the whole item" when nothing was), the first comment, and how
// the AI takes part. A refused send keeps the text and the passage; a resend
// uses the same client id, so a thread that did land is not created twice.

import React, { useState } from 'react';
import {
    newCommentClientId, useCreateCommentThread,
    type CommentAiMode, type CommentAiPolicy, type CommentAiResult, type CommentAnchor, type CommentTarget, type CommentThread,
} from '../../api/queries/comments';
import { useTranslation } from '../../hooks/useTranslation';
import type { MentionCandidate } from '../projects/workspace/chat/mentions';
import { SELECT_CLASS } from '../projects/workspace/workspaceUi';
import AnchorQuote from './AnchorQuote';
import CommentComposer, { type CommentDraft } from './CommentComposer';
import { commentErrorText } from './commentErrors';
import { AI_MODES, aiModeAllowed, aiModeOption } from './commentLabels';

export default function NewCommentForm({ target, anchor, candidates, aiPolicy = null, onCreated, onCancel }: {
    target: CommentTarget;
    anchor: CommentAnchor | null;
    candidates: MentionCandidate[];
    /** What the organisation allows; null while unknown (the server still checks). */
    aiPolicy?: CommentAiPolicy | null;
    /** The thread landed; `ai` is what the server said about answering it, `askedAi` whether the author asked. */
    onCreated: (thread: CommentThread, ai: CommentAiResult, askedAi: boolean) => void;
    onCancel: () => void;
}) {
    const { t } = useTranslation();
    const create = useCreateCommentThread(target);
    const [clientThreadId] = useState(newCommentClientId);
    const [aiMode, setAiMode] = useState<CommentAiMode>('mention');
    const [error, setError] = useState<string | null>(null);

    const submit = async (draft: CommentDraft): Promise<boolean> => {
        setError(null);
        try {
            const { thread, ai } = await create.mutateAsync({ clientThreadId, anchor, ...draft, ...(aiMode !== 'mention' ? { aiMode } : {}) });
            onCreated(thread, ai, draft.askAi);
            return true;
        } catch (e) {
            setError(commentErrorText(t, e, t('comments.error_create', 'Could not add the comment. Your text is still here.')));
            return false;
        }
    };

    return (
        <section className="rounded-xl border border-[var(--accent-primary)] bg-[var(--bg-card)] px-3 py-2.5 flex flex-col gap-2"
            aria-label={t('comments.new_label', 'New comment')} data-testid="comment-new-form">
            <AnchorQuote anchor={anchor} state={anchor ? 'found' : 'whole'} targetType={target.targetType} />
            <CommentComposer
                candidates={candidates}
                label={t('comments.new_label', 'New comment')}
                placeholder={t('comments.new_placeholder', 'Add a comment… Type @ to mention someone or the AI.')}
                submitLabel={t('comments.comment', 'Comment')}
                aiEnabled={aiMode !== 'off'}
                busy={create.isPending}
                error={error}
                autoFocus
                onSubmit={submit}
                onCancel={onCancel}
                testId="comment-new-composer"
            />
            <label className="flex items-center gap-2 text-[12px] text-[var(--text-secondary)]">
                {t('comments.ai_mode_label', 'When the AI answers in this thread')}
                <select value={aiMode} onChange={e => setAiMode(e.target.value as CommentAiMode)} className={`${SELECT_CLASS} h-7 text-[12px]`}>
                    {AI_MODES.map((mode) => {
                        const allowed = aiModeAllowed(mode, null, aiPolicy);
                        return <option key={mode} value={mode} disabled={!allowed}>{aiModeOption(mode, allowed, t)}</option>;
                    })}
                </select>
            </label>
        </section>
    );
}
