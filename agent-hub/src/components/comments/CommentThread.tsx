// One comment thread as a card in the comments panel: the passage it is
// about, the comments (of a long thread the first and the latest, with "Show
// N earlier comments"), a quiet "AI is answering…" while an answer is being
// written (or a line saying why the AI did not answer the reader's ask),
// and — for editors — Reply, Resolve/Reopen, when the AI answers
// (off / on mention / decides by itself, where the organisation allows it)
// and Delete for whoever started it or the project owner. Viewers see the
// same card without the controls.

import { Check, RotateCcw, Sparkles, Trash2 } from 'lucide-react';
import React, { useState } from 'react';
import {
    newCommentClientId, shownThread, useCommentFeedback, useDeleteComment, useDeleteCommentThread, useEditComment,
    useFullCommentThread, useReplyToThread, useSetThreadAiMode, useSetThreadStatus,
    type CommentAiMode, type CommentAiPolicy, type CommentAiResult, type CommentTarget, type CommentThread as Thread,
} from '../../api/queries/comments';
import { useTranslation } from '../../hooks/useTranslation';
import { formatMessageTime } from '../projects/workspace/chat/messageGroups';
import type { MentionCandidate } from '../projects/workspace/chat/mentions';
import { ErrorText, GhostButton, SELECT_CLASS } from '../projects/workspace/workspaceUi';
import AnchorQuote from './AnchorQuote';
import { aiNoteText, type CommentAiNote } from './commentAi';
import type { AnchorState } from './commentAnchors';
import CommentComposer, { type CommentDraft } from './CommentComposer';
import { commentErrorText } from './commentErrors';
import CommentItem from './CommentItem';
import InlineConfirm from './InlineConfirm';
import { AI_MODES, aiModeAllowed, aiModeLabel, aiModeOption } from './commentLabels';

export interface CommentThreadProps {
    thread: Thread;
    target: CommentTarget;
    state: AnchorState;
    active: boolean;
    canComment: boolean;
    isOwner: boolean;
    currentUserId: string | null;
    nameOf: (userId: string | null | undefined) => string;
    candidates: MentionCandidate[];
    mentionTokens: string[];
    aiRunning: boolean;
    /** Why the AI did not answer the reader's last ask here (limit, busy, blocked, …), or null. */
    aiNote?: CommentAiNote | null;
    /** What the server said about answering the reader's reply; `afterSeq` is the reply's seq. */
    onAiResult?: (ai: CommentAiResult, askedAi: boolean, afterSeq: number | null) => void;
    /** What the organisation lets a thread choose; null while unknown (the server still checks). */
    aiPolicy?: CommentAiPolicy | null;
    /** Mark this thread as the one being read (its passage is highlighted stronger). */
    onActivate: () => void;
    /** Scroll the item to the passage. */
    onJump: () => void;
}

function ThreadControls({ thread, target, canDelete, aiPolicy, onError }: {
    thread: Thread; target: CommentTarget; canDelete: boolean; aiPolicy: CommentAiPolicy | null; onError: (e: unknown, fallback: string) => void;
}) {
    const { t } = useTranslation();
    const status = useSetThreadStatus(target);
    const aiMode = useSetThreadAiMode(target);
    const remove = useDeleteCommentThread(target);
    const [confirming, setConfirming] = useState(false);
    const resolved = thread.status === 'resolved';
    const toggle = () => status.mutate({ threadId: thread.id, status: resolved ? 'open' : 'resolved' }, {
        onError: e => onError(e, resolved ? t('comments.error_reopen', 'Could not reopen the thread.') : t('comments.error_resolve', 'Could not resolve the thread.')),
    });
    if (confirming) {
        return (
            <InlineConfirm question={t('comments.delete_thread_confirm', 'Delete this whole thread?')} busy={remove.isPending}
                onCancel={() => setConfirming(false)}
                onConfirm={() => remove.mutate(thread.id, {
                    onError: e => { setConfirming(false); onError(e, t('comments.error_delete_thread', 'Could not delete the thread.')); },
                })} />
        );
    }
    return (
        <div className="flex items-center gap-1 flex-wrap">
            <GhostButton onClick={toggle} disabled={status.isPending} data-testid="comment-thread-toggle">
                {resolved ? <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" /> : <Check className="w-3.5 h-3.5" aria-hidden="true" />}
                {resolved ? t('comments.reopen', 'Reopen') : t('comments.resolve', 'Resolve')}
            </GhostButton>
            <label className="inline-flex items-center gap-1 ml-auto">
                <Sparkles className="w-3.5 h-3.5 text-[var(--text-tertiary)]" aria-hidden="true" />
                <span className="sr-only">{t('comments.ai_mode_label', 'When the AI answers in this thread')}</span>
                <select value={thread.aiMode} className={`${SELECT_CLASS} h-7 text-[12px]`} disabled={aiMode.isPending}
                    onChange={e => aiMode.mutate({ threadId: thread.id, aiMode: e.target.value as CommentAiMode }, {
                        onError: err => onError(err, t('comments.error_ai_mode', 'Could not change when the AI answers.')),
                    })}>
                    {AI_MODES.map((mode) => {
                        const allowed = aiModeAllowed(mode, thread.aiMode, aiPolicy);
                        return <option key={mode} value={mode} disabled={!allowed}>{aiModeOption(mode, allowed, t)}</option>;
                    })}
                </select>
            </label>
            {canDelete && (
                <GhostButton onClick={() => setConfirming(true)} aria-label={t('comments.delete_thread', 'Delete thread')} title={t('comments.delete_thread', 'Delete thread')}>
                    <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                </GhostButton>
            )}
        </div>
    );
}

type ShowError = (e: unknown, fallback: string) => void;

/**
 * The comments a long thread shows: the list holds its first and latest
 * ones; "Show earlier" reads the whole thread a page at a time, merged with
 * the list (which stays live for new replies and the reader's own changes).
 * The button stays while anything is still left out: a thread longer than one
 * page used to lose its middle and read as complete.
 */
function useShownComments(target: CommentTarget, thread: Thread) {
    const [wanted, setWanted] = useState(false);
    const whole = useFullCommentThread(target, thread.id, wanted && (thread.omittedComments || 0) > 0);
    const shown = shownThread(thread, wanted ? whole.data?.pages : undefined);
    const showEarlier = () => {
        if (!wanted) setWanted(true);
        else if (whole.isError && !whole.data) void whole.refetch();
        else void whole.fetchNextPage();
    };
    return { ...shown, busy: wanted && whole.isFetching, failed: wanted && whole.isError, showEarlier };
}

function EarlierComments({ count, busy, failed, onShow }: { count: number; busy: boolean; failed: boolean; onShow: () => void }) {
    const { t } = useTranslation();
    return (
        <li className="list-none flex flex-col gap-1" data-testid="comment-earlier">
            <GhostButton onClick={onShow} disabled={busy}>
                {t('comments.show_earlier', 'Show {count} earlier comments', { count })}
            </GhostButton>
            {failed && <ErrorText>{t('comments.earlier_failed', 'Could not load the earlier comments. Try again.')}</ErrorText>}
        </li>
    );
}

/** The comments of a thread, with the author's own Edit and Delete. */
function ThreadComments({ props, showError }: { props: CommentThreadProps; showError: ShowError }) {
    const { t } = useTranslation();
    const { thread, target } = props;
    const shown = useShownComments(target, thread);
    const edit = useEditComment(target);
    const remove = useDeleteComment(target);
    const feedback = useCommentFeedback(target);
    const [editError, setEditError] = useState<string | null>(null);

    const saveEdit = (commentId: string) => async (draft: CommentDraft): Promise<boolean> => {
        setEditError(null);
        try {
            await edit.mutateAsync({ threadId: thread.id, commentId, content: draft.content, mentions: draft.mentions });
            return true;
        } catch (e) {
            setEditError(commentErrorText(t, e, t('comments.error_edit', 'Could not save the change. Your text is still here.')));
            return false;
        }
    };

    const item = (c: Thread['comments'][number]) => {
        const mine = c.authorKind === 'user' && !!props.currentUserId && c.authorUserId === props.currentUserId;
        return (
            <CommentItem
                comment={c}
                authorName={props.nameOf(c.authorUserId)}
                candidates={props.candidates}
                mentionTokens={props.mentionTokens}
                canEdit={props.canComment && mine}
                canDelete={props.canComment && (mine || props.isOwner)}
                busy={edit.isPending || remove.isPending}
                editError={editError}
                onEdit={saveEdit(c.id)}
                onDelete={() => remove.mutate({ threadId: thread.id, commentId: c.id }, {
                    onError: e => showError(e, t('comments.error_delete', 'Could not delete the comment.')),
                })}
                onFeedback={props.canComment ? (helpful) => feedback.mutate({ threadId: thread.id, commentId: c.id, helpful }, {
                    onError: e => showError(e, t('comments.error_feedback', 'Could not save the feedback.')),
                }) : undefined}
            />
        );
    };

    // Where the left-out comments are: after the first one, or before all of a page of the latest.
    const earlier = shown.omitted > 0
        ? <EarlierComments count={shown.omitted} busy={shown.busy} failed={shown.failed} onShow={shown.showEarlier} />
        : null;
    return (
        <ul className="m-0 p-0 flex flex-col gap-2.5">
            {shown.comments.map((c, i) => (
                <React.Fragment key={c.id}>
                    {i === shown.gapAt && earlier}
                    {item(c)}
                </React.Fragment>
            ))}
            {shown.gapAt >= shown.comments.length && earlier}
        </ul>
    );
}

/** Reply (and, while not replying, the thread's controls) for editors. */
function ReplyArea({ props, error, setError, showError }: {
    props: CommentThreadProps; error: string | null; setError: (e: string | null) => void; showError: ShowError;
}) {
    const { t } = useTranslation();
    const { thread, target } = props;
    const reply = useReplyToThread(target);
    const [replying, setReplying] = useState(false);
    const [clientMsgId, setClientMsgId] = useState(newCommentClientId);

    const sendReply = async (draft: CommentDraft): Promise<boolean> => {
        setError(null);
        try {
            const sent = await reply.mutateAsync({ threadId: thread.id, clientMsgId, ...draft });
            props.onAiResult?.(sent.ai, draft.askAi, sent.comment.seq);
            setClientMsgId(newCommentClientId());
            setReplying(false);
            return true;
        } catch (e) {
            // The same id on a resend: a reply that did land is not stored twice.
            showError(e, t('comments.error_reply', 'Could not send the reply. Your text is still here.'));
            return false;
        }
    };

    if (replying) {
        return (
            <CommentComposer
                candidates={props.candidates}
                label={t('comments.reply_label', 'Reply')}
                placeholder={thread.status === 'resolved'
                    ? t('comments.reply_reopens', 'Reply to reopen this thread…')
                    : t('comments.reply_placeholder', 'Reply… Type @ to mention someone or the AI.')}
                submitLabel={t('comments.reply', 'Reply')}
                aiEnabled={thread.aiMode !== 'off'}
                busy={reply.isPending}
                error={error}
                autoFocus
                onSubmit={sendReply}
                onCancel={() => { setReplying(false); setError(null); }}
                testId="comment-reply-composer"
            />
        );
    }
    return (
        <>
            <ErrorText>{error}</ErrorText>
            <div className="flex items-center gap-1 flex-wrap border-t border-[var(--border-subtle)] pt-2">
                <GhostButton onClick={() => { setError(null); setReplying(true); }} data-testid="comment-reply-open">{t('comments.reply', 'Reply')}</GhostButton>
                <div className="flex-1 min-w-0">
                    <ThreadControls thread={thread} target={target} onError={showError} aiPolicy={props.aiPolicy ?? null}
                        canDelete={props.isOwner || (!!props.currentUserId && thread.createdBy === props.currentUserId)} />
                </div>
            </div>
        </>
    );
}

export default function CommentThread(props: CommentThreadProps) {
    const { t, locale } = useTranslation();
    const { thread } = props;
    const [error, setError] = useState<string | null>(null);
    const showError: ShowError = (e, fallback) => setError(commentErrorText(t, e, fallback));

    return (
        <article
            data-testid={`comment-thread-${thread.id}`}
            aria-label={t('comments.thread_label', 'Comment thread')}
            onFocus={props.onActivate}
            onMouseEnter={props.onActivate}
            className={`rounded-xl border px-3 py-2.5 flex flex-col gap-2 bg-[var(--bg-card)] transition-colors ${props.active
                ? 'border-[var(--accent-primary)] shadow-sm' : 'border-[var(--border-subtle)] hover:border-[var(--border-default)]'} ${thread.status === 'resolved' ? 'opacity-80' : ''}`}
        >
            <AnchorQuote anchor={thread.anchor} state={props.state} targetType={thread.targetType} onJump={props.onJump} />
            <ThreadComments props={props} showError={showError} />
            {thread.aiMode === 'auto' && thread.autoPausedUntil && Date.parse(thread.autoPausedUntil) > Date.now() && (
                <p className="m-0 text-[11px] text-[var(--text-tertiary)]" data-testid="comment-ai-paused">
                    {t('comments.ai_paused', 'After feedback, the AI will not join this thread on its own until {time}. Mention @ai to ask it.', {
                        time: formatMessageTime(thread.autoPausedUntil, locale),
                    })}
                </p>
            )}
            {props.aiRunning && (
                <p className="m-0 flex items-center gap-1.5 text-[12px] text-[var(--text-tertiary)]" role="status" data-testid="comment-ai-running">
                    <Sparkles className="w-3.5 h-3.5 animate-pulse text-[var(--accent-primary)]" aria-hidden="true" />
                    {t('comments.ai_answering', 'AI is answering…')}
                </p>
            )}
            {!props.aiRunning && props.aiNote && (
                <p className="m-0 flex items-center gap-1.5 text-[12px] text-[var(--text-tertiary)]" role="status" data-testid="comment-ai-note" data-note={props.aiNote}>
                    <Sparkles className="w-3.5 h-3.5 text-[var(--text-tertiary)]" aria-hidden="true" />
                    {aiNoteText(props.aiNote, t)}
                </p>
            )}
            {props.canComment
                ? <ReplyArea props={props} error={error} setError={setError} showError={showError} />
                : (
                    <>
                        <ErrorText>{error}</ErrorText>
                        {thread.aiMode !== 'mention' && <span className="text-[11px] text-[var(--text-tertiary)]">{aiModeLabel(thread.aiMode, t)}</span>}
                    </>
                )}
        </article>
    );
}
