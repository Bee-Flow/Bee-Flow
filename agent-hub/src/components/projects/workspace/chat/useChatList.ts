// The Chats tab's one list, merged from three sources: the project's team
// chats, the AI chats members shared into it, and the caller's own AI chats
// filed in it that are still private. A chat of mine that I shared appears
// once, as shared. Each source keeps its own status: one that failed to load
// must say so, never read as "nothing here".

import { useMemo } from 'react';
import { useProjectChatsQuery, type TeamChat } from '../../../../api/queries/projectChats';
import {
    useMyProjectChatsQuery, useProjectThreadsQuery, type MyProjectChat, type ProjectThread,
} from '../../../../api/queries/projects';

export type ChatListFilter = 'all' | 'team' | 'ai';

export type ChatListItem =
    | { kind: 'team'; key: string; id: string; title: string; at: string; chat: TeamChat }
    | {
        kind: 'ai'; key: string; id: string; title: string; at: string;
        type: 'direct' | 'agent'; agentId: string | null; ownerId: string | null; shared: boolean; mine: boolean;
    };

const timeOf = (iso: string) => {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? 0 : t;
};

export function mergeChatItems(team: TeamChat[], threads: ProjectThread[], mine: MyProjectChat[], me: string | null): ChatListItem[] {
    const items: ChatListItem[] = team.map(chat => ({
        kind: 'team', key: `team:${chat.id}`, id: chat.id, title: chat.title, at: chat.lastMessageAt || chat.updatedAt || chat.createdAt || '', chat,
    }));
    const seen = new Set<string>();
    for (const th of threads) {
        seen.add(`${th.type}:${th.id}`);
        items.push({
            kind: 'ai', key: `ai:${th.type}:${th.id}`, id: th.id, title: th.title || '', at: th.updatedAt || th.createdAt || '',
            type: th.type, agentId: th.agentId || null, ownerId: th.ownerId, shared: true, mine: !!me && th.ownerId === me,
        });
    }
    for (const c of mine) {
        if (seen.has(`${c.type}:${c.id}`)) continue;
        items.push({
            kind: 'ai', key: `ai:${c.type}:${c.id}`, id: c.id, title: c.title || '', at: c.updatedAt || '',
            type: c.type, agentId: c.agentId || null, ownerId: me, shared: !!c.shared, mine: true,
        });
    }
    return items.sort((a, b) => timeOf(b.at) - timeOf(a.at));
}

export function filterChatItems(items: ChatListItem[], filter: ChatListFilter): ChatListItem[] {
    if (filter === 'all') return items;
    return items.filter(i => (filter === 'team' ? i.kind === 'team' : i.kind === 'ai'));
}

export function useChatList(projectId: string, me: string | null, showArchived: boolean) {
    const team = useProjectChatsQuery(projectId);
    const archived = useProjectChatsQuery(projectId, { archived: true, enabled: showArchived });
    const threads = useProjectThreadsQuery(projectId);
    const mine = useMyProjectChatsQuery(projectId);
    const items = useMemo(
        () => mergeChatItems(team.data?.chats || [], threads.data || [], mine.data || [], me),
        [team.data, threads.data, mine.data, me],
    );
    const archivedItems = useMemo(() => mergeChatItems(archived.data?.chats || [], [], [], me), [archived.data, me]);
    return {
        items,
        archivedItems,
        sources: { team, threads, mine, archived },
        /** Nothing has arrived yet. */
        loading: team.isPending && threads.isPending && mine.isPending,
        /** Every source answered, one way or the other. */
        settled: !team.isPending && !threads.isPending && !mine.isPending,
        /** At least one source could not be read: the list is not the whole picture. */
        failed: team.isError || threads.isError || mine.isError,
    };
}
