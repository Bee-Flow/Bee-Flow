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
    // A run that crosses midnight is cut there: the day separator and the new
    // group's time would otherwise never show inside it.
    if (isNewDay(lastAt, author.createdAt)) return false;
    const sameWho = author.authorKind === 'assistant'
        ? group.agentId === author.agentId
        : group.authorUserId === author.authorUserId;
    return sameWho && Math.abs(timeOf(author.createdAt) - timeOf(lastAt)) <= GROUP_WINDOW_MS;
}

export interface ThreadSummary { count: number; lastAt: string }

/** The replies in each thread, by the id of the message that starts it. Deleted replies do not count. */
export function summarizeThreads(messages: TeamChatMessage[]): Map<string, ThreadSummary> {
    const out = new Map<string, ThreadSummary>();
    for (const m of messages) {
        if (!m.threadId || m.deleted) continue;
        const held = out.get(m.threadId);
        out.set(m.threadId, { count: (held?.count || 0) + 1, lastAt: m.createdAt });
    }
    return out;
}

/** The main conversation: what is not a reply inside a thread. */
export function mainConversation(messages: TeamChatMessage[], pending: PendingTeamChatMessage[]) {
    return { messages: messages.filter(m => !m.threadId), pending: pending.filter(p => !p.threadId) };
}

/** One thread: the message that starts it, then its replies. */
export function threadConversation(messages: TeamChatMessage[], pending: PendingTeamChatMessage[], threadId: string) {
    return {
        messages: messages.filter(m => m.id === threadId || m.threadId === threadId),
        pending: pending.filter(p => p.threadId === threadId),
    };
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

const dayKey = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

/** True when the two moments fall on different calendar days (unknown dates never split). */
export function isNewDay(previousIso: string, iso: string): boolean {
    const a = dayKey(previousIso);
    const b = dayKey(iso);
    return !!a && !!b && a !== b;
}

/** "Today", "Yesterday", or the date. */
export function formatDayLabel(iso: string, locale: string, labels: { today: string; yesterday: string }, now = new Date()): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    if (dayKey(iso) === dayKey(now.toISOString())) return labels.today;
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (dayKey(iso) === dayKey(yesterday.toISOString())) return labels.yesterday;
    const sameYear = d.getFullYear() === now.getFullYear();
    return d.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }) });
}
