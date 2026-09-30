// One message inside a team chat group: its text (plain with painted
// @mentions for people, markdown for the AI), a reply preview, the edited and
// deleted states, the hover actions, and — for a message not confirmed yet —
// "sending" or "not sent" with retry and discard.

import { BookOpen, CheckSquare, CornerUpLeft, FileText, MessageSquareReply, Mic, Pencil, RotateCcw, Trash2, X } from 'lucide-react';
import React, { useState } from 'react';
import { isAutomaticAnswer, type PendingTeamChatMessage, type TeamChatMessage, type TeamChatRef } from '../../../../api/queries/projectChats';
import { useTranslation } from '../../../../hooks/useTranslation';
import MarkdownRenderer from '../../../renderers/MarkdownRenderer';
import { projectErrorText } from '../projectErrorText';
import { ErrorText, GhostButton, PrimaryButton, SecondaryButton } from '../workspaceUi';
import AnswerTrace from './AnswerTrace';
import AutoAnswerNote from './AutoAnswerNote';
import { washOf } from '../memberColors';
import { AI_TONE, type AiTone } from '../projectVisuals';
import { isImeEnter } from './ime';
import { excerptOf, formatMessageTime, type ChatItem, type ThreadSummary } from './messageGroups';
import { splitMentions } from './mentions';

/** What a bubble needs from the chat around it. */
export interface MessageContext {
    currentUserId: string | null;
    isProjectOwner: boolean;
    canPost: boolean;
    /** A display name for a user id, never empty. */
    nameOf: (userId: string | null | undefined) => string;
    /** The colour a person has in this project (theirs, or one from their name). */
    colorOf?: (userId: string | null | undefined) => string;
    /** A user's own avatar, when they set one. */
    avatarOf?: (userId: string | null | undefined) => { type: 'emoji' | 'image' | 'url'; value: string } | undefined;
    /** The name of the AI that wrote a message. */
    assistantName: (agentId: string | null | undefined) => string;
    mentionTokens: string[];
    findMessage: (id: string) => TeamChatMessage | undefined;
    /** Quote-reply; absent where quoting makes no sense (inside a thread). */
    onReply?: (message: TeamChatMessage) => void;
    /** Make a task of this message; absent when the reader cannot make tasks. */
    onCreateTask?: (message: TeamChatMessage) => void;
    /** Opens the thread of a message; absent inside a thread itself. */
    onOpenThread?: (message: TeamChatMessage) => void;
    /** Replies in the thread of a message, when it has any. */
    threadOf?: (messageId: string) => ThreadSummary | undefined;
    /** The AI's colours here, from the project's colour. */
    aiTone?: AiTone;
    /** The project's own icon (an emoji), worn by the project's AI assistant; agents keep their own mark. */
    aiIcon?: string;
    /** Where an answer's trace is read from; absent hides the panel. */
    traceScope?: { projectId: string; chatId: string };
    /** The name of a tagged document or notebook. */
    refTitle?: (ref: TeamChatRef) => string;
    /** Opens a tagged document or notebook. */
    onOpenRef?: (ref: TeamChatRef) => void;
    onDelete: (message: TeamChatMessage) => void;
    onEdit: (message: TeamChatMessage, content: string) => Promise<void>;
    onRetry: (pending: PendingTeamChatMessage) => void;
    onDiscard: (pending: PendingTeamChatMessage) => void;
    /** "Not helpful" on an answer the AI gave on its own. */
    onNotHelpful: (message: TeamChatMessage) => Promise<void>;
    /** Opens the reader's own AI settings (the opt-out), when the page can navigate. */
    onShowAiSettings?: () => void;
}

const ACTION_CLASS = 'grid place-items-center w-7 h-7 rounded-md text-[var(--text-secondary)] '
    + 'hover:text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)] transition-colors';

function MentionText({ text, tokens }: { text: string; tokens: string[] }) {
    return (
        <p className="m-0 text-[13.5px] leading-relaxed text-[var(--text-primary)] whitespace-pre-wrap break-words">
            {splitMentions(text, tokens).map((part, i) => (part.mention
                ? <span key={i} className="px-1 rounded-md font-semibold text-[var(--text-primary)] bg-[color-mix(in_srgb,var(--accent-primary)_20%,transparent)]">{part.text}</span>
                : <React.Fragment key={i}>{part.text}</React.Fragment>))}
        </p>
    );
}

function ReplyPreview({ replyTo, ctx }: { replyTo: string; ctx: MessageContext }) {
    const { t } = useTranslation();
    const target = ctx.findMessage(replyTo);
    const who = target
        ? (target.authorKind === 'assistant' ? ctx.assistantName(target.agentId) : ctx.nameOf(target.authorUserId))
        : '';
    const text = !target
        ? t('project_chat.reply_earlier', 'Replying to an earlier message')
        : (target.deleted ? t('project_chat.message_deleted', 'This message was deleted.') : excerptOf(target.content));
    return (
        <div className="mb-1.5 flex items-center gap-1.5 text-[12px] text-[var(--text-secondary)] border-l-2 border-[color-mix(in_srgb,var(--accent-primary)_45%,var(--border-default))] bg-[color-mix(in_srgb,var(--text-primary)_4%,transparent)] rounded-r-md pl-2 pr-2 py-0.5 min-w-0">
            <CornerUpLeft className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
            {who && <span className="font-medium text-[var(--text-secondary)] flex-shrink-0">{who}</span>}
            <span className="truncate">{text}</span>
        </div>
    );
}

function RefChips({ refs, ctx }: { refs: TeamChatRef[]; ctx: MessageContext }) {
    const { t } = useTranslation();
    if (!refs.length) return null;
    return (
        <div className="mt-1 flex flex-wrap gap-1.5" data-testid="team-chat-refs">
            {refs.map((ref) => {
                const Icon = ref.kind === 'notebook' ? BookOpen : ref.kind === 'meeting' ? Mic : FileText;
                const title = ctx.refTitle?.(ref) || (ref.kind === 'notebook' ? t('project_chat.ref_notebook', 'Notebook') : ref.kind === 'meeting' ? t('project_chat.ref_meeting', 'Meeting') : t('project_chat.ref_document', 'Document'));
                return (
                    <button key={`${ref.kind}:${ref.id}`} type="button" onClick={() => ctx.onOpenRef?.(ref)} disabled={!ctx.onOpenRef}
                        title={t('project_chat.open_ref', 'Open {name}', { name: title })}
                        className="inline-flex items-center gap-1.5 max-w-full px-2 py-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[12px] text-[var(--text-primary)] hover:border-[var(--accent-primary)] transition-colors">
                        <Icon className="w-3.5 h-3.5 flex-shrink-0 text-[var(--accent-primary)]" aria-hidden="true" />
                        <span className="truncate">{title}</span>
                    </button>
                );
            })}
        </div>
    );
}

function ThreadFooter({ message, ctx }: { message: TeamChatMessage; ctx: MessageContext }) {
    const { t, locale } = useTranslation();
    const summary = ctx.threadOf?.(message.id);
    if (!summary || !ctx.onOpenThread) return null;
    return (
        <button type="button" onClick={() => ctx.onOpenThread!(message)} data-testid={`team-chat-thread-${message.id}`}
            className="mt-1 inline-flex items-center gap-1.5 px-1.5 py-0.5 -ml-1.5 rounded-md text-[12px] font-semibold text-[var(--text-primary)] hover:bg-[var(--item-active-bg)]">
            <MessageSquareReply className="w-3.5 h-3.5" aria-hidden="true" />
            {summary.count === 1
                ? t('project_chat.thread_one', '1 reply')
                : t('project_chat.thread_many', '{count} replies', { count: summary.count })}
            <span className="font-normal text-[var(--text-secondary)]">{formatMessageTime(summary.lastAt, locale)}</span>
        </button>
    );
}

function EditBox({ initial, onSave, onCancel }: { initial: string; onSave: (next: string) => Promise<void>; onCancel: () => void }) {
    const { t } = useTranslation();
    const [draft, setDraft] = useState(initial);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const save = async () => {
        const next = draft.trim();
        if (!next || next === initial.trim()) { onCancel(); return; }
        setBusy(true);
        setError('');
        try { await onSave(next); } catch (e) { setError(projectErrorText(t, e)); setBusy(false); }
    };
    return (
        <div className="flex flex-col gap-1.5">
            <textarea
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
                    else if (e.key === 'Enter' && !e.shiftKey && !isImeEnter(e)) { e.preventDefault(); save(); }
                }}
                aria-label={t('project_chat.edit_label', 'Edit message')}
                maxLength={20000}
                rows={Math.min(8, Math.max(2, draft.split('\n').length))}
                autoFocus
                className="w-full px-2.5 py-2 rounded-lg text-[13.5px] border border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)] resize-y focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)]"
            />
            <ErrorText>{error}</ErrorText>
            <div className="flex items-center gap-2">
                <PrimaryButton onClick={save} busy={busy}>{t('project_chat.save', 'Save')}</PrimaryButton>
                <SecondaryButton onClick={onCancel} disabled={busy}>{t('project_chat.cancel', 'Cancel')}</SecondaryButton>
            </div>
        </div>
    );
}

function Actions({ message, ctx, onEditStart }: { message: TeamChatMessage; ctx: MessageContext; onEditStart: () => void }) {
    const { t } = useTranslation();
    const mine = message.authorKind === 'user' && !!ctx.currentUserId && message.authorUserId === ctx.currentUserId;
    const canEdit = mine && ctx.canPost;
    // The server lets an editor delete their own message, and the owner any.
    const canDelete = (mine && ctx.canPost) || ctx.isProjectOwner;
    if (message.deleted || (!ctx.canPost && !canDelete)) return null;
    // Hidden by opacity only, never by display: the buttons stay in the tab
    // order, and a keyboard user who tabs onto one brings the bar into view
    // (focus-within), as does a tap on the message. Small screens have no
    // hover, so there the bar is simply shown, under the message instead of
    // over it.
    return (
        <div data-testid="team-chat-message-actions"
            className="flex w-fit ml-auto mt-1 md:mt-0 md:absolute md:-top-3 md:right-2 opacity-100 md:opacity-0 md:group-hover/msg:opacity-100 md:group-focus-within/msg:opacity-100 transition-opacity items-center gap-0.5 px-0.5 py-0.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] shadow-sm">
            {ctx.canPost && ctx.onOpenThread && (
                <button type="button" className={ACTION_CLASS} onClick={() => ctx.onOpenThread!(message)}
                    aria-label={t('project_chat.reply_in_thread', 'Reply in thread')} title={t('project_chat.reply_in_thread', 'Reply in thread')}>
                    <MessageSquareReply className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
            )}
            {ctx.canPost && ctx.onReply && (
                <button type="button" className={ACTION_CLASS} onClick={() => ctx.onReply!(message)}
                    aria-label={t('project_chat.reply', 'Reply')} title={t('project_chat.reply', 'Reply')}>
                    <CornerUpLeft className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
            )}
            {ctx.canPost && ctx.onCreateTask && message.authorKind !== 'system' && (
                <button type="button" className={ACTION_CLASS} onClick={() => ctx.onCreateTask!(message)}
                    aria-label={t('project_tasks.from_message', 'Make a task from this message')} title={t('project_tasks.from_message', 'Make a task from this message')}>
                    <CheckSquare className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
            )}
            {canEdit && (
                <button type="button" className={ACTION_CLASS} onClick={onEditStart}
                    aria-label={t('project_chat.edit', 'Edit')} title={t('project_chat.edit', 'Edit')}>
                    <Pencil className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
            )}
            {canDelete && (
                <button type="button" className={ACTION_CLASS} onClick={() => ctx.onDelete(message)}
                    aria-label={t('project_chat.delete_message', 'Delete message')} title={t('project_chat.delete_message', 'Delete message')}>
                    <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
            )}
        </div>
    );
}

function MessageBody({ message, ctx }: { message: TeamChatMessage; ctx: MessageContext }) {
    const { t } = useTranslation();
    if (message.deleted) {
        return <p className="m-0 text-[13px] italic text-[var(--text-secondary)]">{t('project_chat.message_deleted', 'This message was deleted.')}</p>;
    }
    if (message.unreadable) {
        return <p className="m-0 text-[13px] italic text-[var(--text-secondary)]">{t('project_chat.message_unreadable', 'This message could not be decrypted.')}</p>;
    }
    if (message.authorKind === 'assistant') {
        return (
            <div className="py-3 text-[14px] leading-7 text-[var(--text-primary)] min-w-0" data-testid="team-chat-assistant-body">
                <MarkdownRenderer content={message.content} isLoading={false} />
            </div>
        );
    }
    return <MentionText text={message.content} tokens={ctx.mentionTokens} />;
}

/**
 * What a message sits in: what a person wrote is a bubble (theirs on the right, tinted with the project's colour;
 * a colleague's on the left, in grey), the AI's answer is its wide card, a notice is not a bubble at all.
 */
function bubbleFor(message: TeamChatMessage, ctx: MessageContext): { className: string; style?: React.CSSProperties } {
    if (message.authorKind !== 'user') {
        return { className: 'rounded-lg px-2 py-1 -mx-2 hover:bg-[color-mix(in_srgb,var(--accent-primary)_5%,var(--bg-secondary))] transition-colors' };
    }
    const mine = !!ctx.currentUserId && message.authorUserId === ctx.currentUserId;
    // A person's colour is only a wash: the bubble stays quiet, and the text keeps the theme's ink.
    const color = ctx.colorOf?.(message.authorUserId);
    if (mine) {
        return {
            className: 'ml-auto w-fit max-w-[80%] rounded-2xl rounded-tr-md px-3.5 py-2',
            style: { background: 'var(--user-bubble-bg)', color: 'var(--user-bubble-fg)' },
        };
    }
    return color
        ? { className: 'w-fit max-w-[80%] rounded-2xl rounded-tl-md px-3.5 py-2', style: { background: washOf(color, 8), boxShadow: `inset 0 0 0 1px ${washOf(color, 14)}` } }
        : { className: 'w-fit max-w-[80%] rounded-2xl rounded-tl-md px-3.5 py-2 bg-[color-mix(in_srgb,var(--text-primary)_6%,var(--bg-card))]' };
}

function ConfirmedBubble({ message, ctx }: { message: TeamChatMessage; ctx: MessageContext }) {
    const { t } = useTranslation();
    const [editing, setEditing] = useState(false);
    const shape = bubbleFor(message, ctx);
    return (
        // tabIndex -1: a tap focuses the message (never a tab stop), which shows its actions on a touch screen without hover.
        <div tabIndex={-1} className={`relative group/msg outline-none ${shape.className}`} style={shape.style} data-testid={`team-chat-message-${message.id}`}>
            {message.replyTo && <ReplyPreview replyTo={message.replyTo} ctx={ctx} />}
            {editing
                ? <EditBox initial={message.content} onCancel={() => setEditing(false)}
                    onSave={async (next) => { await ctx.onEdit(message, next); setEditing(false); }} />
                : <MessageBody message={message} ctx={ctx} />}
            {!message.deleted && !editing && <RefChips refs={message.refs || []} ctx={ctx} />}
            {!message.deleted && !editing && !!message.aiMeta?.usedSources?.length && <div className="text-xs text-[var(--text-secondary)]">
                <span>{t('project_chat.context_used', 'Sources provided to AI')}</span>
                <RefChips refs={message.aiMeta.usedSources.filter(ref => !!ctx.refTitle?.(ref))} ctx={ctx} />
            </div>}
            {!message.deleted && message.aiMeta && (
                <AnswerTrace meta={message.aiMeta} projectId={ctx.traceScope?.projectId ?? null} chatId={ctx.traceScope?.chatId ?? null} messageId={message.id} />
            )}
            {message.editedAt && !message.deleted && !editing && (
                <span className="text-[11px] text-[var(--text-secondary)]">{t('project_chat.edited', '(edited)')}</span>
            )}
            {isAutomaticAnswer(message) && !message.deleted && (
                <AutoAnswerNote message={message} canGiveFeedback={ctx.canPost} onNotHelpful={ctx.onNotHelpful} />
            )}
            {!message.deleted && <ThreadFooter message={message} ctx={ctx} />}
            {!editing && <Actions message={message} ctx={ctx} onEditStart={() => setEditing(true)} />}
        </div>
    );
}

function PendingBubble({ pending, ctx }: { pending: PendingTeamChatMessage; ctx: MessageContext }) {
    const { t } = useTranslation();
    const failed = pending.status === 'failed';
    return (
        <div className="ml-auto w-fit max-w-[80%] rounded-2xl rounded-tr-md px-3.5 py-2 opacity-80"
            style={ctx.colorOf && pending.authorUserId
                ? { background: washOf(ctx.colorOf(pending.authorUserId), 12), boxShadow: `inset 0 0 0 1px ${washOf(ctx.colorOf(pending.authorUserId), 22)}` }
                : { background: (ctx.aiTone || AI_TONE).soft, boxShadow: `inset 0 0 0 1px ${(ctx.aiTone || AI_TONE).ring}` }}
            data-testid={`team-chat-pending-${pending.clientMsgId}`}>
            {pending.replyTo && <ReplyPreview replyTo={pending.replyTo} ctx={ctx} />}
            <div className={failed ? '' : 'opacity-70'}><MentionText text={pending.content} tokens={ctx.mentionTokens} /></div>
            <RefChips refs={pending.refs || []} ctx={ctx} />
            {failed ? (
                <div className="mt-1 flex items-center gap-2 flex-wrap" role="alert">
                    <span className="text-[12px] text-[var(--error-ink)]">
                        {t('project_chat.not_sent', 'Not sent.')}{pending.error || pending.errorCode ? ` ${projectErrorText(t, { error: pending.error, code: pending.errorCode })}` : ''}
                    </span>
                    <GhostButton onClick={() => ctx.onRetry(pending)}>
                        <RotateCcw className="w-3 h-3" aria-hidden="true" />{t('project_chat.retry', 'Try again')}
                    </GhostButton>
                    <GhostButton onClick={() => ctx.onDiscard(pending)}>
                        <X className="w-3 h-3" aria-hidden="true" />{t('project_chat.discard', 'Discard')}
                    </GhostButton>
                </div>
            ) : (
                <span className="text-[11px] text-[var(--text-secondary)]" role="status">{t('project_chat.sending', 'Sending…')}</span>
            )}
        </div>
    );
}

export default function ChatMessageBubble({ item, ctx }: { item: ChatItem; ctx: MessageContext }) {
    return item.type === 'pending'
        ? <PendingBubble pending={item.pending} ctx={ctx} />
        : <ConfirmedBubble message={item.message} ctx={ctx} />;
}
