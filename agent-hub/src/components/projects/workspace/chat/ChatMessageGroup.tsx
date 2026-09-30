// A run of messages by one author: avatar, name and time once, then the
// messages. The AI gets its own mark (a spark, or a bot for an agent) so a
// reader never mistakes an answer for a colleague's words.

import { Bot, Sparkles } from 'lucide-react';
import React from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { Avatar } from '../workspaceUi';
import ChatMessageBubble, { type MessageContext } from './ChatMessageBubble';
import { inkOf } from '../memberColors';
import { AI_TONE, type AiTone } from '../projectVisuals';
import { formatMessageTime, type MessageGroup } from './messageGroups';
import SystemNotice from './SystemNotice';

function AssistantAvatar({ agent, tone, icon }: { agent: boolean; tone: AiTone; icon?: string }) {
    const Icon = agent ? Bot : Sparkles;
    const emoji = !agent && icon ? icon : null;
    return (
        <span className="inline-grid place-items-center w-8 h-8 rounded-full flex-shrink-0" aria-hidden="true"
            style={{ color: tone.ink, background: tone.soft, boxShadow: `inset 0 0 0 1px ${tone.ring}` }}>
            {emoji ? <span className="text-[16px] leading-none">{emoji}</span> : <Icon className="w-4 h-4" />}
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
    const tone = ctx.aiTone || AI_TONE;
    const name = assistant ? ctx.assistantName(group.agentId) : ctx.nameOf(group.authorUserId);
    const mine = !assistant && !!ctx.currentUserId && group.authorUserId === ctx.currentUserId;
    const color = assistant ? null : ctx.colorOf?.(group.authorUserId) ?? null;
    return (
        <li className={`flex items-start gap-2.5 px-4 py-1.5 ${mine ? 'flex-row-reverse' : ''}`} data-testid="team-chat-group" data-mine={mine || undefined}>
            {assistant ? <AssistantAvatar agent={!!group.agentId} tone={tone} icon={ctx.aiIcon} /> : <Avatar name={name} picture={ctx.avatarOf?.(group.authorUserId)} color={color} />}
            <div className={`flex-1 min-w-0 ${mine ? 'flex flex-col items-end' : ''}`}>
                <div className={`flex items-baseline gap-2 min-w-0 ${mine ? 'justify-end' : ''}`}>
                    {/* Your own messages are on the right, marked by where they are: no name needed. */}
                    {!mine && <span className="text-[13px] font-semibold truncate"
                        style={{ color: assistant ? tone.ink : inkOf(color || 'var(--text-secondary)') }}>{name}</span>}
                    {assistant && (
                        <span className="text-[10.5px] px-1.5 py-px rounded-full font-semibold"
                            style={{ background: tone.soft, color: tone.ink }}>
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
