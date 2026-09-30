// One message inside a team chat group: its text (plain with painted
// @mentions for people, markdown for the AI), a reply preview, the edited and
// deleted states, the hover actions, and — for a message not confirmed yet —
// "sending" or "not sent" with retry and discard.

import { CornerUpLeft, Pencil, RotateCcw, Trash2, X } from 'lucide-react';
import React, { useState } from 'react';
import { isAutomaticAnswer, type PendingTeamChatMessage, type TeamChatMessage } from '../../../../api/queries/projectChats';
import { useTranslation } from '../../../../hooks/useTranslation';
import MarkdownRenderer from '../../../renderers/MarkdownRenderer';
import { projectErrorText } from '../projectErrorText';
import { ErrorText, GhostButton, PrimaryButton, SecondaryButton } from '../workspaceUi';
import AutoAnswerNote from './AutoAnswerNote';
import { excerptOf, type ChatItem } from './messageGroups';
import { splitMentions } from './mentions';

/** What a bubble needs from the chat around it. */
export interface MessageContext {
    currentUserId: string | null;
    isProjectOwner: boolean;
    canPost: boolean;
    /** A display name for a user id, never empty. */
    nameOf: (userId: string | null | undefined) => string;
    /** The name of the AI that wrote a message. */
    assistantName: (agentId: string | null | undefined) => string;
    mentionTokens: string[];
    findMessage: (id: string) => TeamChatMessage | undefined;
    onReply: (message: TeamChatMessage) => void;
    onDelete: (message: TeamChatMessage) => void;
    onEdit: (message: TeamChatMessage, content: string) => Promise<void>;
    onRetry: (pending: PendingTeamChatMessage) => void;
    onDiscard: (pending: PendingTeamChatMessage) => void;
    /** "Not helpful" on an answer the AI gave on its own. */
    onNotHelpful: (message: TeamChatMessage) => Promise<void>;
    /** Opens the reader's own AI settings (the opt-out), when the page can navigate. */
    onShowAiSettings?: () => void;
}

const ACTION_CLASS = 'grid place-items-center w-7 h-7 rounded-md text-[var(--text-tertiary)] '
    + 'hover:text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)] transition-colors';

function MentionText({ text, tokens }: { text: string; tokens: string[] }) {
    return (
        <p className="m-0 text-[13.5px] leading-relaxed text-[var(--text-primary)] whitespace-pre-wrap break-words">
            {splitMentions(text, tokens).map((part, i) => (part.mention
                ? <span key={i} className="px-0.5 rounded font-medium text-[var(--accent-primary)] bg-[var(--item-active-bg)]">{part.text}</span>
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
        <div className="mb-1 flex items-center gap-1.5 text-[12px] text-[var(--text-tertiary)] border-l-2 border-[var(--border-default)] pl-2 min-w-0">
            <CornerUpLeft className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
            {who && <span className="font-medium text-[var(--text-secondary)] flex-shrink-0">{who}</span>}
            <span className="truncate">{text}</span>
        </div>
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
                    else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); save(); }
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
            {ctx.canPost && (
                <button type="button" className={ACTION_CLASS} onClick={() => ctx.onReply(message)}
                    aria-label={t('project_chat.reply', 'Reply')} title={t('project_chat.reply', 'Reply')}>
                    <CornerUpLeft className="w-3.5 h-3.5" aria-hidden="true" />
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
        return <p className="m-0 text-[13px] italic text-[var(--text-tertiary)]">{t('project_chat.message_deleted', 'This message was deleted.')}</p>;
    }
    if (message.unreadable) {
        return <p className="m-0 text-[13px] italic text-[var(--text-tertiary)]">{t('project_chat.message_unreadable', 'This message could not be decrypted.')}</p>;
    }
    if (message.authorKind === 'assistant') {
        return (
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-3 py-2 text-[13.5px] text-[var(--text-primary)] min-w-0" data-testid="team-chat-assistant-body">
                <MarkdownRenderer content={message.content} isLoading={false} />
            </div>
        );
    }
    return <MentionText text={message.content} tokens={ctx.mentionTokens} />;
}

function ConfirmedBubble({ message, ctx }: { message: TeamChatMessage; ctx: MessageContext }) {
    const { t } = useTranslation();
    const [editing, setEditing] = useState(false);
    return (
        // tabIndex -1: a tap focuses the message (never a tab stop), which shows its actions on a touch screen without hover.
        <div tabIndex={-1} className="relative group/msg rounded-lg px-2 py-1 -mx-2 outline-none hover:bg-[var(--item-hover-bg)]" data-testid={`team-chat-message-${message.id}`}>
            {message.replyTo && <ReplyPreview replyTo={message.replyTo} ctx={ctx} />}
            {editing
                ? <EditBox initial={message.content} onCancel={() => setEditing(false)}
                    onSave={async (next) => { await ctx.onEdit(message, next); setEditing(false); }} />
                : <MessageBody message={message} ctx={ctx} />}
            {message.editedAt && !message.deleted && !editing && (
                <span className="text-[11px] text-[var(--text-tertiary)]">{t('project_chat.edited', '(edited)')}</span>
            )}
            {isAutomaticAnswer(message) && !message.deleted && (
                <AutoAnswerNote message={message} canGiveFeedback={ctx.canPost} onNotHelpful={ctx.onNotHelpful} />
            )}
            {!editing && <Actions message={message} ctx={ctx} onEditStart={() => setEditing(true)} />}
        </div>
    );
}

function PendingBubble({ pending, ctx }: { pending: PendingTeamChatMessage; ctx: MessageContext }) {
    const { t } = useTranslation();
    const failed = pending.status === 'failed';
    return (
        <div className="rounded-lg px-2 py-1 -mx-2" data-testid={`team-chat-pending-${pending.clientMsgId}`}>
            {pending.replyTo && <ReplyPreview replyTo={pending.replyTo} ctx={ctx} />}
            <div className={failed ? '' : 'opacity-70'}><MentionText text={pending.content} tokens={ctx.mentionTokens} /></div>
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
                <span className="text-[11px] text-[var(--text-tertiary)]" role="status">{t('project_chat.sending', 'Sending…')}</span>
            )}
        </div>
    );
}

export default function ChatMessageBubble({ item, ctx }: { item: ChatItem; ctx: MessageContext }) {
    return item.type === 'pending'
        ? <PendingBubble pending={item.pending} ctx={ctx} />
        : <ConfirmedBubble message={item.message} ctx={ctx} />;
}
