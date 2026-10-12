// The scrolling message column of a team chat. It follows the newest message
// while the reader is at the bottom, stays put when they scrolled back, and
// keeps its place when an older page is added above.

import { ArrowDown, Loader2, MessagesSquare } from 'lucide-react';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
    useDeleteTeamChatMessage, useEditTeamChatMessage, useLoadOlderMessages, useTeamChatFeedback, useTeamChatMessages, type TeamChatMessage,
} from '../../../../api/queries/projectChats';
import { useTranslation } from '../../../../hooks/useTranslation';
import { toast } from '../../../shared/Toast';
import { projectErrorText } from '../projectErrorText';
import { GhostButton, Notice, Skeleton } from '../workspaceUi';
import type { MessageContext } from './ChatMessageBubble';
import ChatMessageGroup from './ChatMessageGroup';
import { CHAT_COLUMN_CLASS } from './chatColumn';
import { useFollowNewest, useThreadRoot } from './listHooks';
import { firstUnreadMessageId, formatDayLabel, groupMessages, isNewDay, mainConversation, repliesToPrevious, summarizeThreads, threadConversation, type MessageGroup } from './messageGroups';

export type BaseMessageContext = Omit<MessageContext, 'findMessage' | 'onDelete' | 'onEdit' | 'onNotHelpful'>;

function useMessageActions(projectId: string, chatId: string, messages: TeamChatMessage[]) {
    const { t } = useTranslation();
    const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
    const mark = useCallback((id: string, gone: boolean) => setHidden((prev) => {
        const next = new Set(prev);
        if (gone) next.add(id); else next.delete(id);
        return next;
    }), []);
    const edit = useEditTeamChatMessage(projectId, chatId);
    const remove = useDeleteTeamChatMessage(projectId, chatId);
    const feedback = useTeamChatFeedback(projectId, chatId);
    const byId = useMemo(() => new Map(messages.map(m => [m.id, m])), [messages]);

    // Delete is undoable: the message leaves the list at once, the real delete
    // runs when the toast expires and never after Undo.
    const removeMutate = remove.mutate;
    const onDelete = useCallback((message: TeamChatMessage) => {
        mark(message.id, true);
        toast.undoable({
            message: t('project_home.message_deleted', 'Message deleted'),
            undoLabel: t('project_home.undo', 'Undo'),
            onUndo: () => mark(message.id, false),
            onExpire: () => removeMutate(message.id, { onError: (e) => { mark(message.id, false); toast.error(projectErrorText(t, e)); } }),
        });
    }, [mark, removeMutate, t]);

    const onEdit = useCallback(async (message: TeamChatMessage, content: string) => {
        await edit.mutateAsync({ messageId: message.id, content });
    }, [edit]);

    const onNotHelpful = useCallback(async (message: TeamChatMessage) => {
        await feedback.mutateAsync({ messageId: message.id, helpful: false });
    }, [feedback]);

    const findMessage = useCallback((id: string) => byId.get(id), [byId]);
    const handlers = useMemo(() => ({ onDelete, onEdit, onNotHelpful, findMessage }), [onDelete, onEdit, onNotHelpful, findMessage]);
    return { handlers, hidden };
}

/** Remember the distance to the bottom before an older page lands, restore it after. */
function useKeepPlace(containerRef: React.RefObject<HTMLDivElement | null>, firstId: string | undefined) {
    const fromBottom = useRef<number | null>(null);
    useLayoutEffect(() => {
        const el = containerRef.current;
        if (!el || fromBottom.current === null) return;
        el.scrollTop = el.scrollHeight - fromBottom.current;
        fromBottom.current = null;
    }, [containerRef, firstId]);
    return () => {
        const el = containerRef.current;
        if (el) fromBottom.current = el.scrollHeight - el.scrollTop;
    };
}

/** The time of the last message of a group (a group spans a few minutes at most). */
function lastAt(group: MessageGroup): string {
    const last = group.items[group.items.length - 1];
    return last.type === 'pending' ? last.pending.createdAt : last.message.createdAt;
}

function DaySeparator({ iso, t }: { iso: string; t: TranslateFn }) {
    const { locale } = useTranslation();
    const label = formatDayLabel(iso, locale, { today: t('project_chat.today', 'Today'), yesterday: t('project_chat.yesterday', 'Yesterday') });
    if (!label) return null;
    return (
        <li className="flex items-center gap-3 px-4 py-2 list-none" role="separator" aria-label={label} data-testid="team-chat-day">
            <span className="flex-1 h-px bg-[var(--border-subtle)]" />
            <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold capitalize text-[var(--text-secondary)] bg-[var(--bg-tertiary)]">{label}</span>
            <span className="flex-1 h-px bg-[var(--border-subtle)]" />
        </li>
    );
}

/** "New since your last visit": a DaySeparator in the accent colour, above the first unread message. */
function UnreadDivider() {
    const { t } = useTranslation();
    const label = t('project_chat.unread_divider', 'New since your last visit');
    return (
        <li className="flex items-center gap-3 px-4 py-2 list-none" role="separator" aria-label={label} data-testid="team-chat-unread-divider">
            <span className="flex-1 h-px bg-[var(--accent-primary)]" />
            <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold text-white bg-[var(--accent-primary)]">{label}</span>
            <span className="flex-1 h-px bg-[var(--accent-primary)]" />
        </li>
    );
}

/** Placeholder bubbles while the first page of messages is on its way. */
function SkeletonRows() {
    const { t } = useTranslation();
    return (
        <Skeleton rows={4} variant="rows" label={t('project_chat.loading_messages', 'Loading messages…')} testId="team-chat-skeleton"
            className={`flex flex-col gap-4 px-4 py-10 ${CHAT_COLUMN_CLASS}`} barClassName="!h-9 !w-3/5 !rounded-2xl" />
    );
}

/** A suggestion that drops its text into the composer, for an empty chat. */
function StarterChips({ onPick }: { onPick: (text: string) => void }) {
    const { t } = useTranslation();
    const starters = [
        { label: t('project_chat.starter_hello', 'Say hello to the team'), text: t('project_chat.starter_hello_text', 'Hello team!') },
        { label: t('project_chat.starter_summary', 'Ask @ai for a summary'), text: t('project_chat.starter_summary_text', '@ai Can you summarise where this project stands?') },
        { label: t('project_chat.starter_next', 'Ask @ai for next steps'), text: t('project_chat.starter_next_text', '@ai What should we tackle next?') },
    ];
    return (
        <div className="flex flex-wrap items-center justify-center gap-2 mt-3 max-w-md" data-testid="team-chat-starters">
            {starters.map(s => (
                <button key={s.label} type="button" onClick={() => onPick(s.text)}
                    className="px-3 py-1.5 rounded-full text-[12px] font-medium border border-[var(--border-default)] text-[var(--text-secondary)] hover:border-[var(--accent-primary)] hover:text-[var(--text-primary)] transition-colors">
                    {s.label}
                </button>
            ))}
        </div>
    );
}

function EmptyChat({ onPick }: { onPick?: (text: string) => void }) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-col items-center justify-center text-center gap-2 py-16 px-6" data-testid="team-chat-empty">
            <MessagesSquare className="w-8 h-8 text-[var(--text-secondary)]" aria-hidden="true" />
            <p className="m-0 text-[14px] font-semibold text-[var(--text-primary)]">{t('project_chat.empty_title', 'No messages yet')}</p>
            <p className="m-0 max-w-sm text-[12.5px] text-[var(--text-secondary)]">
                {t('project_chat.empty_body', 'Say hello to the team. Mention @ai when you want the assistant to join in.')}
            </p>
            {onPick && <StarterChips onPick={onPick} />}
        </div>
    );
}

/** The start of a thread that is not on screen: loading it, or why it cannot be shown. */
function ThreadRootPlaceholder({ loading, onRetry }: { loading: boolean; onRetry: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="px-4 py-6 border-b border-[var(--border-subtle)]" data-testid="team-chat-thread-root-missing">
            {loading ? (
                <div className="flex items-center justify-center gap-2 text-[13px] text-[var(--text-secondary)]" role="status">
                    <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />{t('project_chat.thread_loading', 'Loading the start of this thread…')}
                </div>
            ) : (
                <Notice tone="warning" role="alert" action={<GhostButton onClick={onRetry}>{t('project_chat.retry', 'Try again')}</GhostButton>}>
                    {t('project_chat.thread_root_missing', 'The message that started this thread could not be loaded.')}
                </Notice>
            )}
        </div>
    );
}

/** "3 new messages": shown while the list is scrolled away from its newest end. */
function NewMessagesPill({ count, onClick }: { count: number; onClick: () => void }) {
    const { t } = useTranslation();
    return (
        <button type="button" onClick={onClick} data-testid="team-chat-new-messages"
            className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-[12px] font-semibold shadow-lg bg-[var(--accent-primary)] text-white hover:opacity-90">
            <ArrowDown className="w-3.5 h-3.5" aria-hidden="true" />
            {count === 1 ? t('project_chat.new_messages_one', '1 new message') : t('project_chat.new_messages_many', '{count} new messages', { count })}
        </button>
    );
}

export default function ChatMessageList({ projectId, chatId, base, footer, threadId = null, unreadCount = 0, onStarter }: {
    projectId: string;
    chatId: string;
    base: BaseMessageContext;
    footer?: React.ReactNode;
    /** Show one thread (its root and replies) instead of the main conversation. */
    threadId?: string | null;
    /** How many messages were unread when the chat opened (the divider's position; main list only). */
    unreadCount?: number;
    /** Drops a starter text into the composer, offered by the empty state. */
    onStarter?: (text: string) => void;
}) {
    const { t } = useTranslation();
    const query = useTeamChatMessages(projectId, chatId);
    const older = useLoadOlderMessages(projectId, chatId);
    const data = query.data;
    const loaded = useMemo(() => data?.messages || [], [data]);
    const { handlers, hidden } = useMessageActions(projectId, chatId, loaded);
    const messages = useMemo(() => (hidden.size ? loaded.filter(m => !hidden.has(m.id)) : loaded), [loaded, hidden]);
    const threads = useMemo(() => summarizeThreads(messages), [messages]);
    const threadOf = useCallback((id: string) => threads.get(id), [threads]);
    const { groups, rootGroups } = useMemo(() => {
        if (!threadId) {
            const main = mainConversation(messages, data?.pending || []);
            return { groups: groupMessages(main.messages, main.pending), rootGroups: [] as MessageGroup[] };
        }
        // The message that starts a thread stands apart from its replies.
        const shown = threadConversation(messages, data?.pending || [], threadId);
        return {
            rootGroups: groupMessages(shown.messages.filter(m => m.id === threadId), []),
            groups: groupMessages(shown.messages.filter(m => m.id !== threadId), shown.pending),
        };
    }, [messages, data, threadId]);
    const adjacent = useMemo(() => repliesToPrevious(groups), [groups]);
    const ctx = useMemo<MessageContext>(
        () => ({ ...base, ...handlers, traceScope: { projectId, chatId }, quotesPrevious: (id: string) => adjacent.has(id), ...(threadId ? {} : { threadOf }) }),
        [base, handlers, threadOf, threadId, projectId, chatId, adjacent],
    );

    const containerRef = useRef<HTMLDivElement>(null);
    const { onScroll, jumpToNewest, unseen } = useFollowNewest({
        containerRef, projectId, chatId, threadId, groups, messages, currentUserId: base.currentUserId,
    });
    const root = useThreadRoot(projectId, chatId, threadId, data);
    const keepPlace = useKeepPlace(containerRef, messages[0]?.id);
    // Where the "new since your last visit" line goes: the first message that
    // was unread on opening (threads never get one). Kept for the visit — it
    // is gone the next time the chat opens, when the read marker has moved.
    const firstUnread = useMemo(() => (threadId || !unreadCount
        ? null
        : firstUnreadMessageId(mainConversation(messages, []).messages, unreadCount, base.currentUserId)),
    [messages, threadId, unreadCount, base.currentUserId]);
    // The search's active match scrolls into view as it moves.
    const activeMatch = base.highlight?.activeMessageId ?? null;
    useEffect(() => {
        if (!activeMatch) return;
        const box = containerRef.current;
        const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(activeMatch) : activeMatch;
        box?.querySelector(`[data-message-id="${escaped}"]`)?.scrollIntoView?.({ block: 'center' });
    }, [activeMatch]);
    const loadOlder = () => {
        keepPlace();
        older.mutate(undefined, { onError: () => toast.error(t('project_chat.older_failed', 'Could not load earlier messages.')) });
    };

    return (
        <div className="relative flex-1 min-h-0 flex flex-col">
            <div ref={containerRef} onScroll={onScroll} className="flex-1 min-h-0 overflow-y-auto custom-scrollbar" data-testid={threadId ? 'team-chat-thread-messages' : 'team-chat-messages'}>
                <div>
                    {!threadId && data?.hasOlder && (
                        <div className="flex justify-center py-2">
                            <GhostButton onClick={loadOlder} disabled={older.isPending}>
                                {older.isPending && <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />}
                                {t('project_chat.load_older', 'Load earlier messages')}
                            </GhostButton>
                        </div>
                    )}
                    {query.isPending && <SkeletonRows />}
                    {query.isError && !data && (
                        <div className="p-4">
                            <Notice tone="error" role="alert" action={<GhostButton onClick={() => query.refetch()}>{t('project_chat.retry', 'Try again')}</GhostButton>}>
                                {t('project_chat.messages_failed', 'Could not load the messages of this chat.')}
                            </Notice>
                        </div>
                    )}
                    {data && !groups.length && !threadId && <EmptyChat onPick={onStarter} />}
                    {threadId && data && root.state !== 'found' && <ThreadRootPlaceholder loading={root.state === 'loading'} onRetry={root.retry} />}
                    {rootGroups.length > 0 && (
                        <div className="pt-3 pb-1 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]/40" data-testid="team-chat-thread-root">
                            <ol className="list-none m-0 p-0">{rootGroups.map(group => <ChatMessageGroup key={group.key} group={group} ctx={ctx} />)}</ol>
                            <p className="m-0 px-4 pb-2 pl-[60px] text-[11.5px] font-medium text-[var(--text-secondary)]">
                                {groups.length === 0 ? t('project_chat.thread_no_replies', 'No replies yet') : t('project_chat.thread_replies_heading', 'Replies')}
                            </p>
                        </div>
                    )}
                    {groups.length > 0 && (
                        <ol className={`list-none m-0 py-3 flex flex-col gap-1 ${CHAT_COLUMN_CLASS}`} aria-label={t('project_chat.messages_label', 'Messages')}
                            aria-live={older.isPending ? 'off' : 'polite'} aria-relevant="additions">
                            {groups.map((group, i) => (
                                <React.Fragment key={group.key}>
                                    {(i === 0 ? !threadId : isNewDay(lastAt(groups[i - 1]), group.createdAt)) && (
                                        <DaySeparator iso={group.createdAt} t={t} />
                                    )}
                                    {firstUnread && group.items.some(item => item.type === 'message' && item.message.id === firstUnread) && (
                                        <UnreadDivider />
                                    )}
                                    <ChatMessageGroup group={group} ctx={ctx} />
                                </React.Fragment>
                            ))}
                        </ol>
                    )}
                    {footer}
                </div>
            </div>
            {unseen > 0 && <NewMessagesPill count={unseen} onClick={jumpToNewest} />}
        </div>
    );
}
