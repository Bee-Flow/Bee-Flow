import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { apiClient } from '../client';
import { projectKeys } from './projects';
import type { TeamChatMessage, TeamChatMessages } from './projectChatTypes';

export const enc = encodeURIComponent;

export const PAGE = 50;

const SYNC_PAGE = 200;

/** Enough for any realistic gap; a longer one is picked up on the next event. */
const MAX_SYNC_ROUNDS = 5;

export const teamChatKeys = {
    lists: (projectId: string) => [...projectKeys.chats(projectId), 'list'] as const,
    list: (projectId: string, archived: boolean) => [...projectKeys.chats(projectId), 'list', archived] as const,
    detail: (projectId: string, chatId: string) => projectKeys.chat(projectId, chatId),
    messages: (projectId: string, chatId: string) => projectKeys.messages(projectId, chatId),
};

export const chatsPath = (projectId: string) => `/api/projects/${enc(projectId)}/chats`;

export const chatPath = (projectId: string, chatId: string) => `${chatsPath(projectId)}/${enc(chatId)}`;

export function mergeMessages(held: TeamChatMessage[], incoming: TeamChatMessage[]): TeamChatMessage[] {
    if (!incoming.length) return held;
    const byId = new Map(held.map(m => [m.id, m]));
    for (const m of incoming) byId.set(m.id, m);
    return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

export function newestSeq(messages: TeamChatMessage[]): number {
    return messages.length ? messages[messages.length - 1].seq : 0;
}

/** Fold server messages into a cache entry; a pending message the server
 *  echoes back (same clientMsgId) is confirmed and leaves the pending list. */
export function foldIn(data: TeamChatMessages | undefined, incoming: TeamChatMessage[], hasOlder?: boolean): TeamChatMessages {
    const base = data || { messages: [], pending: [], hasOlder: false };
    const echoed = new Set(incoming.map(m => m.clientMsgId).filter(Boolean));
    return {
        messages: mergeMessages(base.messages, incoming),
        pending: echoed.size ? base.pending.filter(p => !echoed.has(p.clientMsgId)) : base.pending,
        hasOlder: hasOlder ?? base.hasOlder,
    };
}

interface MessagePage { messages: TeamChatMessage[]; hasMore: boolean }

export async function fetchPage(projectId: string, chatId: string, query: Record<string, number>, signal?: AbortSignal): Promise<MessagePage> {
    const body = await apiClient.get<{ messages?: TeamChatMessage[]; hasMore?: boolean }>(
        `${chatPath(projectId, chatId)}/messages`, { signal, query },
    );
    return { messages: Array.isArray(body?.messages) ? body!.messages! : [], hasMore: !!body?.hasMore };
}

/** First load: the newest page. After that: everything after the newest held message. */
async function syncMessages(qc: QueryClient, projectId: string, chatId: string, signal?: AbortSignal): Promise<TeamChatMessages> {
    const key = teamChatKeys.messages(projectId, chatId);
    const held = qc.getQueryData<TeamChatMessages>(key);
    if (!held || !held.messages.length) {
        const page = await fetchPage(projectId, chatId, { limit: PAGE }, signal);
        // Merge into what the cache holds NOW: a message sent while this was
        // in flight must survive the answer.
        return foldIn(qc.getQueryData<TeamChatMessages>(key), page.messages, page.hasMore);
    }
    const fetched: TeamChatMessage[] = [];
    let after = newestSeq(held.messages);
    for (let round = 0; round < MAX_SYNC_ROUNDS; round++) {
        const page = await fetchPage(projectId, chatId, { after, limit: SYNC_PAGE }, signal);
        fetched.push(...page.messages);
        if (!page.hasMore || !page.messages.length) break;
        after = newestSeq(page.messages);
    }
    return foldIn(qc.getQueryData<TeamChatMessages>(key), fetched);
}

export function useTeamChatMessages(projectId: string, chatId: string | null | undefined) {
    const qc = useQueryClient();
    return useQuery<TeamChatMessages, Error>({
        queryKey: teamChatKeys.messages(projectId, chatId || ''),
        enabled: !!projectId && !!chatId,
        // Nothing marks this entry stale except a live event or a remount.
        staleTime: 30_000,
        // A safety net for a feed that fell back to polling and misses chat events.
        refetchInterval: 45_000,
        queryFn: ({ signal }) => syncMessages(qc, projectId, chatId!, signal),
    });
}
