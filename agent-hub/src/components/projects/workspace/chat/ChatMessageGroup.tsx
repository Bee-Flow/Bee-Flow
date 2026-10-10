// A run of messages by one author: avatar, name and time once, then the
// messages. The AI gets its own mark (a spark, or a bot for an agent) so a
// reader never mistakes an answer for a colleague's words.

import { Bot, Sparkles } from 'lucide-react';
import React from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { Avatar } from '../workspaceUi';
import ChatMessageBubble, { type MessageContext } from './ChatMessageBubble';
import { inkOf } from '../memberColors';
import { kindColorVar, kindTint } from '../../../shared/kindColors';
import { CHAT_COLUMN_CLASS } from './chatColumn';
import { formatMessageTime, type MessageGroup } from './messageGroups';
import SystemNotice from './SystemNotice';

/** The 26 px tile of the AI chat (`MessageItem`), in the agent colour of the Studio kinds. */
function AssistantAvatar({ agent, icon }: { agent: boolean; icon?: string }) {
    const Icon = agent ? Bot : Sparkles;
    const emoji = !agent && icon ? icon : null;
    const ink = kindColorVar('agent');
    return (
        <span data-testid="assistant-avatar" aria-hidden="true"
            className="w-[26px] h-[26px] rounded-lg flex-shrink-0 grid place-items-center overflow-hidden text-[13px] leading-none select-none"
            style={{ color: ink, background: kindTint('agent', 14) }}>
            {emoji ? <span>{emoji}</span> : <Icon className="w-3.5 h-3.5" />}
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
    const color = assistant ? null : ctx.colorOf?.(group.authorUserId) ?? null;
    return (
        <li className={`flex items-start gap-3 px-4 py-1.5 ${CHAT_COLUMN_CLASS} ${mine ? 'flex-row-reverse' : ''}`} data-testid="team-chat-group" data-mine={mine || undefined}>
            {assistant ? <AssistantAvatar agent={!!group.agentId} icon={ctx.aiIcon} /> : <Avatar name={name} picture={ctx.avatarOf?.(group.authorUserId)} color={color} />}
            <div className={`flex-1 min-w-0 ${mine ? 'flex flex-col items-end' : ''}`}>
                <div className={`flex items-baseline gap-2 min-w-0 ${mine ? 'justify-end' : ''}`}>
                    {/* Your own messages are on the right, marked by where they are: no name needed. */}
                    {!mine && assistant && <span className="text-[13px] font-semibold truncate text-[var(--text-primary)]">{name}</span>}
                    {!mine && !assistant && <span className="text-[13px] font-semibold truncate"
                        style={{ color: inkOf(color || 'var(--text-secondary)') }}>{name}</span>}
                    {assistant && (
                        <span className="text-[10.5px] px-1.5 py-px rounded-full font-semibold bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
                            {t('project_chat.ai_badge', 'AI')}
                        </span>
                    )}
                    <time className="text-[11px] text-[var(--text-secondary)] whitespace-nowrap" dateTime={group.createdAt}
                        title={new Date(group.createdAt).toLocaleString(locale)}>
                        {formatMessageTime(group.createdAt, locale)}
                    </time>
                </div>
                <div className={`flex flex-col gap-1 mt-0.5 ${mine ? 'w-full' : ''}`}>
                    {group.items.map(item => <ChatMessageBubble key={item.key} item={item} ctx={ctx} />)}
                </div>
            </div>
        </li>
    );
}
