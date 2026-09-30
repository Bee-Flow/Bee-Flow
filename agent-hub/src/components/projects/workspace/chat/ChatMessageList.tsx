// The scrolling message column of a team chat. It follows the newest message
// while the reader is at the bottom, stays put when they scrolled back, and
// keeps its place when an older page is added above.

import { Loader2, MessagesSquare } from 'lucide-react';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import React, { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import {
    useDeleteTeamChatMessage, useEditTeamChatMessage, useLoadOlderMessages, useTeamChatFeedback, useTeamChatMessages, type TeamChatMessage,
} from '../../../../api/queries/projectChats';
import useStickToBottom from '../../../../hooks/useStickToBottom';
import { useTranslation } from '../../../../hooks/useTranslation';
import { toast } from '../../../shared/Toast';
import useConfirm from '../../../shared/useConfirm';
import { projectErrorText } from '../projectErrorText';
import { GhostButton, Notice } from '../workspaceUi';
import type { MessageContext } from './ChatMessageBubble';
import ChatMessageGroup from './ChatMessageGroup';
import { formatDayLabel, groupMessages, isNewDay, mainConversation, summarizeThreads, threadConversation, type MessageGroup } from './messageGroups';

export type BaseMessageContext = Omit<MessageContext, 'findMessage' | 'onDelete' | 'onEdit' | 'onNotHelpful'>;

function useMessageActions(projectId: string, chatId: string, messages: TeamChatMessage[]) {
    const { t } = useTranslation();
    const { confirm, confirmDialog } = useConfirm();
    const edit = useEditTeamChatMessage(projectId, chatId);
    const remove = useDeleteTeamChatMessage(projectId, chatId);
    const feedback = useTeamChatFeedback(projectId, chatId);
    const byId = useMemo(() => new Map(messages.map(m => [m.id, m])), [messages]);

    const onDelete = useCallback(async (message: TeamChatMessage) => {
        const ok = await confirm({
            title: t('project_chat.delete_message_title', 'Delete this message?'),
            description: t('project_chat.delete_message_body', 'Everyone in the project will see that a message was deleted here.'),
            confirmLabel: t('project_chat.delete', 'Delete'),
            cancelLabel: t('project_chat.cancel', 'Cancel'),
            destructive: true,
        });
        if (!ok) return;
        remove.mutate(message.id, { onError: e => toast.error(projectErrorText(t, e)) });
    }, [confirm, remove, t]);

    const onEdit = useCallback(async (message: TeamChatMessage, content: string) => {
        await edit.mutateAsync({ messageId: message.id, content });
    }, [edit]);

    const onNotHelpful = useCallback(async (message: TeamChatMessage) => {
        await feedback.mutateAsync({ messageId: message.id, helpful: false });
    }, [feedback]);

    const findMessage = useCallback((id: string) => byId.get(id), [byId]);
    const handlers = useMemo(() => ({ onDelete, onEdit, onNotHelpful, findMessage }), [onDelete, onEdit, onNotHelpful, findMessage]);
    return { handlers, confirmDialog };
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

function EmptyChat() {
    const { t } = useTranslation();
    return (
        <div className="flex flex-col items-center justify-center text-center gap-2 py-16 px-6" data-testid="team-chat-empty">
            <MessagesSquare className="w-8 h-8 text-[var(--text-secondary)]" aria-hidden="true" />
            <p className="m-0 text-[14px] font-semibold text-[var(--text-primary)]">{t('project_chat.empty_title', 'No messages yet')}</p>
            <p className="m-0 max-w-sm text-[12.5px] text-[var(--text-secondary)]">
                {t('project_chat.empty_body', 'Say hello to the team. Mention @ai when you want the assistant to join in.')}
            </p>
        </div>
    );
}

export default function ChatMessageList({ projectId, chatId, base, footer, threadId = null }: {
    projectId: string;
    chatId: string;
    base: BaseMessageContext;
    footer?: React.ReactNode;
    /** Show one thread (its root and replies) instead of the main conversation. */
    threadId?: string | null;
}) {
    const { t } = useTranslation();
    const query = useTeamChatMessages(projectId, chatId);
    const older = useLoadOlderMessages(projectId, chatId);
    const data = query.data;
    const messages = useMemo(() => data?.messages || [], [data]);
    const { handlers, confirmDialog } = useMessageActions(projectId, chatId, messages);
    const threads = useMemo(() => summarizeThreads(messages), [messages]);
    const threadOf = useCallback((id: string) => threads.get(id), [threads]);
    const ctx = useMemo<MessageContext>(
        () => ({ ...base, ...handlers, traceScope: { projectId, chatId }, ...(threadId ? {} : { threadOf }) }),
        [base, handlers, threadOf, threadId, projectId, chatId],
    );
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

    const containerRef = useRef<HTMLDivElement>(null);
    const { onScroll } = useStickToBottom({ containerRef });
    const keepPlace = useKeepPlace(containerRef, messages[0]?.id);
    const loadOlder = () => {
        keepPlace();
        older.mutate(undefined, { onError: () => toast.error(t('project_chat.older_failed', 'Could not load earlier messages.')) });
    };

    return (
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
                {query.isPending && (
                    <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-[var(--text-secondary)]" role="status">
                        <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />{t('project_chat.loading_messages', 'Loading messages…')}
                    </div>
                )}
                {query.isError && !data && (
                    <div className="p-4">
                        <Notice tone="error" role="alert" action={<GhostButton onClick={() => query.refetch()}>{t('project_chat.retry', 'Try again')}</GhostButton>}>
                            {t('project_chat.messages_failed', 'Could not load the messages of this chat.')}
                        </Notice>
                    </div>
                )}
                {data && !groups.length && !threadId && <EmptyChat />}
                {rootGroups.length > 0 && (
                    <div className="pt-3 pb-1 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]/40" data-testid="team-chat-thread-root">
                        <ol className="list-none m-0 p-0">{rootGroups.map(group => <ChatMessageGroup key={group.key} group={group} ctx={ctx} />)}</ol>
                        <p className="m-0 px-4 pb-2 pl-[60px] text-[11.5px] font-medium text-[var(--text-secondary)]">
                            {groups.length === 0 ? t('project_chat.thread_no_replies', 'No replies yet') : t('project_chat.thread_replies_heading', 'Replies')}
                        </p>
                    </div>
                )}
                {groups.length > 0 && (
                    <ol className="list-none m-0 py-3 flex flex-col gap-1 max-w-4xl mx-auto" aria-label={t('project_chat.messages_label', 'Messages')}>
                        {groups.map((group, i) => (
                            <React.Fragment key={group.key}>
                                {(i === 0 ? !threadId : isNewDay(lastAt(groups[i - 1]), group.createdAt)) && (
                                    <DaySeparator iso={group.createdAt} t={t} />
                                )}
                                <ChatMessageGroup group={group} ctx={ctx} />
                            </React.Fragment>
                        ))}
                    </ol>
                )}
                {footer}
            </div>
            {confirmDialog}
        </div>
    );
}
