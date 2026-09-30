// How a team chat's messages are laid out: consecutive messages from the same
// author within a few minutes share one header (avatar, name, time), and the
// messages still on their way to the server trail after the confirmed ones.
// A system notice always stands alone.

import type { PendingTeamChatMessage, TeamChatAuthorKind, TeamChatMessage } from '../../../../api/queries/projectChats';

export const GROUP_WINDOW_MS = 5 * 60_000;

export type ChatItem =
    | { type: 'message'; key: string; message: TeamChatMessage }
    | { type: 'pending'; key: string; pending: PendingTeamChatMessage };

export interface MessageGroup {
    key: string;
    authorKind: TeamChatAuthorKind;
    authorUserId: string | null;
    agentId: string | null;
    createdAt: string;
    items: ChatItem[];
}

interface Author { authorKind: TeamChatAuthorKind; authorUserId: string | null; agentId: string | null; createdAt: string }

function authorOf(item: ChatItem): Author {
    if (item.type === 'pending') {
        return { authorKind: 'user', authorUserId: item.pending.authorUserId, agentId: null, createdAt: item.pending.createdAt };
    }
    const m = item.message;
    return { authorKind: m.authorKind, authorUserId: m.authorUserId, agentId: m.agentId, createdAt: m.createdAt };
}

const timeOf = (iso: string) => {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? 0 : t;
};

function continues(group: MessageGroup, lastAt: string, author: Author): boolean {
    if (group.authorKind !== author.authorKind || author.authorKind === 'system') return false;
    const sameWho = author.authorKind === 'assistant'
        ? group.agentId === author.agentId
        : group.authorUserId === author.authorUserId;
    return sameWho && Math.abs(timeOf(author.createdAt) - timeOf(lastAt)) <= GROUP_WINDOW_MS;
}

export function groupMessages(messages: TeamChatMessage[], pending: PendingTeamChatMessage[]): MessageGroup[] {
    const items: ChatItem[] = [
        ...messages.map((message): ChatItem => ({ type: 'message', key: message.id, message })),
        ...pending.map((p): ChatItem => ({ type: 'pending', key: `pending:${p.clientMsgId}`, pending: p })),
    ];
    const groups: MessageGroup[] = [];
    let lastAt = '';
    for (const item of items) {
        const author = authorOf(item);
        const current = groups[groups.length - 1];
        if (current && continues(current, lastAt, author)) current.items.push(item);
        else groups.push({ key: item.key, ...author, items: [item] });
        lastAt = author.createdAt;
    }
    return groups;
}

/** "14:05" for today, a short date and time before that. */
export function formatMessageTime(iso: string, locale: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === new Date().toDateString()) return time;
    return `${d.toLocaleDateString(locale, { day: 'numeric', month: 'short' })} ${time}`;
}

/** One line of a message, for a reply preview. */
export function excerptOf(content: string, max = 90): string {
    const flat = content.replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
