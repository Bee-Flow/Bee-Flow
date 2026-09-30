// Team chats inside a collaborative project: the ONLY place that knows the
// /api/projects/:id/chats wire contract.
//
// Messages live in one cache entry per chat that only ever GROWS by merging:
// the project's live feed invalidates every `chats` key on each chat event,
// and a refetch that replaced the entry would throw away the older pages the
// reader scrolled back to and the messages still on their way to the server.
// So the query function syncs (newest page on first load, then only what came
// after the newest message held) and merges into what the cache holds at the
// moment the answer lands.

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { apiClient } from '../client';
import { projectRequest as write } from './projectErrors';
import { projectKeys, type ProjectRole } from './projects';

import type {
    CreateTeamChat, PendingTeamChatMessage, SendTeamChatMessage, TeamChat, TeamChatAiPolicy, TeamChatAiResult,
    TeamChatMessage, TeamChatMessages,
} from './projectChatTypes';

export type {
    CreateTeamChat, PendingTeamChatMessage, SendTeamChatMessage, TeamChat, TeamChatAiMode, TeamChatAiPolicy, TeamChatAiResult,
    TeamChatAiStatus, TeamChatAiTrigger, TeamChatAuthorKind, TeamChatLastMessage, TeamChatMessage, TeamChatMessages, TeamChatNotice,
} from './projectChatTypes';
export { isAutomaticAnswer } from './projectChatTypes';

const enc = encodeURIComponent;
const PAGE = 50;
const SYNC_PAGE = 200;
/** Enough for any realistic gap; a longer one is picked up on the next event. */
const MAX_SYNC_ROUNDS = 5;

export const teamChatKeys = {
    lists: (projectId: string) => [...projectKeys.chats(projectId), 'list'] as const,
    list: (projectId: string, archived: boolean) => [...projectKeys.chats(projectId), 'list', archived] as const,
    detail: (projectId: string, chatId: string) => projectKeys.chat(projectId, chatId),
    messages: (projectId: string, chatId: string) => projectKeys.messages(projectId, chatId),
};

const chatsPath = (projectId: string) => `/api/projects/${enc(projectId)}/chats`;
const chatPath = (projectId: string, chatId: string) => `${chatsPath(projectId)}/${enc(chatId)}`;

/** True when the chat has something the caller has not read. */
export function hasUnread(chat: Pick<TeamChat, 'unread'>): boolean {
    return typeof chat.unread === 'number' ? chat.unread > 0 : !!chat.unread;
}

/** A 64-character-or-shorter id the server uses to make a resend idempotent. */
export function newClientMsgId(): string {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

// ── Pure cache helpers (exported for tests) ─────────────────────────────────

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

function setPending(qc: QueryClient, key: readonly unknown[], clientMsgId: string,
    update: (list: PendingTeamChatMessage[]) => PendingTeamChatMessage[]) {
    qc.setQueryData<TeamChatMessages>(key, (prev) => {
        const base = prev || { messages: [], pending: [], hasOlder: false };
        return { ...base, pending: update(base.pending.slice()) };
    });
    return clientMsgId;
}

// ── Chats ───────────────────────────────────────────────────────────────────

export function useProjectChatsQuery(projectId: string | null | undefined, { archived = false, enabled = true } = {}) {
    return useQuery<{ chats: TeamChat[]; role: ProjectRole | null; aiPolicy: TeamChatAiPolicy | null }, Error>({
        queryKey: teamChatKeys.list(projectId || '', archived),
        enabled: enabled && !!projectId,
        queryFn: async ({ signal }) => {
            const body = await apiClient.get<{ chats?: TeamChat[]; role?: ProjectRole; aiPolicy?: TeamChatAiPolicy }>(chatsPath(projectId!), {
                signal, query: { archived: archived ? 1 : 0 },
            });
            return { chats: Array.isArray(body?.chats) ? body!.chats! : [], role: body?.role || null, aiPolicy: body?.aiPolicy || null };
        },
    });
}

/** The chat as the list already holds it, so the header paints at once. */
function chatFromLists(qc: QueryClient, projectId: string, chatId: string): TeamChat | undefined {
    for (const [, data] of qc.getQueriesData<{ chats: TeamChat[] }>({ queryKey: teamChatKeys.lists(projectId) })) {
        const hit = data?.chats?.find(c => c.id === chatId);
        if (hit) return hit;
    }
    return undefined;
}

export function useProjectChatQuery(projectId: string, chatId: string | null | undefined) {
    const qc = useQueryClient();
    return useQuery<TeamChat, Error>({
        queryKey: teamChatKeys.detail(projectId, chatId || ''),
        enabled: !!projectId && !!chatId,
        placeholderData: () => (chatId ? chatFromLists(qc, projectId, chatId) : undefined),
        queryFn: async ({ signal }) => {
            const body = await apiClient.get<{ chat?: TeamChat }>(chatPath(projectId, chatId!), { signal, retry: false });
            if (!body?.chat) throw new Error('Could not load the chat');
            return body.chat;
        },
    });
}

export function useCreateProjectChat(projectId: string) {
    const qc = useQueryClient();
    return useMutation<{ chat: TeamChat; message: TeamChatMessage | null; ai: TeamChatAiResult | null }, Error, CreateTeamChat>({
        mutationFn: async (vars) => {
            const body = { ...vars, message: vars.message?.trim() || undefined, title: vars.title?.trim() || undefined };
            const created = await write('Could not start the team chat', () => apiClient.post<{
                chat?: TeamChat; message?: TeamChatMessage | null; ai?: TeamChatAiResult;
            }>(chatsPath(projectId), body, { retry: false }));
            if (!created?.chat?.id) throw new Error('Could not start the team chat');
            return { chat: created.chat, message: created.message || null, ai: created.ai || null };
        },
        onSuccess: ({ chat, message }) => {
            qc.setQueryData(teamChatKeys.detail(projectId, chat.id), chat);
            if (message) qc.setQueryData(teamChatKeys.messages(projectId, chat.id), foldIn(undefined, [message], false));
            qc.invalidateQueries({ queryKey: teamChatKeys.lists(projectId) });
        },
    });
}

export type TeamChatPatch = Partial<Pick<TeamChat, 'title' | 'aiMode' | 'agentId' | 'archived'>>;

/** Rename, change the AI mode or agent, archive. The header shows the change
 *  at once and puts it back if the server refuses. */
export function useUpdateProjectChat(projectId: string, chatId: string) {
    const qc = useQueryClient();
    const key = teamChatKeys.detail(projectId, chatId);
    return useMutation<TeamChat, Error, TeamChatPatch, { previous?: TeamChat }>({
        mutationFn: async (patch) => {
            const body = await write('Could not update the chat',
                () => apiClient.patch<{ chat?: TeamChat }>(chatPath(projectId, chatId), patch, { retry: false }));
            if (!body?.chat) throw new Error('Could not update the chat');
            return body.chat;
        },
        onMutate: async (patch) => {
            await qc.cancelQueries({ queryKey: key, exact: true });
            const previous = qc.getQueryData<TeamChat>(key);
            // A mode can only be picked while the organisation allows it, so it is also how the chat acts.
            if (previous) qc.setQueryData<TeamChat>(key, { ...previous, ...patch, ...(patch.aiMode ? { effectiveAiMode: patch.aiMode } : {}) });
            return { previous };
        },
        onError: (_e, _patch, ctx) => {
            if (ctx?.previous) qc.setQueryData(key, ctx.previous);
        },
        onSuccess: (chat) => {
            qc.setQueryData(key, chat);
            qc.invalidateQueries({ queryKey: teamChatKeys.lists(projectId) });
        },
    });
}

export function useDeleteProjectChat(projectId: string) {
    const qc = useQueryClient();
    return useMutation<void, Error, string>({
        mutationFn: async (chatId) => {
            await write('Could not delete the chat', () => apiClient.delete(chatPath(projectId, chatId), { retry: false }));
        },
        onSuccess: (_r, chatId) => {
            qc.removeQueries({ queryKey: teamChatKeys.detail(projectId, chatId) });
            qc.invalidateQueries({ queryKey: teamChatKeys.lists(projectId) });
        },
    });
}

// ── Messages ────────────────────────────────────────────────────────────────

interface MessagePage { messages: TeamChatMessage[]; hasMore: boolean }

async function fetchPage(projectId: string, chatId: string, query: Record<string, number>, signal?: AbortSignal): Promise<MessagePage> {
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

/** Page further back than the oldest message held. */
export function useLoadOlderMessages(projectId: string, chatId: string) {
    const qc = useQueryClient();
    const key = teamChatKeys.messages(projectId, chatId);
    return useMutation<void, Error, void>({
        mutationFn: async () => {
            const held = qc.getQueryData<TeamChatMessages>(key);
            const oldest = held?.messages[0]?.seq;
            if (!oldest) return;
            const page = await fetchPage(projectId, chatId, { before: oldest, limit: PAGE });
            qc.setQueryData<TeamChatMessages>(key, prev => foldIn(prev, page.messages, page.hasMore));
        },
    });
}

/** Re-read one message someone edited or deleted (`seq` known), else the newest page. */
export async function refreshTeamChatMessage(qc: QueryClient, projectId: string, chatId: string, seq?: number | null) {
    const query: Record<string, number> = typeof seq === 'number' && seq > 0 ? { after: seq - 1, limit: 1 } : { limit: PAGE };
    const page = await fetchPage(projectId, chatId, query);
    qc.setQueryData<TeamChatMessages>(teamChatKeys.messages(projectId, chatId), prev => foldIn(prev, page.messages));
}

export interface SendResult { message: TeamChatMessage; ai: TeamChatAiResult }

/** Post a message. It shows at once as pending; a refusal keeps it on screen
 *  as "not sent" so the author can resend it (same clientMsgId, so a request
 *  that did land is not stored twice) or throw it away. */
export function useSendTeamChatMessage(projectId: string, chatId: string, currentUserId: string | null) {
    const qc = useQueryClient();
    const key = teamChatKeys.messages(projectId, chatId);
    return useMutation<SendResult, Error, SendTeamChatMessage>({
        mutationFn: async (vars) => {
            // One automatic retry is safe: the server stores a clientMsgId once.
            const body = await write('Could not send the message', () => apiClient.post<{
                message?: TeamChatMessage; ai?: TeamChatAiResult;
            }>(`${chatPath(projectId, chatId)}/messages`, vars, { retry: { attempts: 1 } }));
            if (!body?.message) throw new Error('Could not send the message');
            return { message: body.message, ai: body.ai || { status: 'skipped' } };
        },
        onMutate: (vars) => setPending(qc, key, vars.clientMsgId, (list) => {
            const entry: PendingTeamChatMessage = {
                ...vars, authorUserId: currentUserId, createdAt: new Date().toISOString(), status: 'sending',
            };
            const at = list.findIndex(p => p.clientMsgId === vars.clientMsgId);
            if (at >= 0) list[at] = { ...list[at], status: 'sending', error: undefined };
            else list.push(entry);
            return list;
        }),
        onError: (e, vars) => setPending(qc, key, vars.clientMsgId, list => list.map(p => (
            p.clientMsgId === vars.clientMsgId ? { ...p, status: 'failed', error: e.message, errorCode: (e as { code?: string | null }).code ?? null } : p))),
        onSuccess: ({ message }, vars) => {
            qc.setQueryData<TeamChatMessages>(key, (prev) => {
                const next = foldIn(prev, [message]);
                return { ...next, pending: next.pending.filter(p => p.clientMsgId !== vars.clientMsgId) };
            });
            qc.invalidateQueries({ queryKey: teamChatKeys.lists(projectId) });
        },
    });
}

/** Drop a message that was not sent. */
export function discardPendingMessage(qc: QueryClient, projectId: string, chatId: string, clientMsgId: string) {
    setPending(qc, teamChatKeys.messages(projectId, chatId), clientMsgId, list => list.filter(p => p.clientMsgId !== clientMsgId));
}

export function useEditTeamChatMessage(projectId: string, chatId: string) {
    const qc = useQueryClient();
    return useMutation<void, Error, { messageId: string; content: string }>({
        mutationFn: async ({ messageId, content }) => {
            const body = await write('Could not edit the message', () => apiClient.patch<{ message?: TeamChatMessage }>(
                `${chatPath(projectId, chatId)}/messages/${enc(messageId)}`, { content }, { retry: false }));
            if (body?.message) qc.setQueryData<TeamChatMessages>(teamChatKeys.messages(projectId, chatId), prev => foldIn(prev, [body!.message!]));
            else await qc.invalidateQueries({ queryKey: teamChatKeys.messages(projectId, chatId) });
        },
    });
}

export function useDeleteTeamChatMessage(projectId: string, chatId: string) {
    const qc = useQueryClient();
    const key = teamChatKeys.messages(projectId, chatId);
    return useMutation<void, Error, string>({
        mutationFn: async (messageId) => {
            await write('Could not delete the message',
                () => apiClient.delete(`${chatPath(projectId, chatId)}/messages/${enc(messageId)}`, { retry: false }));
        },
        onSuccess: (_r, messageId) => {
            qc.setQueryData<TeamChatMessages>(key, prev => (prev ? {
                ...prev,
                messages: prev.messages.map(m => (m.id === messageId ? { ...m, content: '', deleted: true } : m)),
            } : prev));
        },
    });
}

/** Tell the server how far the caller has read. Failures are silent: the
 *  unread dot is a courtesy, and the next read catches up. */
export function useMarkTeamChatRead(projectId: string, chatId: string) {
    const qc = useQueryClient();
    return useMutation<void, Error, number>({
        mutationFn: async (seq) => {
            await apiClient.post(`${chatPath(projectId, chatId)}/read`, { seq }, { retry: false });
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: teamChatKeys.lists(projectId) }),
    });
}

/** "Not helpful" (or helpful) on an answer the AI gave on its own. Two "not
 *  helpful" in a day pause the AI joining by itself in that chat. */
export function useTeamChatFeedback(projectId: string, chatId: string) {
    const qc = useQueryClient();
    return useMutation<{ autoPausedUntil: string | null }, Error, { messageId: string; helpful: boolean }>({
        mutationFn: async ({ messageId, helpful }) => {
            const body = await write('Could not send your feedback', () => apiClient.post<{ autoPausedUntil?: string | null }>(
                `${chatPath(projectId, chatId)}/messages/${enc(messageId)}/feedback`, { helpful }, { retry: false }));
            return { autoPausedUntil: body?.autoPausedUntil ?? null };
        },
        onSuccess: ({ autoPausedUntil }, { messageId, helpful }) => {
            qc.setQueryData<TeamChatMessages>(teamChatKeys.messages(projectId, chatId), prev => (prev ? {
                ...prev,
                messages: prev.messages.map(m => (m.id === messageId ? { ...m, myFeedback: helpful ? 'helpful' : 'not_helpful' } : m)),
            } : prev));
            qc.setQueryData<TeamChat>(teamChatKeys.detail(projectId, chatId), prev => (prev ? { ...prev, autoPausedUntil } : prev));
        },
    });
}

/** What the organisation lets this project's chats choose; null while unknown. */
export function useTeamChatAiPolicy(projectId: string): TeamChatAiPolicy | null {
    return useProjectChatsQuery(projectId).data?.aiPolicy ?? null;
}
