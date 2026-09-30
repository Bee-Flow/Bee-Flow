/**
 * The drawer's chat list, grouped the web Sidebar's way: Pinned, then Today,
 * Yesterday, Last 30 days and Older by calendar day (not by 24-hour blocks —
 * a chat from 23:50 last night is "Yesterday" at 00:10), empty groups dropped.
 * Pure, with the clock passed in, so the boundaries are tested rather than
 * trusted. (The full /chats screen keeps its own finer buckets.)
 */

export interface ChatLike {
    id: string;
    pinned?: boolean;
    updated_at?: string | null;
    created_at?: string | null;
}

export type ChatGroupId = 'pinned' | 'today' | 'yesterday' | 'month' | 'older';

export interface ChatGroup<C extends ChatLike> {
    id: ChatGroupId;
    data: C[];
}

const ORDER: readonly ChatGroupId[] = ['pinned', 'today', 'yesterday', 'month', 'older'];
const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(ms: number): number {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function groupOf(chat: ChatLike, todayStart: number): ChatGroupId {
    if (chat.pinned) return 'pinned';
    const raw = chat.updated_at || chat.created_at;
    const at = raw ? Date.parse(raw) : 0;
    const days = Math.floor((todayStart - startOfDay(Number.isFinite(at) ? at : 0)) / DAY_MS);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days <= 30) return 'month';
    return 'older';
}

export function groupChats<C extends ChatLike>(chats: readonly C[], now = Date.now()): ChatGroup<C>[] {
    const todayStart = startOfDay(now);
    const byGroup = new Map<ChatGroupId, C[]>(ORDER.map((id) => [id, []]));
    for (const chat of chats) byGroup.get(groupOf(chat, todayStart))?.push(chat);
    return ORDER.map((id) => ({ id, data: byGroup.get(id) ?? [] })).filter((g) => g.data.length > 0);
}
