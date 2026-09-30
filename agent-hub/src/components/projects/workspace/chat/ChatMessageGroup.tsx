// A run of messages by one author: avatar, name and time once, then the
// messages. The AI gets its own mark (a spark, or a bot for an agent) so a
// reader never mistakes an answer for a colleague's words.

import { Bot, Sparkles } from 'lucide-react';
import React from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { Avatar } from '../workspaceUi';
import ChatMessageBubble, { type MessageContext } from './ChatMessageBubble';
import { formatMessageTime, type MessageGroup } from './messageGroups';
import SystemNotice from './SystemNotice';

function AssistantAvatar({ agent }: { agent: boolean }) {
    const Icon = agent ? Bot : Sparkles;
    return (
        <span className="inline-grid place-items-center w-8 h-8 rounded-full flex-shrink-0 bg-[var(--item-active-bg)] text-[var(--accent-primary)]" aria-hidden="true">
            <Icon className="w-4 h-4" />
        </span>
    );
}

export default function ChatMessageGroup({ group, ctx }: { group: MessageGroup; ctx: MessageContext }) {
    const { t, locale } = useTranslation();
    if (group.authorKind === 'system') {
        return (
            <>
                {group.items.map(item => (item.type === 'message'
                    ? <SystemNotice key={item.key} message={item.message} nameOf={ctx.nameOf} currentUserId={ctx.currentUserId} onShowAiSettings={ctx.onShowAiSettings} />
                    : null))}
            </>
        );
    }
    const assistant = group.authorKind === 'assistant';
    const name = assistant ? ctx.assistantName(group.agentId) : ctx.nameOf(group.authorUserId);
    const mine = !assistant && !!ctx.currentUserId && group.authorUserId === ctx.currentUserId;
    return (
        <li className="flex items-start gap-2.5 px-4 py-1.5" data-testid="team-chat-group">
            {assistant ? <AssistantAvatar agent={!!group.agentId} /> : <Avatar name={name} />}
            <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2 min-w-0">
                    <span className="text-[13px] font-semibold text-[var(--text-primary)] truncate">{name}</span>
                    {mine && <span className="text-[11px] text-[var(--text-tertiary)]">{t('project_chat.you_suffix', '(you)')}</span>}
                    {assistant && (
                        <span className="text-[10.5px] px-1.5 py-px rounded-full bg-[var(--item-active-bg)] text-[var(--accent-primary)] font-medium">
                            {t('project_chat.ai_badge', 'AI')}
                        </span>
                    )}
                    <time className="text-[11px] text-[var(--text-tertiary)] whitespace-nowrap" dateTime={group.createdAt}
                        title={new Date(group.createdAt).toLocaleString(locale)}>
                        {formatMessageTime(group.createdAt, locale)}
                    </time>
                </div>
                <div className="flex flex-col gap-0.5 mt-0.5">
                    {group.items.map(item => <ChatMessageBubble key={item.key} item={item} ctx={ctx} />)}
                </div>
            </div>
        </li>
    );
}
