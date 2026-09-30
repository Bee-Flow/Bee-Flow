// The scrolling message column of a team chat. It follows the newest message
// while the reader is at the bottom, stays put when they scrolled back, and
// keeps its place when an older page is added above.

import { Loader2, MessagesSquare } from 'lucide-react';
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
import { groupMessages } from './messageGroups';

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

function EmptyChat() {
    const { t } = useTranslation();
    return (
        <div className="flex flex-col items-center justify-center text-center gap-2 py-16 px-6" data-testid="team-chat-empty">
            <MessagesSquare className="w-8 h-8 text-[var(--text-tertiary)]" aria-hidden="true" />
            <p className="m-0 text-[14px] font-semibold text-[var(--text-primary)]">{t('project_chat.empty_title', 'No messages yet')}</p>
            <p className="m-0 max-w-sm text-[12.5px] text-[var(--text-tertiary)]">
                {t('project_chat.empty_body', 'Say hello to the team. Mention @ai when you want the assistant to join in.')}
            </p>
        </div>
    );
}

export default function ChatMessageList({ projectId, chatId, base, footer }: {
    projectId: string;
    chatId: string;
    base: BaseMessageContext;
    footer?: React.ReactNode;
}) {
    const { t } = useTranslation();
    const query = useTeamChatMessages(projectId, chatId);
    const older = useLoadOlderMessages(projectId, chatId);
    const data = query.data;
    const messages = useMemo(() => data?.messages || [], [data]);
    const { handlers, confirmDialog } = useMessageActions(projectId, chatId, messages);
    const ctx = useMemo<MessageContext>(() => ({ ...base, ...handlers }), [base, handlers]);
    const groups = useMemo(() => groupMessages(messages, data?.pending || []), [messages, data]);

    const containerRef = useRef<HTMLDivElement>(null);
    const { onScroll } = useStickToBottom({ containerRef });
    const keepPlace = useKeepPlace(containerRef, messages[0]?.id);
    const loadOlder = () => {
        keepPlace();
        older.mutate(undefined, { onError: () => toast.error(t('project_chat.older_failed', 'Could not load earlier messages.')) });
    };

    return (
        <div ref={containerRef} onScroll={onScroll} className="flex-1 min-h-0 overflow-y-auto custom-scrollbar" data-testid="team-chat-messages">
            <div>
                {data?.hasOlder && (
                    <div className="flex justify-center py-2">
                        <GhostButton onClick={loadOlder} disabled={older.isPending}>
                            {older.isPending && <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />}
                            {t('project_chat.load_older', 'Load earlier messages')}
                        </GhostButton>
                    </div>
                )}
                {query.isPending && (
                    <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-[var(--text-tertiary)]" role="status">
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
                {data && !groups.length && <EmptyChat />}
                {groups.length > 0 && (
                    <ol className="list-none m-0 py-3 flex flex-col gap-1" aria-label={t('project_chat.messages_label', 'Messages')}>
                        {groups.map(group => <ChatMessageGroup key={group.key} group={group} ctx={ctx} />)}
                    </ol>
                )}
                {footer}
            </div>
            {confirmDialog}
        </div>
    );
}
