// One row of the Chats tab: a team chat (last message, unread count, AI
// mode, "AI answering…") or an AI chat (who shared it, or that it is still
// private, with Share / Stop sharing for the one who owns it).

import { Bot, Loader2, Lock, Share2, Sparkles, Users } from 'lucide-react';
import React from 'react';
import { hasUnread } from '../../../../api/queries/projectChats';
import useRelativeTime from '../../../../hooks/useRelativeTime';
import { useTranslation, type TranslateFn } from '../../../../hooks/useTranslation';
import { GhostButton } from '../workspaceUi';
import { aiModeBadge, effectiveMode } from './AiModeSelector';
import { noticeExcerpt } from './SystemNotice';
import type { ChatListItem } from './useChatList';

export interface ChatRowContext {
    nameOf: (userId: string | null | undefined) => string;
    canShare: boolean;
    busyKey: string | null;
    onOpen: (item: ChatListItem) => void;
    onShare: (item: ChatListItem, share: boolean) => void;
}

const CHIP = 'inline-flex items-center gap-1 px-1.5 py-px rounded-full text-[10.5px] font-medium whitespace-normal text-right';

function Tile({ item }: { item: ChatListItem }) {
    const team = item.kind === 'team';
    const Icon = team ? Users : (item.type === 'agent' ? Bot : Sparkles);
    const tone = team ? 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]' : 'bg-[var(--item-active-bg)] text-[var(--accent-primary)]';
    return (
        <span className={`inline-grid place-items-center w-9 h-9 rounded-lg flex-shrink-0 ${tone}`} aria-hidden="true">
            <Icon className="w-4 h-4" />
        </span>
    );
}

function subline(item: ChatListItem, ctx: ChatRowContext, t: TranslateFn): string {
    if (item.kind === 'team') {
        const last = item.chat.lastMessage;
        if (!last) return t('project_chat.no_messages_yet', 'No messages yet');
        if (last.authorKind === 'system') return noticeExcerpt(last.notice, t);
        const who = last.authorKind === 'assistant'
            ? t('project_chat.ai_assistant', 'AI assistant')
            : (ctx.nameOf(last.authorUserId) || t('project_chat.someone', 'A member'));
        return `${who}: ${last.excerpt}`;
    }
    const what = item.type === 'agent' ? t('project_chat.agent_chat', 'Agent chat') : t('project_chat.ai_chat', 'AI chat');
    if (!item.shared) return `${what} · ${t('project_chat.private_hint', 'Private: only you can see it')}`;
    if (item.mine) return `${what} · ${t('project_chat.shared_by_you', 'Shared with the project by you')}`;
    const owner = ctx.nameOf(item.ownerId) || t('project_chat.someone', 'A member');
    return `${what} · ${t('project_chat.shared_by', 'Shared by {name}', { name: owner })}`;
}

function Badges({ item, answering }: { item: ChatListItem; answering: boolean }) {
    const { t } = useTranslation();
    const unread = item.kind === 'team' && hasUnread(item.chat);
    const count = item.kind === 'team' && typeof item.chat.unread === 'number' ? item.chat.unread : 0;
    return (
        <>
            {answering && (
                <span className={`${CHIP} bg-[var(--item-active-bg)] text-[var(--accent-primary)]`} data-testid="chat-row-answering">
                    <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />{t('project_chat.ai_answering', 'AI answering…')}
                </span>
            )}
            {item.kind === 'team' && (
                <span className={`${CHIP} border border-[var(--border-default)] text-[var(--text-tertiary)]`}>{aiModeBadge(effectiveMode(item.chat), t)}</span>
            )}
            {unread && (
                <span className={`${CHIP} bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] tabular-nums`} data-testid="chat-row-unread"
                    aria-label={t('project_chat.unread', 'Unread messages')}>
                    {count > 0 ? count : '•'}
                </span>
            )}
        </>
    );
}

function ShareAction({ item, ctx }: { item: ChatListItem; ctx: ChatRowContext }) {
    const { t } = useTranslation();
    if (item.kind !== 'ai' || !item.mine) return null;
    const busy = ctx.busyKey === item.key;
    if (item.shared) {
        return (
            <GhostButton onClick={() => ctx.onShare(item, false)} disabled={busy} data-testid={`chat-row-unshare-${item.id}`}>
                <Lock className="w-3 h-3" aria-hidden="true" />{t('project_chat.unshare', 'Stop sharing')}
            </GhostButton>
        );
    }
    if (!ctx.canShare) return null;
    return (
        <GhostButton onClick={() => ctx.onShare(item, true)} disabled={busy} data-testid={`chat-row-share-${item.id}`}>
            <Share2 className="w-3 h-3" aria-hidden="true" />{t('project_chat.share', 'Share with members')}
        </GhostButton>
    );
}

export default function ChatListRow({ item, answering, ctx }: { item: ChatListItem; answering: boolean; ctx: ChatRowContext }) {
    const { t } = useTranslation();
    const ago = useRelativeTime();
    const title = item.title || (item.kind === 'team' ? t('project_chat.untitled_team_chat', 'Team chat') : t('project_chat.untitled_chat', 'Untitled chat'));
    const bold = item.kind === 'team' && hasUnread(item.chat);
    const privateChat = item.kind === 'ai' && !item.shared;
    return (
        <li className={`group/row flex items-center gap-1 pr-2 border-b last:border-b-0 border-[var(--border-subtle)] hover:bg-[var(--item-hover-bg)] transition-colors ${bold ? 'border-l-2 border-l-[var(--accent-primary)] bg-[var(--item-active-bg)]/30' : 'border-l-2 border-l-transparent'}`}>
            <button type="button" onClick={() => ctx.onOpen(item)} data-testid={`chat-row-${item.id}`}
                className="flex items-center gap-3 flex-1 min-w-0 text-left px-3 py-2.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)] rounded-lg">
                <Tile item={item} />
                <span className="flex-1 min-w-0">
                    <span className="flex items-center gap-1.5 min-w-0">
                        <span className={`truncate text-[13.5px] text-[var(--text-primary)] ${bold ? 'font-semibold' : 'font-medium'}`}>{title}</span>
                        {privateChat && <Lock className="w-3 h-3 flex-shrink-0 text-[var(--text-tertiary)]" aria-label={t('project_chat.private', 'Private')} />}
                    </span>
                    <span className="block mt-0.5 text-[12.5px] truncate text-[var(--text-tertiary)]">{subline(item, ctx, t)}</span>
                </span>
                <span className="flex flex-col items-end gap-1 flex-shrink-0 max-w-[40%]">
                    {item.at && <span className="text-[11px] text-[var(--text-tertiary)] whitespace-nowrap">{ago(item.at)}</span>}
                    <span className="flex flex-wrap justify-end gap-1"><Badges item={item} answering={answering} /></span>
                </span>
            </button>
            {/* Share / Stop sharing: always there for keyboard and touch, quiet until hover where a pointer can hover. */}
            <span className="flex-shrink-0 transition-opacity [@media(hover:hover)]:opacity-0 group-hover/row:opacity-100 focus-within:opacity-100">
                <ShareAction item={item} ctx={ctx} />
            </span>
        </li>
    );
}
