// One comment in a thread: who wrote it and when, the text with its @mentions
// painted, and the author's own Edit and Delete. An AI answer carries an "AI"
// badge; one the AI wrote on its own says so and offers "Not helpful" (two of
// those pause the AI joining the thread by itself). Deleting asks once,
// inline: nothing pops over the document.

import { Pencil, Sparkles, ThumbsDown, Trash2 } from 'lucide-react';
import React, { useState } from 'react';
import type { ProjectComment } from '../../api/queries/comments';
import { useTranslation } from '../../hooks/useTranslation';
import { formatMessageTime } from '../projects/workspace/chat/messageGroups';
import { splitMentions, type MentionCandidate } from '../projects/workspace/chat/mentions';
import { Avatar, GhostButton } from '../projects/workspace/workspaceUi';
import CommentComposer, { type CommentDraft } from './CommentComposer';
import InlineConfirm from './InlineConfirm';

export interface CommentItemProps {
    comment: ProjectComment;
    authorName: string;
    candidates: MentionCandidate[];
    mentionTokens: string[];
    canEdit: boolean;
    canDelete: boolean;
    busy: boolean;
    onEdit: (draft: CommentDraft) => Promise<boolean>;
    onDelete: () => void;
    editError: string | null;
    /** "Not helpful" (false) or taking it back (true); absent when the reader may not give feedback. */
    onFeedback?: (helpful: boolean) => void;
}

function Body({ comment, tokens }: { comment: ProjectComment; tokens: string[] }) {
    const { t } = useTranslation();
    if (comment.deleted) {
        return <p className="m-0 text-[12.5px] italic text-[var(--text-tertiary)]">{t('comments.deleted', 'This comment was deleted.')}</p>;
    }
    if (comment.unreadable) {
        return <p className="m-0 text-[12.5px] italic text-[var(--text-tertiary)]">{t('comments.unreadable', 'This comment could not be read.')}</p>;
    }
    return (
        <p className="m-0 text-[13px] leading-relaxed text-[var(--text-primary)] whitespace-pre-wrap break-words">
            {splitMentions(comment.content, tokens).map((part, i) => (part.mention
                ? <span key={i} className="font-medium text-[var(--accent-primary)]">{part.text}</span>
                : <React.Fragment key={i}>{part.text}</React.Fragment>))}
        </p>
    );
}

function CommentHeader({ comment, name }: { comment: ProjectComment; name: string }) {
    const { t, locale } = useTranslation();
    const isAi = comment.authorKind === 'assistant';
    const joinedByItself = isAi && typeof comment.aiTrigger === 'string' && comment.aiTrigger.startsWith('auto');
    return (
        <>
            <div className="flex items-baseline gap-1.5 flex-wrap text-[12px]">
                <span className="font-semibold text-[var(--text-primary)]">{name}</span>
                {isAi && (
                    <span className="px-1 rounded text-[10px] font-semibold uppercase tracking-wide bg-[var(--item-active-bg)] text-[var(--accent-primary)]">
                        {t('comments.ai_badge', 'AI')}
                    </span>
                )}
                <time dateTime={comment.createdAt} className="text-[11px] text-[var(--text-tertiary)]">{formatMessageTime(comment.createdAt, locale)}</time>
                {comment.editedAt && !comment.deleted && <span className="text-[11px] text-[var(--text-tertiary)]">{t('comments.edited', '(edited)')}</span>}
            </div>
            {joinedByItself && (
                <span className="text-[11px] text-[var(--text-tertiary)]" data-testid="comment-ai-joined">
                    {comment.aiTrigger === 'auto_unanswered'
                        ? t('comments.ai_joined_unanswered', 'Joined on its own: a question here had no answer yet.')
                        : t('comments.ai_joined', 'Joined on its own because it could help.')}
                </span>
            )}
        </>
    );
}

function CommentActions({ canEdit, canDelete, onEdit, onDelete }: { canEdit: boolean; canDelete: boolean; onEdit: () => void; onDelete: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center gap-0.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 transition-opacity">
            {canEdit && (
                <GhostButton onClick={onEdit}><Pencil className="w-3 h-3" aria-hidden="true" />{t('comments.edit', 'Edit')}</GhostButton>
            )}
            {canDelete && (
                <GhostButton onClick={onDelete}><Trash2 className="w-3 h-3" aria-hidden="true" />{t('comments.delete', 'Delete')}</GhostButton>
            )}
        </div>
    );
}

const isAutomatic = (c: ProjectComment) => c.authorKind === 'assistant' && typeof c.aiTrigger === 'string' && c.aiTrigger.startsWith('auto');

function NotHelpful({ marked, onToggle }: { marked: boolean; onToggle: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center gap-1.5">
            <GhostButton onClick={onToggle} aria-pressed={marked} data-testid="comment-not-helpful"
                className={marked ? 'text-[var(--text-primary)]' : ''}>
                <ThumbsDown className="w-3 h-3" aria-hidden="true" />{t('comments.not_helpful', 'Not helpful')}
            </GhostButton>
            {marked && <span className="text-[11px] text-[var(--text-tertiary)]">{t('comments.not_helpful_noted', 'Thanks, noted.')}</span>}
        </div>
    );
}

function AuthorMark({ isAi, name }: { isAi: boolean; name: string }) {
    if (!isAi) return <Avatar name={name} size="sm" />;
    return (
        <span className="inline-grid place-items-center w-6 h-6 rounded-full flex-shrink-0 bg-[var(--item-active-bg)] text-[var(--accent-primary)]" aria-hidden="true">
            <Sparkles className="w-3.5 h-3.5" />
        </span>
    );
}

export default function CommentItem(props: CommentItemProps) {
    const { t } = useTranslation();
    const { comment } = props;
    const [mode, setMode] = useState<'read' | 'edit' | 'confirm'>('read');
    const isAi = comment.authorKind === 'assistant';
    const name = isAi ? t('comments.ai_name', 'AI assistant') : (props.authorName || t('comments.someone', 'A project member'));
    const actionable = !comment.deleted && !comment.unreadable && (props.canEdit || props.canDelete);

    return (
        <li className="group flex gap-2 list-none" data-testid={`comment-${comment.id}`}>
            <AuthorMark isAi={isAi} name={name} />
            <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                <CommentHeader comment={comment} name={name} />
                {mode === 'edit' ? (
                    <CommentComposer
                        candidates={props.candidates}
                        label={t('comments.edit_label', 'Edit comment')}
                        placeholder=""
                        submitLabel={t('comments.save', 'Save')}
                        aiEnabled={false}
                        busy={props.busy}
                        error={props.editError}
                        initialText={comment.content}
                        initialMentions={comment.mentions}
                        autoFocus
                        onSubmit={async (draft) => {
                            const ok = await props.onEdit(draft);
                            if (ok) setMode('read');
                            return ok;
                        }}
                        onCancel={() => setMode('read')}
                    />
                ) : <Body comment={comment} tokens={props.mentionTokens} />}
                {mode === 'confirm' && (
                    <InlineConfirm question={t('comments.delete_confirm', 'Delete this comment?')} busy={props.busy}
                        onConfirm={() => { setMode('read'); props.onDelete(); }} onCancel={() => setMode('read')} />
                )}
                {mode === 'read' && actionable && (
                    <CommentActions canEdit={props.canEdit} canDelete={props.canDelete} onEdit={() => setMode('edit')} onDelete={() => setMode('confirm')} />
                )}
                {props.onFeedback && isAutomatic(comment) && !comment.deleted && (
                    <NotHelpful marked={comment.feedback === false} onToggle={() => props.onFeedback?.(comment.feedback === false)} />
                )}
            </div>
        </li>
    );
}
