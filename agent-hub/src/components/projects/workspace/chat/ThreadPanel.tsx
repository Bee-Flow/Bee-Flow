// The thread of one message, beside the chat: the message that starts it, its
// replies, and a box that posts into the thread only. It reads the same
// message cache as the main list, so a reply is there in both places at once.

import { CheckSquare, X } from 'lucide-react';
import React from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import ChatComposer, { type ChatComposerProps } from './ChatComposer';
import type { BaseMessageContext } from './ChatMessageList';
import ChatMessageList from './ChatMessageList';

export interface ThreadPanelProps {
    projectId: string;
    chatId: string;
    threadId: string;
    /** The chat's message context without quote-reply and thread actions. */
    base: BaseMessageContext;
    canPost: boolean;
    composer: Pick<ChatComposerProps, 'candidates' | 'aiEnabled' | 'onSend' | 'onTyping' | 'tier' | 'draftKey'>;
    /** What the AI said about a post made here (shown above the box, in sight of where it was typed). */
    notice?: React.ReactNode;
    footer?: React.ReactNode;
    onClose: () => void;
    /** Make a task about this thread. */
    onCreateTask?: () => void;
}

export default function ThreadPanel({ projectId, chatId, threadId, base, canPost, composer, notice, footer, onClose, onCreateTask }: ThreadPanelProps) {
    const { t } = useTranslation();
    return (
        <aside className="absolute inset-0 z-10 md:static md:inset-auto md:w-[380px] md:flex-shrink-0 flex flex-col min-h-0 border-l border-[var(--border-default)] bg-[var(--bg-primary)]"
            aria-label={t('project_chat.thread_title', 'Thread')} data-testid="team-chat-thread-panel">
            <div className="flex-shrink-0 flex items-center gap-2 px-4 h-12 border-b border-[var(--border-subtle)]">
                <h2 className="m-0 flex-1 text-[14px] font-semibold text-[var(--text-primary)]">{t('project_chat.thread_title', 'Thread')}</h2>
                {onCreateTask && (
                    <button type="button" onClick={onCreateTask} title={t('project_tasks.from_thread', 'Make a task from this thread')}
                        className="inline-flex items-center gap-1.5 h-7 px-2 rounded-md text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)]">
                        <CheckSquare className="w-3.5 h-3.5" aria-hidden="true" />{t('project_tasks.task', 'Task')}
                    </button>
                )}
                <button type="button" onClick={onClose} aria-label={t('project_chat.close_thread', 'Close thread')} title={t('project_chat.close_thread', 'Close thread')}
                    className="grid place-items-center w-7 h-7 rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)]">
                    <X className="w-4 h-4" aria-hidden="true" />
                </button>
            </div>
            <ChatMessageList projectId={projectId} chatId={chatId} base={base} threadId={threadId} footer={footer} />
            {notice}
            {canPost && (
                <ChatComposer {...composer} reply={null} onCancelReply={() => undefined}
                    placeholder={t('project_chat.thread_placeholder', 'Reply in the thread. Type @ to tag people, tasks, documents and more.')} />
            )}
        </aside>
    );
}
